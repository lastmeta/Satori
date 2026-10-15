// Docker's wallet.yaml / vault.yaml, read and written as satorilib does.
// A vault field is base64(salt16 ‖ iv16 ‖ AES-256-CBC(PKCS7(utf8))), key =
// PBKDF2-HMAC-SHA1(password, salt, 1e6, 32) (satorilib utils/secret.py).
// Design and evidence: docs/design/keys.md#the-files
import { load, dump } from 'js-yaml';
import { base64 } from '@scure/base';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { deriveKeys, entropyFromWif } from './keys.js';

const ITERATIONS = 1_000_000;
const ENCRYPTED = ['entropy', 'privateKey', 'words']; // what satorilib encrypts today (identity.py:682-692)
const subtle = globalThis.crypto.subtle;

async function cbcKey(password, salt) {
  const base = await subtle.importKey('raw', utf8ToBytes(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-1', salt, iterations: ITERATIONS },
    base, { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Decrypt one vault field. Throws on a wrong password (bad padding or not UTF-8). */
export async function decryptField(field, password) {
  const b = base64.decode(field);
  const key = await cbcKey(password, b.slice(0, 16));
  const pt = await subtle.decrypt({ name: 'AES-CBC', iv: b.slice(16, 32) }, key, b.slice(32));
  return new TextDecoder('utf-8', { fatal: true }).decode(pt);
}

/** Encrypt one vault field the way satorilib does. */
export async function encryptField(value, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = await subtle.encrypt({ name: 'AES-CBC', iv }, await cbcKey(password, salt), utf8ToBytes(value));
  return base64.encode(concatBytes(salt, iv, new Uint8Array(ct)));
}

const str = (v) => (typeof v === 'string' ? v : '');
const wrong = () => new Error('Wrong passphrase');

/** The yaml as a plain object; {} for an empty file. */
export function parse(text) {
  const doc = String(text ?? '').trim() ? load(text) : {};
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a wallet file');
  return doc;
}

/**
 * Read a wallet.yaml or vault.yaml. Load order as satorilib (identity.py
 * loadFromYaml): entropy → 52-char WIF → watch-only (refused: no key). Older
 * vaults also encrypted publicKey, scripthash and evr.address; they are
 * decrypted by the same length rule (identity.py:666-676). Everything is
 * derived from the entropy and compared with the stored values.
 * @returns {Promise<{entropy: Uint8Array, keys: ReturnType<typeof deriveKeys>, mismatches: string[]}>}
 */
export async function readWallet(text, { password } = {}) {
  const doc = parse(text);
  const evr = doc.evr ?? {};
  const open = async (v, expectLength) => {
    if (typeof password !== 'string') throw new Error('This file is encrypted: it needs its passphrase');
    let out;
    try { out = await decryptField(v, password); } catch { throw wrong(); }
    if (out.length !== expectLength) throw wrong();
    return out;
  };

  let entropy;
  let ent = str(doc.entropy);
  if (ent && ent.length !== 44) ent = await open(ent, 44);
  if (ent) {
    try { entropy = base64.decode(ent); } catch { throw wrong(); }
  } else {
    let wif = str(doc.privateKey);
    if (wif && wif.length !== 52) wif = await open(wif, 52);
    if (!wif) throw new Error('No private key in this file (watch-only)');
    entropy = entropyFromWif(wif);
  }
  const keys = deriveKeys(entropy);

  const legacy = (v, encrypted) => (v && encrypted && typeof password === 'string' ? decryptField(v, password).catch(() => v) : v);
  const [publicKey, scripthash, address] = await Promise.all([
    legacy(str(doc.publicKey), str(doc.publicKey).length !== 66),
    legacy(str(doc.scripthash), str(doc.scripthash).length !== 64),
    legacy(str(evr.address), str(evr.address).length > 34),
  ]);
  const stored = {
    privateKey: str(doc.privateKey).length === 52 ? doc.privateKey : '',
    publicKey, scripthash, 'evr.address': address,
    words: str(doc.words).includes(' ') ? doc.words : '',
  };
  const derived = { privateKey: keys.wif, publicKey: keys.pubkey, scripthash: keys.scripthash, 'evr.address': keys.address, words: keys.words };
  const mismatches = Object.keys(stored).filter((k) => stored[k] && stored[k] !== derived[k]);
  return { entropy, keys, mismatches };
}

/**
 * wallet.yaml (no password) or vault.yaml (password) as satorilib's save()
 * writes it: entropy, privateKey and words encrypted, the rest plaintext.
 * @returns {Promise<string>}
 */
export async function writeWallet(entropy, { password } = {}) {
  const k = deriveKeys(entropy);
  const secret = { entropy: k.entropy, privateKey: k.wif, words: k.words };
  if (typeof password === 'string') {
    await Promise.all(ENCRYPTED.map(async (f) => { secret[f] = await encryptField(secret[f], password); }));
  }
  return dump({ ...secret, publicKey: k.pubkey, scripthash: k.scripthash, evr: { address: k.address } },
    { sortKeys: true, lineWidth: -1 });
}
