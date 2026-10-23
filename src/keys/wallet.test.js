// The wallet's encryption (docs/design/keys.md#the-wallet-encryption).
import { describe, expect, test, vi } from 'vitest';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { sealSecret, openSecret, checkNewPassphrase, passphraseOk, MIN_PASSPHRASE, ITERATIONS } from './wallet.js';

vi.setConfig({ testTimeout: 60_000 });

const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const b64 = (s) => Buffer.from(s, 'base64');

describe('PBKDF2-SHA256 → AES-256-GCM over the 32-byte secret', () => {
  test('round trip; the record holds every parameter; salt and IV are new each time', async () => {
    const r = await sealSecret(secret, 'correct horse battery');
    expect(r).toEqual({
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: expect.any(String) },
      cipher: { name: 'AES-GCM', iv: expect.any(String) },
      data: expect.any(String),
    });
    expect(ITERATIONS).toBe(600_000);
    expect([b64(r.kdf.salt).length, b64(r.cipher.iv).length, b64(r.data).length]).toEqual([16, 12, 32 + 16]);
    expect(await openSecret(r, 'correct horse battery')).toEqual(secret);
    const again = await sealSecret(secret, 'correct horse battery');
    expect(again.kdf.salt).not.toBe(r.kdf.salt);
    expect(again.cipher.iv).not.toBe(r.cipher.iv);
    expect(again.data).not.toBe(r.data);
  });

  test('another implementation opens it: node:crypto with the record\'s parameters, the passphrase as UTF-8 of its NFC', async () => {
    const pass = 'Ünïcødé 密码 🔑';
    const r = await sealSecret(secret, pass);
    const key = pbkdf2Sync(Buffer.from(pass.normalize('NFC'), 'utf8'), b64(r.kdf.salt), r.kdf.iterations, 32, 'sha256');
    const data = b64(r.data);
    const d = createDecipheriv('aes-256-gcm', key, b64(r.cipher.iv));
    d.setAuthTag(data.subarray(32));
    expect(new Uint8Array(Buffer.concat([d.update(data.subarray(0, 32)), d.final()]))).toEqual(secret);
  });

  test('a wrong passphrase, or a changed byte, fails GCM\'s authentication: "Wrong passphrase"', async () => {
    const r = await sealSecret(secret, 'correct horse battery');
    await expect(openSecret(r, 'correct horse batterY')).rejects.toThrow(/^Wrong passphrase$/);
    const data = b64(r.data);
    data[5] ^= 1;
    await expect(openSecret({ ...r, data: data.toString('base64') }, 'correct horse battery')).rejects.toThrow(/^Wrong passphrase$/);
    const iv = b64(r.cipher.iv);
    iv[0] ^= 1;
    await expect(openSecret({ ...r, cipher: { ...r.cipher, iv: iv.toString('base64') } }, 'correct horse battery'))
      .rejects.toThrow(/^Wrong passphrase$/);
  });

  test('any Unicode: non-Latin letters and emoji', async () => {
    for (const pass of ['密码密码密码密码', '🔑🦊🌕🚀🔑🦊🌕🚀', 'пароль-пароль', 'كلمة المرور']) {
      const r = await sealSecret(secret, pass);
      expect(await openSecret(r, pass), pass).toEqual(secret);
    }
  });

  test('NFC: é typed as one code point or as e + a combining accent is the same passphrase', async () => {
    const composed = 'caf\u00e9 au lait';
    const decomposed = 'cafe\u0301 au lait';
    expect(composed).not.toBe(decomposed);
    expect(await openSecret(await sealSecret(secret, composed), decomposed)).toEqual(secret);
    expect(await openSecret(await sealSecret(secret, decomposed), composed)).toEqual(secret);
  });

  test('the parameters are read from the record, so a record from other settings still opens', async () => {
    const r = await sealSecret(secret, 'correct horse battery', { iterations: 1_000 });
    expect(r.kdf.iterations).toBe(1_000);
    expect(await openSecret(r, 'correct horse battery')).toEqual(secret);
  });

  test('a record it does not know is refused, not guessed at', async () => {
    const r = await sealSecret(secret, 'correct horse battery', { iterations: 1_000 });
    await expect(openSecret({ ...r, kdf: { ...r.kdf, hash: 'SHA-1' } }, 'x')).rejects.toThrow(/wallet format/);
    await expect(openSecret({ ...r, cipher: { ...r.cipher, name: 'AES-CBC' } }, 'x')).rejects.toThrow(/wallet format/);
    await expect(openSecret({ ...r, kdf: { ...r.kdf, iterations: 0 } }, 'x')).rejects.toThrow(/wallet format/);
  });
});

describe('a new passphrase: at least 8 characters, any Unicode', () => {
  test('counted in code points after NFC', () => {
    expect(MIN_PASSPHRASE).toBe(8);
    for (const ok of ['12345678', '密码密码密码密码', '🔑🦊🌕🚀🔑🦊🌕🚀', 'cafe\u0301 au lait', 'pässwörd']) {
      expect(passphraseOk(ok), ok).toBe(true);
      expect(() => checkNewPassphrase(ok)).not.toThrow();
    }
    // 4 emoji are 8 UTF-16 units but 4 characters; 4 × e + accent is 8 code points but 4 after NFC
    for (const short of ['1234567', '密码密码', '🔑🦊🌕🚀', 'e\u0301e\u0301e\u0301e\u0301', '']) {
      expect(passphraseOk(short), short).toBe(false);
      expect(() => checkNewPassphrase(short)).toThrow(/at least 8 characters/);
    }
    expect(passphraseOk(undefined)).toBe(false);
    expect(() => checkNewPassphrase(null)).toThrow(/passphrase/);
  });
});
