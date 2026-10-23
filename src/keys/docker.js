// Docker's files, read only, to translate them into this app's own record
// (docs/design/keys.md#import-translate): the Dockerized Neuron's wallet.yaml,
// vault.yaml and nostr.yaml at import, and the same texts this app's earlier
// versions stored, at the forward migration. Nothing is ever written in them.
//
// satorilib's wallet field: base64(salt16 ‖ iv16 ‖ AES-256-CBC(PKCS7(utf8))), key =
// PBKDF2-HMAC-SHA1(latin1(password), salt, 1e6, 32) (satorilib utils/secret.py;
// pycryptodome turns a str password into bytes as Latin-1).
import { load } from 'js-yaml';
import { base64 } from '@scure/base';
import { checkKey, publicKey, wordsOf } from './keys.js';
import { nostrPubkey } from '../nostr/event.js';

const ITERATIONS = 1_000_000;
const SECRET_FIELDS = ['entropy', 'privateKey', 'words']; // what satorilib encrypts today (identity.py:682-692)
const subtle = globalThis.crypto.subtle;

/**
 * A password's bytes: 'latin1', one byte per character, as pycryptodome takes a
 * str (null when a character is outside Latin-1); or 'utf8', as this app's
 * wallets of 2026-10-15 06:29-14:04 took it.
 */
function passwordBytes(password, encoding) {
  if (encoding === 'utf8') return new TextEncoder().encode(password);
  return /[^\x00-\xff]/.test(password) ? null : Uint8Array.from(password, (c) => c.charCodeAt(0));
}

async function cbcKey(bytes, salt) {
  const base = await subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-1', salt, iterations: ITERATIONS },
    base, { name: 'AES-CBC', length: 256 }, false, ['decrypt']);
}

/** Decrypt one wallet field. Throws on a wrong password (bad padding or not UTF-8). */
export async function decryptField(field, password, encoding = 'latin1') {
  const bytes = passwordBytes(password, encoding);
  if (!bytes) throw new Error('Not a Latin-1 password');
  const b = base64.decode(field);
  let key;
  try {
    key = await cbcKey(bytes, b.slice(0, 16));
  } finally {
    bytes.fill(0); // the password's bytes, once WebCrypto has its copy
  }
  const pt = await subtle.decrypt({ name: 'AES-CBC', iv: b.slice(16, 32) }, key, b.slice(32));
  return new TextDecoder('utf-8', { fatal: true }).decode(pt);
}

const str = (v) => (typeof v === 'string' ? v : '');
const wrong = () => new Error('Wrong passphrase');
const PUBKEY = /^0[23][0-9a-f]{64}$/;

/**
 * The yaml as a plain object; {} for an empty file. A file that is not YAML says only where: js-yaml's own message
 * quotes the lines around the fault, and a wallet's lines are its secrets (the security review, 2026-10-19).
 */
export function parse(text) {
  let doc;
  try {
    doc = String(text ?? '').trim() ? load(text) : {};
  } catch (err) {
    throw new Error(`not valid YAML (line ${Number.isInteger(err?.mark?.line) ? err.mark.line + 1 : '?'})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a key file');
  return doc;
}

/**
 * Which kind of file this is, by its secret fields (entropy, privateKey,
 * words), read with satorilib's rules: a 44-char entropy, a 52-char WIF and
 * words with spaces are plain text (identity.py:131,152,595). 'plain' (a
 * wallet.yaml), 'encrypted' (a vault.yaml), 'mixed', or '' (no key).
 */
export function secrecy(text) {
  const doc = parse(text);
  const plain = { entropy: (v) => v.length === 44, privateKey: (v) => v.length === 52, words: (v) => v.includes(' ') };
  const kinds = new Set(SECRET_FIELDS.filter((f) => str(doc[f])).map((f) => (plain[f](str(doc[f])) ? 'plain' : 'encrypted')));
  return kinds.size > 1 ? 'mixed' : [...kinds][0] ?? '';
}

/** A vault.yaml's public key in plain text (read while locked), or null. */
export function walletPubkey(text) {
  const p = parse(text).publicKey;
  return typeof p === 'string' && PUBKEY.test(p) ? p : null;
}

/**
 * Read a wallet.yaml (no password: its key must be plain text) or a vault.yaml
 * (password: its key must be encrypted). The key is the entropy, which every
 * file satorilib writes has (identity.py loadFromYaml); a file without one is
 * refused (watch-only; satorilib cannot load a WIF-only file either). An old
 * wallet also encrypted its publicKey (identity.py:666-676, by length). The
 * public key and the words are derived from the secret and compared with the
 * stored ones; the other fields (privateKey's WIF, the nested address,
 * scripthash) are not read. `encodings`: the password's byte forms to try, in order.
 * @returns {Promise<{secret: Uint8Array, pubkey: string, mismatches: string[]}>}
 */
export async function readKeyFile(text, { password, encodings = ['latin1'] } = {}) {
  const doc = parse(text);
  const kind = secrecy(text);
  if (typeof password === 'string' && (kind === 'plain' || kind === 'mixed')) throw new Error('This file is not encrypted');
  if (typeof password !== 'string' && (kind === 'encrypted' || kind === 'mixed')) throw new Error('This file is encrypted: it needs its passphrase');
  let encoding = null; // the one that opened the first secret field
  const open = async (v, expectLength) => {
    const ascii = !/[^\x00-\x7f]/.test(password);
    for (const e of encoding ? [encoding] : encodings.filter((x, i) => !(ascii && i > 0 && x === 'utf8'))) {
      try {
        const out = await decryptField(v, password, e);
        if (out.length === expectLength) {
          encoding = e;
          return out;
        }
      } catch { /* the next encoding */ }
    }
    throw wrong();
  };

  let ent = str(doc.entropy);
  if (!ent) throw new Error('No entropy in this file, so no key to import (watch-only)');
  if (ent.length !== 44) ent = await open(ent, 44);
  let secret;
  try { secret = checkKey(base64.decode(ent)); } catch { throw wrong(); }
  const pubkey = publicKey(secret);

  let storedPub = str(doc.publicKey);
  if (storedPub && storedPub.length !== 66 && typeof password === 'string') {
    storedPub = await decryptField(storedPub, password, encoding ?? encodings[0]).catch(() => storedPub);
  }
  const stored = { publicKey: storedPub, words: str(doc.words).includes(' ') ? doc.words : '' };
  const derived = { publicKey: pubkey, words: wordsOf(secret) };
  const mismatches = Object.keys(stored).filter((k) => stored[k] && stored[k] !== derived[k]);
  return { secret, pubkey, mismatches };
}

/**
 * nostr.yaml → { secret, pubkey } (hex). Lite's _initNostrKeys writes
 * {pubkey_hex, secret_hex} (start.py:120-149); a pubkey_hex that is not the
 * secret's is refused.
 */
export function readNostrYaml(text) {
  const doc = parse(text);
  const secret = str(doc.secret_hex).trim().toLowerCase();
  let pubkey;
  try {
    pubkey = nostrPubkey(secret);
  } catch {
    throw new Error('nostr.yaml: no valid secret_hex (64 hex characters)');
  }
  if (doc.pubkey_hex != null && String(doc.pubkey_hex).trim().toLowerCase() !== pubkey) {
    throw new Error('nostr.yaml: pubkey_hex does not match its secret_hex');
  }
  return { secret, pubkey };
}
