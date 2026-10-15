// The browser's own at-rest format: WebCrypto PBKDF2-SHA256 → AES-256-GCM,
// parameters stored with the ciphertext; plus the opt-in "remember on this
// device" wrap with a non-extractable AES-GCM CryptoKey.
// Records are plain objects of Uint8Arrays (structured-clonable into IndexedDB).
// Design: docs/design/identity.md#at-rest
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
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, cipher: 'AES-256-GCM', salt, iv, ct };
}

/** @returns {Promise<Uint8Array>} throws 'Wrong passphrase' */
export async function unseal(rec, passphrase) {
  const key = await passKey(passphrase, rec.salt, rec.iterations);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct));
  } catch {
    throw new Error('Wrong passphrase');
  }
}

/** Non-extractable device key: usable on this origin, never readable as bytes. */
export function makeDeviceKey() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function wrapWithDevice(bytes, key) {
  const iv = rand(12);
  return { v: 1, cipher: 'AES-256-GCM', iv, ct: new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
}

export async function unwrapWithDevice(rec, key) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct));
}
