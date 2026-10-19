// The Base flow (docs/design/base.md): the daily batch's rules, the schedule,
// stake, claims and sends, against test/fake-satori.js (viem over a custom
// transport) and a Map for the database.
import { forecast } from '../engine/index.js';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { fakeSatori, E18 } from '../../test/fake-satori.js';
import { CentralError } from '../central/index.js';
import { UP, DOWN, ROUND_S, INDEFINITE } from '../chain/index.js';
import { createWork } from './work.js';
import {
  createBase, runBatch, stepFor, horizonFor, directionOf, directionFor, nextCheckAt, toPoints, stakeSync, proofState, dropClaimable,
  FIRST_CHECK_S, CHECK_EVERY_S, MAX_FEE_GWEI, PROOF_TTL_S,
} from './base.js';

const signerOf = (hex) => {
  const secret = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};
const identity = signerOf('11'.repeat(32));
const vaultKey = signerOf('22'.repeat(32));
const I = identity.evmAddress.toLowerCase();
const V = vaultKey.evmAddress.toLowerCase();
const ROUND = 20741;
const H0 = ROUND * 24; // this round's first hour

function memDb(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k) => m.get(k), set: async (k, v) => void m.set(k, structuredClone(v)), checkpoint: vi.fn(async () => {}) };
}
const up = (pts) => ({ model: 'test', t1: pts.at(-1).value * 2, t2: pts.at(-1).value * 2, value: pts.at(-1).value * 2, horizon: 86_400 }); // UP

let s, rpc, db, chainOf;
beforeEach(async () => {
  ({ s, rpc } = fakeSatori({ round: ROUND, hour: 9, eth: { [I]: 10n ** 17n, [V]: 10n ** 17n } }));
  s.balance[V] = 100n * E18;
  db = memDb();
  const { createChain } = await import('../chain/index.js');
  const { DEFAULTS } = await import('../chain/config.js');
  chainOf = () => createChain({ config: DEFAULTS, transport: rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 } });
});
const staked = async () => { await chainOf().delegate({ identity, vault: vaultKey }); rpc.sent.length = 0; };
const batchesSent = () => rpc.sent.filter((t) => t.functionName === 'predictMultipleWithPayloads').map((t) => t.args[0]);

describe('rules', () => {
  test('the engine\'s step: 12 h, or the stream\'s cadence when slower (the default stream is daily)', () => {
    expect(stepFor(60)).toBe(43_200);
    expect(stepFor(720)).toBe(43_200);
    expect(stepFor(1440)).toBe(86_400);
    expect(stepFor(0)).toBe(43_200);
  });
  test('the step divides the horizon: n = max(1, floor(horizon / max(12 h, cadence))), step = horizon / n', () => {
    const h = 3600;
    for (const [minutes, step, horizon] of [[90, 12 * h, 24 * h], [13 * 60, 24 * h, 24 * h], [18 * 60, 24 * h, 24 * h],
      [24 * 60, 24 * h, 24 * h], [48 * 60, 48 * h, 48 * h], [60, 12 * h, 24 * h], [12 * 60, 12 * h, 24 * h]]) {
      expect([stepFor(minutes), horizonFor(minutes)], `${minutes} min`).toEqual([step, horizon]);
      // the engine then forecasts exactly at the horizon (13 h gave 26 h, 15 h 30 h, 18 h 18 h)
      const pts = Array.from({ length: 300 }, (_, i) => ({ ts: 1_750_000_000 + i * minutes * 60, value: 100 + Math.sin(i) }));
      expect(forecast(pts, { step: stepFor(minutes), horizon: horizonFor(minutes) }).horizon, `${minutes} min`).toBe(horizon);
    }
  });
  test('the horizon: one cadence ahead, at least the 24 h the round scores', () => {
    expect(horizonFor(60)).toBe(86_400); // hourly: 12 h steps, 2 of them
    expect(horizonFor(1440)).toBe(86_400); // daily (the default stream): 24 h steps, 1 of them
    expect(horizonFor(2880)).toBe(172_800); // every two days: one cadence
    expect(horizonFor(0)).toBe(86_400);
  });
  test('direction as Lite\'s direction_from: UP above the latest, else DOWN (a tie is DOWN)', () => {
    expect([directionOf(2, 1), directionOf(1, 1), directionOf(0.5, 1)]).toEqual([UP, DOWN, DOWN]);
  });
  test('the owner\'s tie rule (2026-10-19): a forecast equal to the latest follows the stream\'s last move; flat stays DOWN', () => {
    const hist = (...v) => v.map((value, i) => ({ hour: i, value: BigInt(value) }));
    // not a tie: the forecast decides, as before
    expect(directionFor(12, hist(5, 9, 10))).toEqual({ direction: UP, rule: 'forecast' });
    expect(directionFor(8, hist(5, 9, 10))).toEqual({ direction: DOWN, rule: 'forecast' });
    expect(directionFor(8, hist(15, 12, 10))).toEqual({ direction: DOWN, rule: 'forecast' }); // a down move does not overrule a forecast
    // a tie: the most recent change in the history; repeats after it do not count
    expect(directionFor(10, hist(5, 9, 10))).toEqual({ direction: UP, rule: 'last-move' });
    expect(directionFor(10, hist(15, 12, 10))).toEqual({ direction: DOWN, rule: 'last-move' });
    expect(directionFor(10, hist(3, 12, 10, 10, 10))).toEqual({ direction: DOWN, rule: 'last-move' }); // 12 → 10, then flat
    expect(directionFor(10, hist(20, 7, 10, 10))).toEqual({ direction: UP, rule: 'last-move' });
    expect(directionFor(-3, hist(0, -5, -3))).toEqual({ direction: UP, rule: 'last-move' }); // a named stream's signed counter
    // exact on int232 values beyond 2^53: 59058240589371161 is one above 59058240589371160
    expect(directionFor(59058240589371161, hist('59058240589371160', '59058240589371161'))).toEqual({ direction: UP, rule: 'last-move' });
    // a tie with no change at all: DOWN, the last fallback
    expect(directionFor(10, hist(10, 10, 10))).toEqual({ direction: DOWN, rule: 'flat' });
    expect(directionFor(10, hist(10))).toEqual({ direction: DOWN, rule: 'flat' });
  });
  test('the next check: the next round\'s start + 1 min on the chain\'s clock, at most an hour away', () => {
    const chainTime = ROUND * ROUND_S + 23.5 * 3600; // 23:30 on the chain
    expect(nextCheckAt({ now: 1000, chainTime })).toBe(1000 + 1800 + 60);
    expect(nextCheckAt({ now: 1000, chainTime: ROUND * ROUND_S + 9 * 3600 })).toBe(1000 + CHECK_EVERY_S);
    expect(nextCheckAt({ now: 1000, chainTime: null })).toBe(1000 + CHECK_EVERY_S);
  });
  test('registry history → points: hours to seconds, int232 → number', () => {
    expect(toPoints([{ hour: 10, value: 5n * E18 }])).toEqual([{ ts: 36_000, value: 5e18 }]);
  });
});

describe('staking in sync (the token-hook bug: docs/issues/token-hook-gas-estimate.md)', () => {
  const vault = '0x' + 'aa'.repeat(20);
  const other = '0x' + 'bb'.repeat(20);
  test('the identity accepts only this vault, so its power must equal the vault\'s SATORI: equal is in sync, under is out', () => {
    const base = { staked: 'identity', allowedDelegator: vault.toUpperCase().replace('0X', '0x'), vault, power: 100n * E18, balance: 100n * E18 };
    expect(stakeSync(base)).toEqual({ inSync: true, shortfall: null });
    expect(stakeSync({ ...base, balance: 100n * E18 + 1n })).toEqual({ inSync: false, shortfall: '0.000000000000000001' }); // 1 wei, no hook
    expect(stakeSync({ ...base, power: 200n * E18 })).toEqual({ inSync: true, shortfall: null }); // over: unstaking still works
  });
  test('not checked (null): other stakers are possible (another allowed staker, or anyone), not staked here, or not read', () => {
    const base = { staked: 'identity', allowedDelegator: vault, vault, power: 1n, balance: 2n };
    expect(stakeSync({ ...base, allowedDelegator: other })).toEqual({ inSync: null, shortfall: null });
    expect(stakeSync({ ...base, allowedDelegator: zeroAddress })).toEqual({ inSync: null, shortfall: null }); // open to anyone
    expect(stakeSync({ ...base, staked: 'none' })).toEqual({ inSync: null, shortfall: null });
    expect(stakeSync({ ...base, power: null })).toEqual({ inSync: null, shortfall: null });
  });
});

describe("the Satori Network's reward drop, before it is claimed", () => {
  const entry = { root: '0xd97c', address: '0xda47', amountWei: '3618509550000000000', amount: 3.61850955, proof: ['0x' + 'ab'.repeat(32)] };
  test("central's answer, or its 404s: an entry, no drop published, not in the drop, or a central without the route (unknown)", () => {
    expect(proofState({ entry })).toEqual({ state: 'ok', amountWei: 3618509550000000000n, proof: entry.proof, root: '0xd97c' });
    expect(proofState({ error: new CentralError(404, 'no reward drop has been published yet') })).toEqual({ state: 'none' });
    expect(proofState({ error: new CentralError(404, '0xda47 is not in the current drop (nothing to claim, …)') })).toEqual({ state: 'not-in' });
    expect(proofState({ error: new CentralError(404, 'Not Found') })).toMatchObject({ state: 'unknown', missing: true }); // prod on main
    expect(proofState({ error: new CentralError(0, 'network') })).toMatchObject({ state: 'unknown', missing: false });
    expect(proofState({ entry: { amountWei: 'x' } })).toMatchObject({ state: 'unknown' }); // not an amount
  });
  test('claimable = max(0, the entitlement − alreadyMintedTo): none claimed, part, all, over; 0 with no entry; null when unknown', () => {
    const ok = proofState({ entry });
    expect(dropClaimable(ok, 0n)).toBe(3618509550000000000n);
    expect(dropClaimable(ok, 1618509550000000000n)).toBe(2n * E18); // partly claimed (a reserve that paid part)
    expect(dropClaimable(ok, 3618509550000000000n)).toBe(0n); // claimed in full
    expect(dropClaimable(ok, 5n * E18)).toBe(0n); // an older, bigger drop claimed: never negative
    expect(dropClaimable({ state: 'none' }, 0n)).toBe(0n);
    expect(dropClaimable({ state: 'not-in' }, 7n)).toBe(0n);
    expect(dropClaimable({ state: 'unknown', missing: true }, 0n)).toBeNull(); // not 0: this central does not say
    expect(dropClaimable(ok, null)).toBeNull(); // alreadyMintedTo not read
    expect(dropClaimable(null, 0n)).toBeNull();
  });
});

describe('the daily batch', () => {
  test('not staked: skipped, nothing sent', async () => {
    const r = await runBatch({ chain: chainOf(), identity, db });
    expect(r).toEqual({ at: ROUND * ROUND_S + 9 * 3600, round: ROUND, skipped: 'nothing staked with this neuron' });
    expect(rpc.sent).toHaveLength(0);
  });

  test('staked: the default stream with the engine (naive on two points: a tie, its last move up → UP), one tx, persisted after the receipt', async () => {
    await staked();
    const r = await runBatch({ chain: chainOf(), identity, db });
    expect(batchesSent()).toEqual([[{ gameId: 1, payload: '0x01' }]]); // DOWN under Lite's rule
    const batch = { round: ROUND, at: ROUND * ROUND_S + 9 * 3600, hash: rpc.sent[0].hash, dropped: [],
      // latest: the registry's int232, exact; forecast: the engine's at the horizon, as an integer (both decimal strings, as JSON keeps them)
      games: [{ streamId: 1, gameId: 1, named: false, direction: UP, rule: 'last-move', model: 'naive', latest: '59058240589371161',
        forecast: '59058240589371160', horizon: 86_400, step: 86_400, score: null, persist: null, tests: 0 }] };
    expect(r).toEqual({ at: batch.at, round: ROUND, sent: batch });
    expect(db.m.get('base_last_batch')).toEqual(batch);
    expect(db.m.get('base_pending_batch')).toBe(null);
    expect(db.checkpoint).toHaveBeenCalled();
    expect(await runBatch({ chain: chainOf(), identity, db })).toMatchObject({ skipped: 'already predicted this round' });
    expect(rpc.sent).toHaveLength(1);
  });

  test('report: nothing for a check with nothing to do; checking the games, sending, waiting for Base, in order', async () => {
    const seen = [];
    const report = (...a) => seen.push(a.join(' '));
    await runBatch({ chain: chainOf(), identity, db, report });
    expect(seen).toEqual([]); // not staked: a quick skip, nothing to show
    await staked();
    await runBatch({ chain: chainOf(), identity, db, report });
    expect(seen).toEqual(['check', 'send', 'confirm']);
    seen.length = 0;
    await runBatch({ chain: chainOf(), identity, db, report });
    expect(seen).toEqual([]); // already predicted
  });

  test('each game is simulated alone: a stale one is dropped and the rest go (Lite sinks the whole batch)', async () => {
    await staked();
    s.streams[3] = { game: 13, named: false, cadence: 60, history: [{ hour: H0 + 1, value: 10n }, { hour: H0 + 2, value: 11n }] };
    s.streams[4] = { game: 14, named: false, cadence: 60, history: [{ hour: H0 + 1, value: 7n }] };
    s.deadGames[14] = 'StaleValue';
    s.weights[13] = E18;
    s.weights[14] = E18;
    const r = await runBatch({ chain: chainOf(), identity, db, forecast: up });
    expect(batchesSent()).toEqual([[{ gameId: 1, payload: '0x01' }, { gameId: 13, payload: '0x01' }]]);
    expect(r.sent.dropped).toEqual([expect.objectContaining({ streamId: 4, gameId: 14, error: 'StaleValue' })]);
  });

  test('a named game under 24 clock hours since our last prediction on it: the simulate drops it (the contract\'s own rule)', async () => {
    await staked();
    s.streams[5] = { game: 15, named: true, cadence: 60, history: [{ hour: H0 + 1, value: 3n }] };
    s.weights[15] = E18;
    s.lastPred[`${I}:15`] = H0 - 2; // 22:00 yesterday; now 09:00
    const r = await runBatch({ chain: chainOf(), identity, db, forecast: up });
    expect(batchesSent()).toEqual([[{ gameId: 1, payload: '0x01' }]]);
    expect(r.sent.dropped).toEqual([expect.objectContaining({ gameId: 15, named: true, error: 'DuplicatePrediction' })]);
  });

  test('each stream is forecast at its horizon: a daily one in one 24 h step, an hourly one in two 12 h steps; the direction from that value', async () => {
    await staked();
    s.streams[3] = { game: 13, named: false, cadence: 60, history: [{ hour: H0 + 1, value: 10n }] };
    s.weights[13] = E18;
    const calls = [];
    // t2 says UP, the value at the horizon says DOWN: the direction must follow the value
    const fake = (pts, o) => (calls.push(o), { model: 'test', t1: 0, t2: pts.at(-1).value * 2, value: pts.at(-1).value / 2, horizon: o.horizon });
    const r = await runBatch({ chain: chainOf(), identity, db, forecast: fake });
    expect(calls).toEqual([{ step: 86_400, horizon: 86_400 }, { step: 43_200, horizon: 86_400 }]); // stream 1 is daily (1440 min)
    expect(batchesSent()).toEqual([[{ gameId: 1, payload: '0x02' }, { gameId: 13, payload: '0x02' }]]);
    expect(r.sent.games.map((g) => [g.gameId, g.forecast, g.horizon, g.rule])).toEqual([[1, expect.any(String), 86_400, 'forecast'], [13, '5', 86_400, 'forecast']]);
  });

  test('a tie on a flat stream (no change in its history) is DOWN, and the batch says which rule decided', async () => {
    await staked();
    s.streams[3] = { game: 13, named: false, cadence: 60, history: [{ hour: H0 - 1, value: 10n }, { hour: H0, value: 10n }] };
    s.weights[13] = E18;
    const r = await runBatch({ chain: chainOf(), identity, db });
    expect(batchesSent()).toEqual([[{ gameId: 1, payload: '0x01' }, { gameId: 13, payload: '0x02' }]]);
    expect(r.sent.games.map((g) => [g.gameId, g.model, g.direction, g.rule])).toEqual([[1, 'naive', UP, 'last-move'], [13, 'naive', DOWN, 'flat']]);
  });

  test('each game keeps its step and, from the engine\'s backtest, its median error and no change\'s (the Models tab\'s)', async () => {
    await staked();
    s.streams[3] = { game: 13, named: false, cadence: 60, history: Array.from({ length: 200 }, (_, k) => ({ hour: H0 - 199 + k, value: BigInt(1000 + (k % 7) * 3 + k) })) };
    s.weights[13] = E18;
    const r = await runBatch({ chain: chainOf(), identity, db });
    const g13 = r.sent.games.find((g) => g.gameId === 13);
    expect(g13).toMatchObject({ model: 'bar1', step: 43_200, horizon: 86_400, score: expect.any(Number), persist: expect.any(Number),
      tests: expect.any(Number) });
    expect(db.m.get('base_last_batch').games.find((g) => g.gameId === 13)).toEqual(g13);
    // naive: nothing tested, and said so (a game with no `tests` is from a batch before they were kept: the training pass's)
    expect(r.sent.games.find((g) => g.gameId === 1)).toMatchObject({ model: 'naive', score: null, persist: null, tests: 0 });
  });

  test('a game without voting weight (anyone\'s new stream) is not in the batch at all', async () => {
    await staked();
    for (let i = 10; i < 20; i++) s.streams[i] = { game: i + 100, named: false, cadence: 60, history: [{ hour: H0, value: 1000n }] };
    await runBatch({ chain: chainOf(), identity, db });
    expect(batchesSent()).toEqual([[{ gameId: 1, payload: '0x01' }]]);
  });

  test('nothing passes: no transaction, the reasons listed', async () => {
    await staked();
    s.deadGames[1] = 'EmptyStream';
    const r = await runBatch({ chain: chainOf(), identity, db });
    expect(r).toMatchObject({ round: ROUND, skipped: 'no game passes its simulation', dropped: [{ gameId: 1, error: 'EmptyStream' }] });
    expect(rpc.sent).toHaveLength(0);
    expect(db.m.has('base_last_batch')).toBe(false);
  });

  test('the round of a batch is its block\'s (a send at 23:59:59 can land in the next round)', async () => {
    const chain = {
      batchState: async () => ({ round: ROUND, chainTime: (ROUND + 1) * ROUND_S - 1, power: 1n, predicted: 0 }),
      streams: async () => [{ streamId: 1, gameId: 1, named: false, cadenceMinutes: 1440 }],
      history: async () => [{ hour: 1, value: 5n }],
      simulateGame: async () => null,
      fees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      sendBatch: async () => ({ hash: '0xh', at: (ROUND + 1) * ROUND_S + 1, blockNumber: 1 }),
    };
    const r = await runBatch({ chain, identity, db });
    expect(r).toMatchObject({ round: ROUND + 1, sent: { round: ROUND + 1, hash: '0xh' } });
  });

  test('a failed send is shown and stores no batch', async () => {
    const chain = {
      batchState: async () => ({ round: ROUND, chainTime: 100, power: 1n, predicted: 0 }),
      streams: async () => [{ streamId: 1, gameId: 1, named: false, cadenceMinutes: 1440 }],
      history: async () => [{ hour: 1, value: 5n }],
      simulateGame: async () => null,
      fees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      sendBatch: async () => { throw new Error('boom'); },
    };
    expect(await runBatch({ chain, identity, db })).toMatchObject({ error: 'boom' });
    expect(db.m.has('base_last_batch')).toBe(false);
  });

  test('the hash is kept as soon as the batch is sent: the next check waits for it instead of sending again', async () => {
    await staked();
    rpc.state.mine = false; // sent, not mined: the tab may close here
    const first = runBatch({ chain: chainOf(), identity, db });
    await vi.waitFor(() => expect(db.m.get('base_pending_batch')).toMatchObject({ round: ROUND, hash: expect.any(String) }));
    const { hash } = db.m.get('base_pending_batch');
    const seen = [];
    const again = await runBatch({ chain: chainOf(), identity, db, pendingWaitMs: 50, report: (st) => seen.push(st) });
    expect(again).toMatchObject({ round: ROUND, skipped: `waiting for the batch already sent (${hash})` });
    expect(seen).toEqual(['confirm']); // waiting for Base to confirm the one sent
    expect(rpc.sent).toHaveLength(1); // no second send
    rpc.release();
    const done = await runBatch({ chain: chainOf(), identity, db, pendingWaitMs: 50 });
    expect(done).toMatchObject({ round: ROUND, sent: { round: ROUND, hash, games: [{ gameId: 1 }] } });
    expect(db.m.get('base_last_batch')).toMatchObject({ hash });
    expect(db.m.get('base_pending_batch')).toBe(null);
    await first;
    expect(rpc.sent).toHaveLength(1);
  });

  test('a pending batch from an earlier round that never mined is let go', async () => {
    await staked();
    db.m.set('base_pending_batch', { round: ROUND - 1, hash: '0x' + '12'.repeat(32), games: [], dropped: [] });
    const r = await runBatch({ chain: chainOf(), identity, db, pendingWaitMs: 50 });
    expect(r).toMatchObject({ round: ROUND, sent: { round: ROUND } });
  });

  test('the spending ceiling: a max fee above it skips to the next check, and says why', async () => {
    await staked();
    rpc.state.tip = 3n * 10n ** 9n; // 3 gwei
    rpc.state.baseFee = 0n;
    const r = await runBatch({ chain: chainOf(), identity, db, maxFeeWei: 2n * 10n ** 9n });
    expect(r).toMatchObject({ round: ROUND, skipped: 'gas above the ceiling: a max fee of 3 gwei > 2 gwei; the next check tries again' });
    expect(rpc.sent).toHaveLength(0);
    rpc.state.tip = 10n ** 6n; // Base's usual 0.001 gwei
    expect(await runBatch({ chain: chainOf(), identity, db, maxFeeWei: 2n * 10n ** 9n })).toMatchObject({ sent: { round: ROUND } });
    expect(MAX_FEE_GWEI).toBe(2);
  });

  test('an RPC failure is an error for this check, not a dropped game', async () => {
    await staked();
    rpc.state.down = true;
    expect(await runBatch({ chain: chainOf(), identity, db })).toMatchObject({ error: expect.any(String) });
  });
});

describe('createBase', () => {
  let vault = null;
  let central;
  let base;
  const at = { t: 1_000_000 };
  const timers = [];
  const checks = []; // onCheck: each batch check's result (Home's activity log)
  beforeEach(() => {
    vault = null;
    central = {
      url: 'https://central2.example', root: null, proofs: {}, calls: [],
      baseConfig: async () => { throw new CentralError(404, 'Not Found'); },
      merkleProof: async (a) => { // central's two 404s (merkle.py:45-58); prod has no route: 'Not Found'
        central.calls.push(a);
        if (central.root === 'none') throw new CentralError(404, 'Not Found');
        if (!central.root) throw new CentralError(404, 'no reward drop has been published yet');
        const p = central.proofs[a.toLowerCase()];
        if (!p) throw new CentralError(404, `${a} is not in the current drop (nothing to claim, …)`);
        return p;
      },
    };
    timers.length = 0;
    checks.length = 0;
    base = createBase({ db, identity, vaultAddress: vaultKey.evmAddress, vault: () => vault, central: () => central,
      transport: rpc.transport, now: () => at.t, setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: () => {}, onCheck: (r) => checks.push(r) });
  });

  test("traffic: every RPC call and its answer is the Base channel's", async () => {
    const fired = [];
    const traced = createBase({ db, identity, vaultAddress: vaultKey.evmAddress, vault: () => vault, central: () => central,
      transport: rpc.transport, now: () => at.t, setTimeout: () => 0, clearTimeout: () => {}, onTraffic: () => fired.push(1) });
    await traced.refresh();
    expect(fired.length).toBeGreaterThanOrEqual(2);
    expect(fired.length % 2).toBe(0); // a request, its answer
  });

  test('status: amounts as decimal strings, the stake, the transfer rule, batches of gas left', async () => {
    s.airdrop[V] = 6n * E18;
    const v = await base.refresh();
    expect(v).toMatchObject({
      error: '', config: 'bundled', round: ROUND,
      identity: { address: identity.evmAddress, eth: '0.1', power: '0', fee: 1000, allowedStaker: zeroAddress, lowEth: false },
      vault: { address: vaultKey.evmAddress, eth: '0.1', satori: '100', stakedWith: zeroAddress, staked: 'none', lock: { locked: false } },
      claimable: { rewards: '0', airdrop: '6' },
    });
    expect(v.identity.batchesLeft).toBe(Number(10n ** 17n / (1_500_000n * 2n * 1_000_000n)));
    rpc.eth[I] = 10n ** 12n;
    expect((await base.refresh()).identity.lowEth).toBe(true);
    expect((await base.status()).lastBatch).toBe(null);
  });

  test('another central: its config is read at once (central2 serves one, prod 404s), not an hour later', async () => {
    central.baseConfig = async () => ({ chainId: 84532, rpcUrl: 'https://sepolia.base.org' }); // as central2: the bundle's values
    expect((await base.refresh()).config).toBe('central');
    central = { ...central, url: 'https://prod.example', baseConfig: async () => { throw new CentralError(404, 'Not Found'); } };
    expect((await base.refresh()).config).toBe('bundled');
  });

  test('settings: the RPC and the max fee are both checked before either is saved; status shows what is stored', async () => {
    expect(await base.status()).toMatchObject({ rpcSetting: '', maxFeeSetting: null, maxFeeGwei: MAX_FEE_GWEI });
    await expect(base.setSettings({ rpc: 'https://rpc.example', maxFee: '-1' })).rejects.toThrow(/positive number of gwei/);
    await expect(base.setSettings({ rpc: 'http://127.0.0.1:8545', maxFee: '0.5' })).rejects.toThrow(/https:\/\/ URL or a path/);
    expect([db.m.get('base_rpc_url'), db.m.get('base_max_fee_gwei')]).toEqual([undefined, undefined]); // nothing half-saved
    expect(await base.setSettings({ rpc: ' https://rpc.example ', maxFee: '0.5' })).toMatchObject({
      rpcSetting: 'https://rpc.example', maxFeeSetting: 0.5, maxFeeGwei: 0.5 });
    expect(await base.setSettings({ maxFee: '' })).toMatchObject({ rpcSetting: 'https://rpc.example', maxFeeSetting: null, maxFeeGwei: MAX_FEE_GWEI });
    expect(await base.setSettings({ rpc: '' })).toMatchObject({ rpcSetting: '' });
  });

  test('work: a check that has something to do, Stake and Claim say each step (src/neuron/work.js)', async () => {
    const seen = [];
    const work = createWork({ onChange: () => { const e = work.current(); if (e) seen.push([e.task, e.step, e.done, e.total].filter((x) => x != null).join(' ')); } });
    base = createBase({ db, identity, vaultAddress: vaultKey.evmAddress, vault: () => vault, central: () => central,
      transport: rpc.transport, now: () => at.t, setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: () => {}, work });
    vault = vaultKey;
    await base.delegate();
    expect(seen).toEqual(['stake send 1 3', 'stake confirm 1 3', 'stake send 2 3', 'stake confirm 2 3',
      'stake send 3 3', 'stake confirm 3 3', 'stake settle']);
    expect(work.current()).toBeNull();
    seen.length = 0;
    await base.predict();
    expect(seen).toEqual(['base check', 'base send', 'base confirm']);
    seen.length = 0;
    const proof = ['0x' + 'ab'.repeat(32)];
    central.root = '0xroot';
    central.proofs[V] = { root: '0xroot', address: V, amountWei: (5n * E18).toString(), amount: 5, proof };
    s.merkle.drop[V] = { amount: 5n * E18, proof };
    s.rewards[V] = 3n * E18;
    await base.claim();
    expect(seen).toEqual(['claim rewards', 'claim confirm', 'claim drop', 'claim confirm']); // no airdrop vested: nothing
    seen.length = 0;
    await base.undelegate();
    await base.send({ asset: 'ETH', to: '0x' + '33'.repeat(20), amount: '0.01' });
    expect(seen).toEqual(['unstake send 1 1', 'unstake confirm 1 1', 'unstake settle', 'send send 1 1', 'send confirm 1 1']);
    expect(work.current()).toBeNull();
  });

  test('vault actions need Unlock', async () => {
    await expect(base.delegate()).rejects.toThrow('Unlock the vault first');
    await expect(base.claim()).rejects.toThrow('Unlock the vault first');
    await expect(base.send({ asset: 'ETH', to: zeroAddress, amount: '1' })).rejects.toThrow('Unlock the vault first');
  });

  test('stake → the identity\'s batch at the next check; unstake → SATORI can be sent once the next round ends', async () => {
    vault = vaultKey;
    base.start();
    const r = await base.delegate();
    expect(r.steps.map((x) => x.step)).toEqual(['setPredictorFee(0)', 'setAllowedDelegator(vault)', 'delegatePredictionPower(identity)']);
    let v = await base.status();
    expect(v.vault).toMatchObject({ staked: 'identity', stakedWith: identity.evmAddress, lock: { locked: true, indefinite: true } });
    expect(v.nextCheck).toBe(at.t + FIRST_CHECK_S);
    await timers.at(-1).fn(); // the check
    await vi.waitFor(() => expect(batchesSent()).toHaveLength(1));
    await vi.waitFor(async () => expect((await base.status()).lastBatch).toMatchObject({ round: ROUND }));
    v = await base.status();
    expect(v.lastCheck).toMatchObject({ round: ROUND, sent: { games: [{ gameId: 1, direction: UP, rule: 'last-move' }] } });
    expect(v.nextCheck).toBe(at.t + CHECK_EVERY_S); // 09:00 on the chain: an hour (the round starts in 15 h)
    expect(await base.predict()).toMatchObject({ skipped: 'already predicted this round' });
    expect(checks).toMatchObject([{ round: ROUND, sent: { round: ROUND } }, { skipped: 'already predicted this round' }]);

    await base.undelegate();
    v = await base.status();
    expect(v.vault).toMatchObject({ staked: 'none', lock: { locked: true, indefinite: false, untilRound: ROUND + 1 } });
    await expect(base.send({ asset: 'SATORI', to: '0x' + '33'.repeat(20), amount: '1' }))
      .rejects.toThrow(`SATORI can be sent from Oct 17, 00:00 UTC (round ${ROUND + 2}).`);
    base.stop();
  });

  test("out of sync: 1 wei sent to the staked vault with its hook skipped; status says so, and Unstake explains, not 'reverted: Panic'", async () => {
    vault = vaultKey;
    await base.delegate();
    expect((await base.refresh()).vault).toMatchObject({ staked: 'identity', inSync: true, shortfall: null });
    s.skipHook(V, 1n); // anyone's 1 wei, sent with the bare gas estimate
    const v = await base.refresh();
    expect(v.vault).toMatchObject({ satori: '100.000000000000000001', inSync: false, shortfall: '0.000000000000000001' });
    expect(v.identity.power).toBe('100');
    await expect(base.undelegate()).rejects.toThrow("Staking is out of sync. Unstaking will fail until the contract fix. Don't add SATORI to the vault.");
    expect(rpc.sent.filter((t) => t.functionName === 'delegatePredictionPower' && t.args[0] === zeroAddress)).toHaveLength(0); // simulated, never sent
    // another staker allowed: not checked
    s.allowed[I] = zeroAddress;
    expect((await base.refresh()).vault).toMatchObject({ inSync: null });
  });

  test("claimable: rewards, the Satori Network's drop (central's proof − alreadyMintedTo, in the status multicall) and the airdrop, and their total", async () => {
    const proof = ['0x' + 'ab'.repeat(32)];
    central.root = '0xroot';
    central.proofs[V] = { root: '0xroot', address: V, amountWei: (5n * E18).toString(), amount: 5, proof };
    s.merkle.drop[V] = { amount: 5n * E18, proof };
    s.merkle.minted[V] = 2n * E18; // claimed in part before
    s.rewards[V] = 3n * E18;
    s.airdrop[V] = E18 / 2n;
    let v = await base.refresh();
    expect(v.claimable).toEqual({ rewards: '3', drop: '3', airdrop: '0.5', total: '6.5' });
    expect(central.calls).toEqual([vaultKey.evmAddress]);
    // cached: asked at most hourly (a new drop comes after central's daily run)
    s.merkle.minted[V] = 5n * E18; // claimed elsewhere: the chain's read follows at once
    expect((await base.refresh()).claimable).toMatchObject({ drop: '0', total: '3.5' });
    expect(central.calls).toHaveLength(1);
    at.t += PROOF_TTL_S;
    central.proofs[V] = { ...central.proofs[V], amountWei: (8n * E18).toString() }; // the next drop: a bigger lifetime entitlement
    expect((await base.refresh()).claimable).toMatchObject({ drop: '3', total: '6.5' });
    expect(central.calls).toHaveLength(2);
    // not in the drop: 0; no drop published: 0; a central without the route (prod on main): unknown (null), not 0, quietly
    for (const [root, drop, total] of [['0xroot2', '0', '3.5'], [null, '0', '3.5'], ['none', null, '3.5']]) {
      central.root = root;
      if (root === '0xroot2') delete central.proofs[V];
      at.t += PROOF_TTL_S;
      v = await base.refresh();
      expect([v.claimable.drop, v.claimable.total, v.error]).toEqual([drop, total, '']);
    }
    // central unreachable: the last answer is kept, and asked again at the next read
    central.root = '0xroot';
    central.proofs[V] = { amountWei: (8n * E18).toString(), proof };
    at.t += PROOF_TTL_S;
    expect((await base.refresh()).claimable.drop).toBe('3');
    const ask = central.merkleProof;
    central.merkleProof = async () => { throw new CentralError(0, 'network', 'Satori Network unreachable: Failed to fetch'); };
    at.t += PROOF_TTL_S;
    expect((await base.refresh()).claimable.drop).toBe('3');
    central.merkleProof = ask;
  });

  test('Claim needs a little Base ETH on the vault: said before trying, nothing sent', async () => {
    vault = vaultKey;
    s.airdrop[V] = 7n * E18;
    rpc.eth[V] = 0n;
    expect((await base.refresh()).vault.lowEth).toBe(true);
    await expect(base.claim()).rejects.toThrow('The vault needs a little Base ETH for gas to claim.');
    expect(rpc.sent).toHaveLength(0);
    rpc.eth[V] = 10n ** 17n;
    expect((await base.refresh()).vault.lowEth).toBe(false);
    expect((await base.claim()).airdrop).toMatchObject({ hash: expect.any(String), amount: '7' });
  });

  test('claims: hub.claim when the lens says > 0, the merkle drop with central\'s proof, the airdrop; each on its own', async () => {
    vault = vaultKey;
    expect(await base.claim()).toEqual({
      rewards: { skipped: 'nothing to claim on-chain' },
      merkle: { skipped: 'no merkle drop published on https://central2.example' },
      airdrop: { skipped: 'no vested airdrop to claim' },
    });
    expect(rpc.sent).toHaveLength(0);
    expect(central.calls).toEqual([vaultKey.evmAddress]); // the proof only, as Lite (routes.py:1321-1331)

    central.root = 'none';
    expect((await base.claim()).merkle).toEqual({ skipped: 'https://central2.example serves no merkle drop (Not Found)' });
    central.root = '0xroot';
    expect((await base.claim()).merkle).toEqual({ skipped: 'this vault is not in the current drop' });

    const proof = ['0x' + 'ab'.repeat(32)];
    central.proofs[V] = { root: '0xroot', address: V, amountWei: (5n * E18).toString(), amount: 5, proof };
    s.merkle.drop[V] = { amount: 5n * E18, proof };
    s.rewards[V] = 3n * E18;
    s.airdrop[V] = 7n * E18;
    const r = await base.claim();
    expect(r).toEqual({
      rewards: { hash: expect.stringMatching(/^0x/), amount: '3' },
      merkle: { hash: expect.stringMatching(/^0x/), amount: '5' },
      airdrop: { hash: expect.stringMatching(/^0x/), amount: '7' },
    });
    expect(rpc.sent.map((t) => t.functionName)).toEqual(['claim', 'claimMerkle', 'claimAirdrop']);
    expect(s.balance[V]).toBe(115n * E18);
    expect((await base.claim()).merkle).toEqual({ skipped: 'already claimed: up to date with the drop' });
  });

  test('a merkle claim the reserve pays in part says what it paid (SatoriMerkle.sol:196-201)', async () => {
    vault = vaultKey;
    const proof = ['0x' + 'ab'.repeat(32)];
    central.root = '0xroot';
    central.proofs[V] = { amountWei: (5n * E18).toString(), proof };
    s.merkle.drop[V] = { amount: 5n * E18, proof };
    s.merkle.available = 2n * E18;
    expect((await base.claim()).merkle).toEqual({ hash: expect.any(String), amount: '2' });
  });

  test('an RPC on another chain: an error, and no writes or batch', async () => {
    const other = { request: async (a) => (a.method === 'eth_chainId' ? '0x2105' : rpc.request(a)) };
    const { custom } = await import('viem');
    const wrong = createBase({ db, identity, vaultAddress: vaultKey.evmAddress, vault: () => vaultKey, central: () => central,
      transport: custom(other), now: () => at.t, setTimeout: () => 0, clearTimeout: () => {} });
    expect((await wrong.refresh()).error).toBe('The RPC is on chain 8453, not Base Sepolia (84532): nothing is read or sent.');
    await expect(wrong.delegate()).rejects.toThrow(/chain 8453/);
    expect(await wrong.predict()).toMatchObject({ error: expect.stringMatching(/chain 8453/) });
    expect(rpc.sent).toHaveLength(0);
  });

  test('a failing claim does not stop the others', async () => {
    vault = vaultKey;
    central.root = '0xroot';
    central.proofs[V] = { amountWei: '5', proof: ['0x' + 'cd'.repeat(32)] }; // a proof the chain refuses
    s.airdrop[V] = 7n;
    const r = await base.claim();
    expect(r.merkle).toEqual({ error: 'reverted: InvalidProof' });
    expect(r.airdrop).toMatchObject({ hash: expect.any(String) });
  });

  test('send: ETH any time, SATORI when free; the inputs are checked', async () => {
    vault = vaultKey;
    const to = '0x' + '44'.repeat(20);
    await expect(base.send({ asset: 'BTC', to, amount: '1' })).rejects.toThrow(/ETH' or 'SATORI/);
    await expect(base.send({ asset: 'ETH', to: 'nope', amount: '1' })).rejects.toThrow(/0x address/);
    await expect(base.send({ asset: 'ETH', to, amount: '-1' })).rejects.toThrow(/positive/);
    await expect(base.send({ asset: 'ETH', to, amount: 'abc' })).rejects.toThrow(/positive/);
    expect(await base.send({ asset: 'eth', to, amount: '0.01' })).toEqual({ hash: expect.any(String) });
    expect(rpc.eth[to]).toBe(10n ** 16n);
    await base.send({ asset: 'SATORI', to, amount: '2.5' });
    expect(s.balance[to]).toBe(25n * E18 / 10n);
    s.lock[V] = INDEFINITE;
    await expect(base.send({ asset: 'SATORI', to, amount: '1' })).rejects.toThrow("Staked SATORI can't be sent until you unstake.");
  });
});
