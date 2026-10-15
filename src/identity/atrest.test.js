import { describe, expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 }); // the shared box can be slow; noble builds tables on first use
import { seal, unseal, makeDeviceKey, wrapWithDevice, unwrapWithDevice, ITERATIONS } from './atrest.js';

const secret = Uint8Array.from({ length: 32 }, (_, i) => i);

describe('passphrase seal (PBKDF2-SHA256 + AES-256-GCM)', () => {
  test('default parameters are stored with the ciphertext', async () => {
    const rec = await seal(secret, 'correct horse');
    expect(ITERATIONS).toBe(600_000);
    expect(rec).toMatchObject({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 600_000, cipher: 'AES-256-GCM' });
    expect(rec.salt).toBeInstanceOf(Uint8Array);
    expect(rec.salt.length).toBe(16);
    expect(rec.iv.length).toBe(12);
    expect(await unseal(rec, 'correct horse')).toEqual(secret);
  });
  test('iterations are read from the record', async () => {
    const rec = await seal(secret, 'p', { iterations: 1000 });
    expect(rec.iterations).toBe(1000);
    expect(await unseal(rec, 'p')).toEqual(secret);
  });
  test('wrong passphrase throws', async () => {
    const rec = await seal(secret, 'p', { iterations: 1000 });
    await expect(unseal(rec, 'q')).rejects.toThrow(/wrong passphrase/i);
  });
  test('fresh salt and iv each time', async () => {
    const a = await seal(secret, 'p', { iterations: 1000 });
    const b = await seal(secret, 'p', { iterations: 1000 });
    expect(a.salt).not.toEqual(b.salt);
    expect(a.ct).not.toEqual(b.ct);
  });
});

describe('remember on this device', () => {
  test('device key is non-extractable and wraps/unwraps', async () => {
    const key = await makeDeviceKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    const rec = await wrapWithDevice(secret, key);
    expect(await unwrapWithDevice(rec, key)).toEqual(secret);
    await expect(unwrapWithDevice(rec, await makeDeviceKey())).rejects.toThrow();
  });
});
