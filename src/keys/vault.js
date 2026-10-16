// The vault's encryption: PBKDF2-HMAC-SHA256 → AES-256-GCM over the 32-byte
// secret, all WebCrypto. The passphrase is any Unicode, taken as the UTF-8
// bytes of its NFC form. Each record holds its own parameters, so a later
// iteration count still opens it. Why these: docs/design/keys.md#the-vault-encryption
//
//   const sealed = await sealSecret(secret, passphrase)   // { kdf, cipher, data }
//   const secret = await openSecret(sealed, passphrase)   // throws 'Wrong passphrase' (GCM's tag)
import { base64 } from '@scure/base';

export const ITERATIONS = 600_000; // OWASP's PBKDF2-HMAC-SHA256 figure (Password Storage Cheat Sheet)
export const MIN_PASSPHRASE = 8; // characters (code points after NFC), for new passphrases
const subtle = globalThis.crypto.subtle;

const nfc = (p) => String(p).normalize('NFC');
const length = (p) => [...nfc(p)].length;

/** Whether a new passphrase is long enough. */
export const passphraseOk = (p) => typeof p === 'string' && length(p) >= MIN_PASSPHRASE;

/** A new passphrase's rule: at least 8 characters, any Unicode, no other rule. */
export function checkNewPassphrase(p) {
  if (typeof p !== 'string') throw new Error('No passphrase given.');
  if (!passphraseOk(p)) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
}

async function aesKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(nfc(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a secret with a passphrase: a fresh 16-byte salt and 12-byte IV. */
export async function sealSecret(secret, passphrase, { iterations = ITERATIONS } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(passphrase, salt, iterations), secret);
  return {
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: base64.encode(salt) },
    cipher: { name: 'AES-GCM', iv: base64.encode(iv) },
    data: base64.encode(new Uint8Array(data)),
  };
}

/** Decrypt a sealed secret. A wrong passphrase (or a changed byte) fails GCM's tag: 'Wrong passphrase'. */
export async function openSecret(sealed, passphrase) {
  const { kdf, cipher, data } = sealed ?? {};
  if (kdf?.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !(Number.isSafeInteger(kdf.iterations) && kdf.iterations > 0)
    || cipher?.name !== 'AES-GCM' || typeof data !== 'string') {
    throw new Error('Unknown vault format: this vault was stored by another version of the app.');
  }
  const key = await aesKey(passphrase, base64.decode(kdf.salt), kdf.iterations);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: base64.decode(cipher.iv) }, key, base64.decode(data)));
  } catch {
    throw new Error('Wrong passphrase');
  }
}
