// NIP-04, as satorilib encrypts a paid stream's observations and its payments (satori_nostr/encryption.py: nostr-sdk's
// nip04_encrypt / nip04_decrypt; Satori Lite has no NIP-44): AES-256-CBC (PKCS#7) under the x coordinate of the
// secp256k1 shared point, sent as base64(ciphertext) + '?iv=' + base64(iv). WebCrypto and @noble/curves: no new
// dependency (docs/design/market.md#selling-and-buying-over-the-relays).
import { secp256k1 } from '@noble/curves/secp256k1';
import { base64 } from '@scure/base';
import { utf8ToBytes } from '@noble/hashes/utils';

/** The AES key both sides share: the shared point's x (unhashed, as NIP-04), from our secret and their x-only pubkey. */
const keyOf = (secretHex, pubkeyHex) => crypto.subtle.importKey('raw', secp256k1.getSharedSecret(secretHex, `02${pubkeyHex}`).slice(1, 33),
  { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);

/** `text` for `pubkeyHex` (64 hex, x-only) from `secretHex`; `iv` 16 random bytes unless given (tests). */
export async function nip04Encrypt(secretHex, pubkeyHex, text, iv = crypto.getRandomValues(new Uint8Array(16))) {
  const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, await keyOf(secretHex, pubkeyHex), utf8ToBytes(text));
  return `${base64.encode(new Uint8Array(ct))}?iv=${base64.encode(iv)}`;
}

/** The text of a NIP-04 payload from `pubkeyHex`, read with `secretHex`; throws when it is not one or the key is wrong. */
export async function nip04Decrypt(secretHex, pubkeyHex, payload) {
  const [ct, iv] = String(payload).split('?iv=');
  if (!ct || !iv) throw new Error('Not a NIP-04 payload.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: base64.decode(iv) }, await keyOf(secretHex, pubkeyHex), base64.decode(ct));
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}
