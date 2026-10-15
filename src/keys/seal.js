// Seal bytes with a passphrase: WebCrypto PBKDF2-SHA256 → AES-256-GCM.
// The record is plain JSON (base64 fields) with its parameters, so it can be
// stored as text and opened later even if the defaults change.
import { base64 } from '@scure/base';

export const ITERATIONS = 600_000;
const subtle = globalThis.crypto.subtle;
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function passKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** @param {Uint8Array} bytes @param {string} passphrase */
export async function seal(bytes, passphrase, { iterations = ITERATIONS } = {}) {
  const salt = rand(16);
  const iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(passphrase, salt, iterations), bytes));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, cipher: 'AES-256-GCM',
    salt: base64.encode(salt), iv: base64.encode(iv), ct: base64.encode(ct) };
}

/** @returns {Promise<Uint8Array>} throws 'Wrong passphrase' */
export async function unseal(rec, passphrase) {
  const key = await passKey(passphrase, base64.decode(rec.salt), rec.iterations);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: base64.decode(rec.iv) }, key, base64.decode(rec.ct)));
  } catch {
    throw new Error('Wrong passphrase');
  }
}
