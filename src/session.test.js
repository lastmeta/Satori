// The keys' one owner (src/session.js): read from the record only, written in one place, every replaced key kept.
import { describe, expect, test } from 'vitest';
import { createSession } from './session.js';
import { newKeys, evmAddress, publicKey, generateSecret } from './keys/index.js';
import { deviceKey } from './keys/atrest.js';
import { hexToBytes } from '@noble/hashes/utils';

const kv = () => {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, checkpoint: async () => {} };
};
const idb = () => {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); } };
};

describe('the session', () => {
  test('the alias, the Nostr key and the wallet are read from the record; a save is sealed, read again, and keeps what it replaced', async () => {
    const db = kv();
    const key = await deviceKey(idb());
    const s = createSession({ db, restKey: async () => key });
    expect(await s.load()).toBe(null); // nothing stored: Setup
    const first = await newKeys({ wallet: generateSecret() }, 'pass phrase');
    await s.save(first);
    expect(db.m.get('keys').sealed).toBeTruthy(); // the alias and the Nostr key sealed at rest
    expect(s.alias.evmAddress).toBe(evmAddress(publicKey(hexToBytes(first.alias))));
    expect(s.walletPublic.evmAddress).toBe(evmAddress(first.wallet.pubkey));
    const other = await newKeys({ wallet: generateSecret() }, 'pass phrase');
    await s.save({ ...first, alias: other.alias, nostr: other.nostr });
    expect(s.alias.evmAddress).toBe(evmAddress(publicKey(hexToBytes(other.alias)))); // the new alias at once, nowhere stale
    expect(s.retired).toBe(1);
    const again = createSession({ db, restKey: async () => key }); // a reload
    await again.load();
    expect([again.alias.evmAddress, again.retired]).toEqual([s.alias.evmAddress, 1]);
  }, 30_000);
});
