// The daily push's wake (docs/design/push.md): what the service worker does with a push, and the app taking in its batch.
import { describe, expect, it, vi } from 'vitest';
import { wake, REMIND, GAME } from './wake.js';
import { adopt, batchDb, HANDOFF, SW_BATCH } from './handoff.js';
import { toRest, DEVICE_KEY } from '../keys/atrest.js';
import { evmAddress, publicKey } from '../keys/keys.js';
import { hexToBytes } from '@noble/hashes/utils';

const ALIAS = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ADDRESS = evmAddress(publicKey(hexToBytes(ALIAS)));

function idb(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k) => m.get(k) ?? undefined, put: async (k, v) => { m.set(k, v); } };
}
const handoff = (o = {}) => ({ rpc: ['https://rpc.example'], config: {}, maxFeeWei: '2000000000', play: 'auto', staked: true, alias: ALIAS, ...o });
const chain = (pending = 5, latest = 5) => ({ nonce: async (_, which) => (which === 'pending' ? pending : latest) });

describe('wake', () => {
  it('reminds with no handoff, or nothing staked with the app; by hand, the game is ready', async () => {
    expect(await wake({ ...idb() })).toBe(REMIND);
    expect(await wake({ ...idb({ [HANDOFF]: handoff({ staked: false }) }) })).toBe(REMIND);
    expect(await wake({ ...idb({ [HANDOFF]: handoff({ play: 'manual' }) }) })).toBe(GAME);
  });

  it('sends the batch with the sealed alias, keeping what it sent for the app', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const { sealed } = await toRest({ alias: ALIAS, nostr: null }, key);
    const store = idb({ [HANDOFF]: handoff({ alias: undefined, sealed }), [DEVICE_KEY]: key });
    const run = vi.fn(async ({ alias, db, maxFeeWei }) => {
      expect(alias.evmAddress).toBe(ADDRESS);
      expect(alias.signDigest(new Uint8Array(32).fill(1)).r).toMatch(/^0x[0-9a-f]{64}$/);
      expect(maxFeeWei).toBe(2_000_000_000n);
      await db.set('base_pending_batch', { round: 7, hash: '0xabc' });
      return { sent: { games: [{}, {}] } };
    });
    const n = await wake({ ...store, chainOf: () => chain(), runBatch: run });
    expect(n.body).toBe("Satori sent today's predictions (2 games).");
    expect(store.m.get(SW_BATCH)).toEqual({ base_pending_batch: { round: 7, hash: '0xabc' } });
  });

  it("doesn't send while the alias has a transaction pending, or while the app holds the lock", async () => {
    const run = vi.fn();
    expect(await wake({ ...idb({ [HANDOFF]: handoff() }), chainOf: () => chain(6, 5), runBatch: run })).toBe(REMIND);
    expect(await wake({ ...idb({ [HANDOFF]: handoff() }), chainOf: () => chain(), lock: async () => null, runBatch: run })).toBe(REMIND);
    expect(run).not.toHaveBeenCalled();
  });

  it('says the predictions are in when the round already has them, and reminds when anything fails', async () => {
    const store = idb({ [HANDOFF]: handoff() });
    expect((await wake({ ...store, chainOf: () => chain(), runBatch: async () => ({ skip: 'predicted', skipped: 'already predicted this round' }) })).body)
      .toBe("Today's predictions are in.");
    expect(await wake({ ...store, chainOf: () => chain(), runBatch: async () => ({ error: 'rpc down' }) })).toBe(REMIND);
    expect(await wake({ ...idb({ [HANDOFF]: handoff({ alias: 'zz' }) }), chainOf: () => chain() })).toBe(REMIND);
  });
});

describe('adopt', () => {
  const appDb = (init = {}) => { const m = new Map(Object.entries(init)); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } }; };

  it("takes the worker's pending and last batch as the app's own, then clears them", async () => {
    const store = idb();
    await batchDb(store.get, store.put).set('base_pending_batch', { round: 8, hash: '0x1' });
    await batchDb(store.get, store.put).set('base_last_batch', { round: 7 });
    const db = appDb({ base_last_batch: { round: 6 } });
    expect(await adopt({ ...store, db })).toBe(true);
    expect(db.m.get('base_pending_batch')).toEqual({ round: 8, hash: '0x1' });
    expect(db.m.get('base_last_batch')).toEqual({ round: 7 });
    expect(store.m.get(SW_BATCH)).toBe(null);
    expect(await adopt({ ...store, db })).toBe(false);
  });

  it("never replaces the app's own pending batch or a later last one", async () => {
    const store = idb({ [SW_BATCH]: { base_pending_batch: { hash: '0xw' }, base_last_batch: { round: 5 } } });
    const db = appDb({ base_pending_batch: { hash: '0xa' }, base_last_batch: { round: 6 } });
    await adopt({ ...store, db });
    expect(db.m.get('base_pending_batch')).toEqual({ hash: '0xa' });
    expect(db.m.get('base_last_batch')).toEqual({ round: 6 });
  });
});
