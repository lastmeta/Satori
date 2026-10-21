// NIP-04 as satorilib's encryption.py (nostr-sdk 0.45) does it: test/fixtures/nip04-vectors.json, made by nostr-sdk
// (scripts/nip04_vectors.py), read here; and ours read back.
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { nostrPubkey } from './event.js';
import { nip04Decrypt, nip04Encrypt } from './nip04.js';

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/nip04-vectors.json', import.meta.url)));

test("nostr-sdk's ciphertexts (Lite's) are read: the recipient with the sender's pubkey, the sender with the recipient's", async () => {
  expect(nostrPubkey(fx.sender)).toBe(fx.sender_pubkey);
  for (const v of fx.vectors) {
    expect(await nip04Decrypt(fx.recipient, fx.sender_pubkey, v.ciphertext)).toBe(v.text);
    expect(await nip04Decrypt(fx.sender, fx.recipient_pubkey, v.ciphertext)).toBe(v.text); // one shared key
  }
});

test("ours: base64(AES-256-CBC)?iv=base64(16 bytes), a fresh iv each time, read back; nostr-sdk reads the fixture's", async () => {
  const a = await nip04Encrypt(fx.sender, fx.recipient_pubkey, '101.25');
  const b = await nip04Encrypt(fx.sender, fx.recipient_pubkey, '101.25');
  expect(a).toMatch(/^[A-Za-z0-9+/]+={0,2}\?iv=[A-Za-z0-9+/]{22}==$/);
  expect(a).not.toBe(b);
  expect(await nip04Decrypt(fx.recipient, fx.sender_pubkey, a)).toBe('101.25');
  // a fixed iv gives nostr-sdk's bytes for the same text (scripts/nip04_vectors.py <file> decrypts ours too)
  const [v] = fx.vectors;
  const iv = Uint8Array.from(atob(v.ciphertext.split('?iv=')[1]), (c) => c.charCodeAt(0));
  expect(await nip04Encrypt(fx.sender, fx.recipient_pubkey, v.text, iv)).toBe(v.ciphertext);
});

test('a wrong key, a changed byte or no iv throws', async () => {
  const [v] = fx.vectors;
  const other = nostrPubkey('4'.repeat(64));
  await expect(nip04Decrypt(fx.recipient, other, v.ciphertext)).rejects.toThrow();
  await expect(nip04Decrypt(fx.recipient, fx.sender_pubkey, v.ciphertext.split('?iv=')[0])).rejects.toThrow(/NIP-04/);
  await expect(nip04Decrypt(fx.recipient, fx.sender_pubkey, 'not base64?iv=AAAA')).rejects.toThrow();
});
