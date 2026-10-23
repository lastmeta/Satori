// The chain module against the real D6 contracts on an anvil fork of Base
// Sepolia. Skipped unless BASE_FORK names one (never a public chain):
//   node scripts/fork.mjs start --port 8546
//   BASE_FORK=http://127.0.0.1:8546 npx vitest run src/chain/fork.test.js
// Fresh throwaway keys each run; the fork's clock moves forward.
import { describe, expect, test } from 'vitest';
import { http, zeroAddress } from 'viem';
import { generateSecret, publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { DEFAULTS } from './config.js';
import { createChain, revertName, DOWN, INDEFINITE } from './index.js';
import { fund, airdrop, merkle, advance, clients, stream } from '../../scripts/fork.mjs';
import { runBatch } from '../neuron/base.js';

const RPC = process.env.BASE_FORK;
const E18 = 10n ** 18n;
const signer = () => {
  const secret = generateSecret();
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};

describe.skipIf(!RPC || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC))('on a local fork of Base Sepolia', () => {
  test('stake, the batch, claims, unstake, the transfer rule, a send', { timeout: 180_000 }, async () => {
    const alias = signer();
    const wallet = signer();
    const I = alias.evmAddress;
    const V = wallet.evmAddress;
    const chain = createChain({ config: DEFAULTS, transport: http(RPC), pollingInterval: 250, settle: { tries: 5, ms: 500 } });
    const st = () => chain.status({ alias: I, wallet: V });
    await fund(RPC, [I], { eth: '0.1' });
    await fund(RPC, [V], { eth: '0.1', satori: '100' });

    const before = await st();
    expect(before).toMatchObject({ errors: [], alias: { fee: 1000, power: 0n }, wallet: { satori: 100n * E18, delegate: zeroAddress, lockedUntil: 0 } });

    const d = await chain.delegate({ alias, wallet });
    expect(d.steps.map((x) => x.step)).toEqual(['setPredictorFee(0)', 'setAllowedDelegator(wallet)', 'delegatePredictionPower(alias)']);
    const on = await st();
    expect(on.alias).toMatchObject({ fee: 0, power: 100n * E18, allowedDelegator: V });
    expect(on.wallet).toMatchObject({ delegate: I, lockedUntil: INDEFINITE, lock: { locked: true, indefinite: true } });

    const junk = await stream(RPC, `junk-${Date.now()}`); // anyone's stream: a game, but no voting weight
    expect(junk.gameId).toBeGreaterThan(0);
    const streams = await chain.streams();
    expect(streams.find((g) => g.streamId === 1)).toMatchObject({ gameId: 1, named: false, cadenceMinutes: 1440 });
    expect(streams.find((g) => g.streamId === junk.streamId)).toBeUndefined();
    expect((await chain.history(1)).length).toBeGreaterThan(1);
    expect(await chain.batchState(I)).toMatchObject({ round: on.round, power: 100n * E18, predicted: 0 });
    expect(await chain.simulateGame(alias, { gameId: 1, direction: DOWN })).toBe(null);
    const batch = await chain.sendBatch(alias, [{ gameId: 1, direction: DOWN }]);
    expect(batch.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await chain.batchState(I)).predicted).toBe(1);
    expect(await chain.simulateGame(alias, { gameId: 1, direction: DOWN })).toBe('AlreadyPredicted');

    // Claims a round later: the airdrop (loaded now), the merkle drop (the reserve accrues per round).
    await airdrop(RPC, V, 600);
    const proof = await merkle(RPC, V, 5);
    await advance(RPC, 1);
    const later = await st();
    expect(later.claimable.airdrop).toBeGreaterThan(0n);
    await chain.claimAirdrop(wallet);
    expect(await chain.alreadyMinted(V)).toBe(0n);
    await chain.claimMerkle(wallet, proof);
    expect(await chain.alreadyMinted(V)).toBe(5n * E18);
    const claimed = await st();
    expect(claimed.wallet.satori).toBeGreaterThan(105n * E18);
    // The token's hook kept the alias's power in step with the wallet's new balance (HOOK_GAS):
    // with the bare estimate it fails silently and the unstake below panics (0x11).
    expect(claimed.alias.power).toBe(claimed.wallet.satori);

    // Unstake: transfer-locked through the next round (>=), then free.
    const off = await chain.undelegate({ wallet });
    expect(off.steps).toHaveLength(1);
    const stopped = await st();
    expect(stopped.wallet.lock).toMatchObject({ locked: true, untilRound: stopped.round + 1 });
    const to = '0x000000000000000000000000000000000000dEaD';
    expect(revertName(await chain.sendSatori(wallet, to, E18).catch((e) => e))).toBe('Locked');
    await advance(RPC, 1);
    expect((await st()).wallet.lock.locked).toBe(true); // round N itself is still locked (Lite would say free)
    expect(revertName(await chain.sendSatori(wallet, to, E18).catch((e) => e))).toBe('Locked');
    await advance(RPC, 1);
    expect((await st()).wallet.lock.locked).toBe(false);
    await chain.sendSatori(wallet, to, E18);
    const { pub } = clients(RPC);
    const ethBefore = await pub.getBalance({ address: to });
    await chain.sendEth(wallet, to, 10n ** 15n);
    expect(await pub.getBalance({ address: to })).toBe(ethBefore + 10n ** 15n);
  });

  // A batch that never mines (docs/design/base.md#a-batch-that-never-mines): anvil's mining stopped (interval mining off,
  // no automine), the batch waits in its pool; after STUCK_S (0 here) its nonce is still pending, so it is sent again at
  // that nonce with a quarter more fee, which the pool takes in its place; mining again, the replacement is mined.
  test('a batch that never mines: replaced at its nonce with a higher fee, within the ceiling; past it, said and not sent', { timeout: 180_000 }, async () => {
    const { test: anvil, pub } = clients(RPC);
    const mem = () => {
      const m = new Map();
      return { m, get: async (k) => m.get(k), set: async (k, v) => void m.set(k, structuredClone(v)), checkpoint: async () => {} };
    };
    const chain = createChain({ config: DEFAULTS, transport: http(RPC), pollingInterval: 250, settle: { tries: 5, ms: 500 } });
    const staked = async () => {
      const alias = signer();
      const wallet = signer();
      await fund(RPC, [alias.evmAddress], { eth: '0.1' });
      await fund(RPC, [wallet.evmAddress], { eth: '0.1', satori: '10' });
      await chain.delegate({ alias, wallet });
      return alias;
    };
    const flat = () => ({ model: 'naive', value: 1, horizon: 86_400 }); // any forecast: the stuck path is the point
    const one = await staked();
    const two = await staked();
    let t = 1_000;
    const run = (alias, db, o = {}) => runBatch({ chain, alias, db, forecast: flat, now: () => t, pendingWaitMs: 500, sendWaitMs: 3000,
      maxFeeWei: 10n ** 9n * 2n, ...o });
    await anvil.setAutomine(false);
    await anvil.setIntervalMining({ interval: 0 }); // Base stops mining
    try {
      const db = mem();
      expect(await run(one, db)).toMatchObject({ skipped: expect.stringMatching(/^waiting for the batch already sent/), pendingAt: 1000 });
      const p = db.m.get('base_pending_batch');
      expect(await pub.getTransactionCount({ address: one.evmAddress, blockTag: 'latest' })).toBe(p.nonce); // still pending
      t += 600;
      const r = await run(one, db);
      expect(r).toMatchObject({ stuck: { replaced: 1 }, skipped: expect.stringMatching(/^stuck: retrying with a higher fee/) });
      const q = db.m.get('base_pending_batch');
      expect(q.hashes).toEqual([p.hash, q.hash]);
      expect(BigInt(q.fees.maxFeePerGas) * 4n).toBeGreaterThanOrEqual(BigInt(p.fees.maxFeePerGas) * 5n);

      // past the ceiling: nothing sent, said (another alias's batch, stuck the same way)
      const db2 = mem();
      await run(two, db2);
      const p2 = db2.m.get('base_pending_batch');
      t += 600;
      const c = await run(two, db2, { maxFeeWei: BigInt(p2.fees.maxFeePerGas) });
      expect(c).toMatchObject({ stuck: { ceiling: true }, skipped: expect.stringMatching(/would pass the max fee/) });
      expect(db2.m.get('base_pending_batch').hash).toBe(p2.hash);

      await anvil.mine({ blocks: 1 }); // Base mines again: the replacement, not the first
      const done = await run(one, db);
      expect(done).toMatchObject({ sent: { hash: q.hash } });
      expect((await chain.batchState(one.evmAddress)).predicted).toBe(1);
      expect(await pub.getTransactionReceipt({ hash: p.hash }).catch(() => null)).toBe(null); // the first never mined
      expect((await run(two, db2)).sent).toMatchObject({ hash: p2.hash }); // the other, as it was, at the old fee
    } finally {
      await anvil.setIntervalMining({ interval: 2 }); // as fork.mjs starts it
    }
  });
});
