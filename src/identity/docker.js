// Docker neuron interop: wallet.yaml, vault.yaml, nostr.yaml, words, WIF.
// Vault fields: base64(salt16 || iv16 || AES-256-CBC(PKCS7(utf8))) with key
// PBKDF2-HMAC-SHA1(password, salt, 1e6, 32) (satorilib utils/secret.py).
// Design: docs/design/identity.md#import-and-export-docker-interop
import { load, dump } from 'js-yaml';
import { base64 } from '@scure/base';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { deriveKeys, entropyFromWif, entropyFromWords, nostrKeys } from './keys.js';

const DOCKER_ITERATIONS = 1_000_000;
const subtle = globalThis.crypto.subtle;

async function cbcKey(password, salt) {
  const base = await subtle.importKey('raw', utf8ToBytes(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-1', salt, iterations: DOCKER_ITERATIONS },
    base, { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Decrypt one Docker vault field. Throws on a wrong password (bad padding). */
export async function decryptField(field, password) {
  const b = base64.decode(field);
  const key = await cbcKey(password, b.slice(0, 16));
  const pt = await subtle.decrypt({ name: 'AES-CBC', iv: b.slice(16, 32) }, key, b.slice(32));
  return new TextDecoder('utf-8', { fatal: true }).decode(pt);
}

/** Encrypt one field the way Docker does. */
export async function encryptField(value, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = await subtle.encrypt({ name: 'AES-CBC', iv }, await cbcKey(password, salt), utf8ToBytes(value));
  return base64.encode(concatBytes(salt, iv, new Uint8Array(ct)));
}

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * Import a Docker wallet.yaml or vault.yaml. Load order as satorilib
 * (wallet/identity.py loadFromYaml): entropy → 52-char WIF → watch-only (refused).
 * Everything is re-derived and compared with the file's stored values.
 * @param {string} text
 * @param {{password?: string}} [opts]
 * @returns {Promise<{entropy: Uint8Array, keys: ReturnType<typeof deriveKeys>, mismatches: string[]}>}
 */
export async function importDockerWallet(text, { password } = {}) {
  const doc = load(text) ?? {};
  const evr = doc.evr ?? {};
  const need = () => {
    if (typeof password !== 'string') throw new Error('This file is encrypted: enter its password');
  };
  const open = async (v) => {
    need();
    try { return await decryptField(v, password); } catch { throw new Error('Wrong password'); }
  };

  let entropy;
  let ent = str(doc.entropy);
  if (ent && ent.length !== 44) ent = await open(ent);
  if (ent.length === 44) entropy = base64.decode(ent);
  else {
    let wif = str(doc.privateKey);
    if (wif && wif.length !== 52) wif = await open(wif);
    if (wif.length !== 52) throw new Error('No private key in this file (watch-only)');
    entropy = entropyFromWif(wif);
  }
  const keys = deriveKeys(entropy);

  // Older vaults also encrypted these; satorilib decides by length (identity.py:666-676).
  const legacy = async (v, encrypted) => (v && encrypted && typeof password === 'string' ? decryptField(v, password) : v);
  const [publicKey, scripthash, address] = await Promise.all([
    legacy(str(doc.publicKey), str(doc.publicKey).length !== 66),
    legacy(str(doc.scripthash), str(doc.scripthash).length !== 64),
    legacy(str(evr.address), str(evr.address).length > 34),
  ]);
  const privateKey = str(doc.privateKey).length === 52 ? doc.privateKey : '';
  const words = str(doc.words).includes(' ') ? doc.words : '';
  const stored = { privateKey, publicKey, scripthash, 'evr.address': address, words };
  const derived = { privateKey: keys.wif, publicKey: keys.pubkey, scripthash: keys.scripthash, 'evr.address': keys.address, words: keys.words };
  const mismatches = Object.keys(stored).filter((k) => stored[k] && stored[k] !== derived[k]);
  return { entropy, keys, mismatches };
}

/**
 * Write a Docker wallet.yaml (no password) or vault.yaml (password): entropy,
 * privateKey and words encrypted, the rest plaintext, as satorilib's save().
 */
export async function exportDockerWallet(entropy, { password } = {}) {
  const k = deriveKeys(entropy);
  const secret = { entropy: k.entropy, privateKey: k.wif, words: k.words };
  if (typeof password === 'string') {
    for (const f of Object.keys(secret)) secret[f] = await encryptField(secret[f], password);
  }
  return dump({ ...secret, publicKey: k.pubkey, scripthash: k.scripthash, evr: { address: k.address } },
    { sortKeys: true, lineWidth: -1 });
}

/** nostr.yaml → keys; the stored pubkey must match the secret. */
export function importNostrYaml(text) {
  const doc = load(text) ?? {};
  const keys = nostrKeys(str(doc.secret_hex));
  if (doc.pubkey_hex != null && String(doc.pubkey_hex).toLowerCase() !== keys.pubkeyHex) {
    throw new Error('nostr.yaml pubkey does not match its secret');
  }
  return keys;
}

/** nostr.yaml as Docker writes it (start.py _initNostrKeys). */
export function exportNostrYaml(secretHex) {
  const k = nostrKeys(secretHex);
  return dump({ pubkey_hex: k.pubkeyHex, secret_hex: k.secretHex }, { sortKeys: true, lineWidth: -1 });
}

/** 24 words or a WIF typed or pasted by the user → entropy. */
export function importSecret(text) {
  const t = text.trim();
  return /\s/.test(t) ? entropyFromWords(t) : entropyFromWif(t);
}
