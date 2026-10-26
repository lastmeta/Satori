import { describe, expect, test } from 'vitest';
import { deviceKey, toRest, fromRest, DEVICE_KEY, KEY_GONE } from './atrest.js';

const store = () => {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); } };
};
const RECORD = { v: 1, created: 1, alias: 'aa'.repeat(32), nostr: 'bb'.repeat(32), from: 'wallet', wallet: { pubkey: '02' + 'cc'.repeat(32) },
  retired: [{ alias: 'dd'.repeat(32), nostr: 'ee'.repeat(32), at: 2 }], link: { message: 'm', signature: 's' } };

describe('the keys at rest (docs/design/keys.md#at-rest)', () => {
  test("this browser's key: made once, kept, non-extractable; the same one after", async () => {
    const s = store();
    const key = await deviceKey(s);
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.extractable).toBe(false);
    expect(s.m.get(DEVICE_KEY)).toBe(key);
    expect(await deviceKey(s)).toBe(key);
  });

  test('sealed: no secret in the stored record, everything else as it was; opened, the same record', async () => {
    const key = await deviceKey(store());
    const stored = await toRest(RECORD, key);
    expect(stored).toEqual({ v: 1, created: 1, from: 'wallet', wallet: RECORD.wallet, link: RECORD.link, sealed: { iv: expect.any(String), data: expect.any(String) } });
    expect(JSON.stringify(stored)).not.toMatch(/aaaa|bbbb|dddd|eeee/);
    expect(await fromRest(stored, key)).toEqual(RECORD);
    const { retired: _r, ...noRetired } = RECORD;
    expect(await fromRest(await toRest(noRetired, key), key)).toEqual(noRetired);
  });

  test("where it can't be kept or checked: null, and the record stays in hex", async () => {
    expect(await deviceKey({ get: async () => undefined, put: async () => { throw new Error('DataCloneError'); } })).toBe(null);
    const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    expect(await deviceKey({ get: async () => extractable, put: async () => {} })).toBe(null);
    expect(await deviceKey({ get: async () => ({ not: 'a key' }), put: async () => {} })).toBe(null);
    expect(await deviceKey({ get: async () => undefined, put: async () => {} })).toBe(null); // not kept: read back nothing
    expect(await toRest(RECORD, null)).toBe(RECORD);
    expect(await fromRest(RECORD, null)).toBe(RECORD);
  });

  test('sealed, and the key gone or another: said plainly', async () => {
    const stored = await toRest(RECORD, await deviceKey(store()));
    await expect(fromRest(stored, null)).rejects.toThrow(KEY_GONE);
    await expect(fromRest(stored, await deviceKey(store()))).rejects.toThrow(KEY_GONE);
  });
});
