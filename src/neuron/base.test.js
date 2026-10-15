// The Base flow (docs/design/base.md): the daily batch's rules, the schedule,
// delegate, claims and sends, against fake-satori.js (viem over a custom
// transport) and a Map for the database.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { publicKeys, evmAddress, signDigest } from '../keys/keys.js';
import { fakeSatori, E18, INDEFINITE } from '../chain/fake-satori.js';
import { CentralError } from '../central/index.js';
import { UP, DOWN, ROUND_S } from '../chain/index.js';
import {
  createBase, runBatch, stepFor, directionOf, namedAllowed, nextCheckAt, toPoints, FIRST_CHECK_S, CHECK_EVERY_S,
} from './base.js';

const signerOf = (hex) => {
  const secret = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return { evmAddress: evmAddress(publicKeys(secret).pubkey), signDigest: (h) => signDigest(secret, h) };
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
const up = (pts) => ({ model: 'test', t1: pts.at(-1).value * 2, t2: pts.at(-1).value * 2 }); // a forecast that says UP

let s, rpc, db, chainOf;
beforeEach(async () => {
  ({ s, rpc } = fakeSatori({ round: ROUND, hour: 9, eth: { [I]: 10n ** 17n, [V]: 10n ** 17n } }));
  s.balance[V] = 100n * E18;
  db = memDb();
  const { createChain } = await import('../chain/index.js');
  const { DEFAULTS } = await import('../chain/config.js');
  chainOf = () => createChain({ config: DEFAULTS, transport: rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 } });
});
const delegated = async () => { await chainOf().delegate({ identity, vault: vaultKey }); rpc.sent.length = 0; };
const batchesSent = () => rpc.sent.filter((t) => t.functionName === 'predictMultipleWithPayloads').map((t) => t.args[0]);

describe('rules', () => {
  test('the engine\'s step: 12 h, or the stream\'s cadence when slower (the default stream is daily)', () => {
    expect(stepFor(60)).toBe(43_200);
    expect(stepFor(720)).toBe(43_200);
    expect(stepFor(1440)).toBe(86_400);
    expect(stepFor(0)).toBe(43_200);
  });
  test('direction as Lite\'s direction_from: UP above the latest, else DOWN (a tie is DOWN)', () => {
    expect([directionOf(2, 1), directionOf(1, 1), directionOf(0.5, 1)]).toEqual([UP, DOWN, DOWN]);
  });
  test('named games: 24 clock hours after our last submit, as Lite\'s named_allowed', () => {
    const last = H0 * 3600 + 14 * 3600 + 1800; // 14:30
    expect(namedAllowed(0, last)).toBe(true);
    expect(namedAllowed(last, last + 23 * 3600)).toBe(false); // 13:30 the next day
    expect(namedAllowed(last, last + 23.5 * 3600)).toBe(true); // 14:00 the next day: the same clock hour
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

describe('the daily batch', () => {
  test('not delegated: skipped, nothing sent', async () => {
    const r = await runBatch({ chain: chainOf(), identity, db });
    expect(r).toEqual({ at: ROUND * ROUND_S + 9 * 3600, round: ROUND, skipped: 'no prediction power delegated to the identity' });
    expect(rpc.sent).toHaveLength(0);
  });

  test('delegated: the default stream with the engine (naive on two points → DOWN), one tx, persisted after the receipt', async () => {
    await delegated();
    const r = await runBatch({ chain: chainOf(), identity, db });
    expect(batchesSent()).toEqual([[{ gameId: 1, payload: '0x02' }]]);
    const batch = { round: ROUND, at: ROUND * ROUND_S + 9 * 3600, hash: rpc.sent[0].hash, dropped: [],
      games: [{ streamId: 1, gameId: 1, named: false, direction: DOWN, model: 'naive', latest: 59058240589371161, t2: 59058240589371161 }] };
    expect(r).toEqual({ at: batch.at, round: ROUND, sent: batch });
    expect(db.m.get('base_last_batch')).toEqual(batch);
    expect(db.m.get('base_last_submit_ts')).toBe(batch.at);
    expect(db.checkpoint).toHaveBeenCalled();
    expect(await runBatch({ chain: chainOf(), identity, db })).toMatchObject({ skipped: 'already predicted this round' });
    expect(rpc.sent).toHaveLength(1);
  });

  test('each game is simulated alone: a stale one is dropped and the rest go (Lite sinks the whole batch)', async () => {
    await delegated();
    s.streams[3] = { game: 13, named: false, cadence: 60, history: [{ hour: H0 + 1, value: 10n }, { hour: H0 + 2, value: 11n }] };
    s.streams[4] = { game: 14, named: false, cadence: 60, history: [{ hour: H0 + 1, value: 7n }] };
    s.deadGames[14] = 'StaleValue';
    const r = await runBatch({ chain: chainOf(), identity, db, forecast: up });
    expect(batchesSent()).toEqual([[{ gameId: 1, payload: '0x01' }, { gameId: 13, payload: '0x01' }]]);
    expect(r.sent.dropped).toEqual([expect.objectContaining({ streamId: 4, gameId: 14, error: 'StaleValue' })]);
  });

  test('a named game waits 24 clock hours after our last batch; the others go without it', async () => {
    await delegated();
    s.streams[5] = { game: 15, named: true, cadence: 60, history: [{ hour: H0 + 1, value: 3n }] };
    db.m.set('base_last_submit_ts', ROUND * ROUND_S - 2 * 3600); // 22:00 yesterday; now 09:00
    const r = await runBatch({ chain: chainOf(), identity, db, forecast: up });
    expect(batchesSent()).toEqual([[{ gameId: 1, payload: '0x01' }]]);
    expect(r.sent.dropped).toEqual([expect.objectContaining({ gameId: 15, error: 'named: under 24 h since the last batch' })]);
  });

  test('nothing passes: no transaction, the reasons listed', async () => {
    await delegated();
    s.deadGames[1] = 'EmptyStream';
    const r = await runBatch({ chain: chainOf(), identity, db });
    expect(r).toMatchObject({ round: ROUND, skipped: 'no game passes its simulation', dropped: [{ gameId: 1, error: 'EmptyStream' }] });
    expect(rpc.sent).toHaveLength(0);
    expect(db.m.has('base_last_batch')).toBe(false);
  });

  test('the chain says DuplicatePrediction for the batch: resent once without the named games (base_predict.py:157-174)', async () => {
    const sends = [];
    const dup = Object.assign(new Error('dup'), { name: 'X' });
    const chain = {
      batchState: async () => ({ round: ROUND, chainTime: 100, power: 1n, predicted: 0 }),
      streams: async () => [{ streamId: 1, gameId: 1, named: false, cadenceMinutes: 1440 }, { streamId: 2, gameId: 2, named: true, cadenceMinutes: 60 }],
      history: async () => [{ hour: 1, value: 5n }],
      simulateGame: async () => null,
      sendBatch: async (_, list) => {
        sends.push(list.map((g) => g.gameId));
        if (list.some((g) => g.named)) throw dup;
        return { hash: '0xh', at: 200, blockNumber: 1 };
      },
    };
    const { revertName } = await import('../chain/index.js');
    expect(revertName(dup)).toBe(null); // a plain error is not a revert: rethrown
    expect(await runBatch({ chain, identity, db })).toMatchObject({ error: 'dup' });
    expect(db.m.has('base_last_submit_ts')).toBe(false); // a failed send loses nothing (Lite wrote it before sending)

    const { BaseError, ContractFunctionRevertedError, ContractFunctionExecutionError } = await import('viem');
    const { engineAbi } = await import('../chain/abi.js');
    const reverted = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: engineAbi, data: '0xe372c20e', functionName: 'predictMultipleWithPayloads' }),
      { abi: engineAbi, functionName: 'predictMultipleWithPayloads', args: [] });
    expect(reverted).toBeInstanceOf(BaseError);
    chain.sendBatch = async (_, list) => {
      sends.push(list.map((g) => g.gameId));
      if (list.some((g) => g.named)) throw reverted;
      return { hash: '0xh', at: 200, blockNumber: 1 };
    };
    sends.length = 0;
    const r = await runBatch({ chain, identity, db });
    expect(sends).toEqual([[1, 2], [1]]);
    expect(r.sent).toMatchObject({ hash: '0xh', games: [{ gameId: 1 }], dropped: [{ gameId: 2, error: 'DuplicatePrediction' }] });
    expect(db.m.get('base_last_submit_ts')).toBe(200);
  });

  test('an RPC failure is an error for this check, not a dropped game', async () => {
    await delegated();
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
  beforeEach(() => {
    vault = null;
    central = {
      url: 'https://central2.example', root: null, proofs: {},
      baseConfig: async () => { throw new CentralError(404, 'Not Found'); },
      merkleRoot: async () => {
        if (!central.root) throw new CentralError(404, 'no reward drop has been published yet');
        return { root: central.root };
      },
      merkleProof: async (a) => {
        const p = central.proofs[a.toLowerCase()];
        if (!p) throw new CentralError(404, `${a} is not in the current drop`);
        return p;
      },
    };
    timers.length = 0;
    base = createBase({ db, identity, vaultAddress: () => vaultKey.evmAddress, vault: () => vault, central: () => central,
      transport: rpc.transport, now: () => at.t, setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: () => {} });
  });

  test('status: amounts as decimal strings, the delegation, the lock, batches of gas left', async () => {
    s.airdrop[V] = 6n * E18;
    const v = await base.refresh();
    expect(v).toMatchObject({
      error: '', config: 'bundled', round: ROUND,
      identity: { address: identity.evmAddress, eth: '0.1', power: '0', fee: 1000, lowEth: false },
      vault: { address: vaultKey.evmAddress, eth: '0.1', satori: '100', delegated: 'none', lock: { locked: false } },
      claimable: { rewards: '0', airdrop: '6' },
    });
    expect(v.identity.batchesLeft).toBe(Number(10n ** 17n / (1_500_000n * 2n * 1_000_000n)));
    rpc.eth[I] = 10n ** 12n;
    expect((await base.refresh()).identity.lowEth).toBe(true);
    expect((await base.status()).lastBatch).toBe(null);
  });

  test('vault actions need Unlock', async () => {
    await expect(base.delegate()).rejects.toThrow('Unlock the vault first');
    await expect(base.claim()).rejects.toThrow('Unlock the vault first');
    await expect(base.send({ asset: 'ETH', to: zeroAddress, amount: '1' })).rejects.toThrow('Unlock the vault first');
  });

  test('delegate → the identity\'s batch at the next check; stop → transfer-locked until the next round', async () => {
    vault = vaultKey;
    base.start();
    const r = await base.delegate();
    expect(r.steps.map((x) => x.step)).toEqual(['setPredictorFee(0)', 'setAllowedDelegator(vault)', 'delegatePredictionPower(identity)']);
    let v = await base.status();
    expect(v.vault).toMatchObject({ delegated: 'identity', lock: { locked: true, indefinite: true } });
    expect(v.nextCheck).toBe(at.t + FIRST_CHECK_S);
    await timers.at(-1).fn(); // the check
    await vi.waitFor(() => expect(batchesSent()).toHaveLength(1));
    await vi.waitFor(async () => expect((await base.status()).lastBatch).toMatchObject({ round: ROUND }));
    v = await base.status();
    expect(v.lastCheck).toMatchObject({ round: ROUND, sent: { games: [{ gameId: 1, direction: DOWN }] } });
    expect(v.nextCheck).toBe(at.t + CHECK_EVERY_S); // 09:00 on the chain: an hour (the round starts in 15 h)
    expect(await base.predict()).toMatchObject({ skipped: 'already predicted this round' });

    await base.undelegate();
    v = await base.status();
    expect(v.vault).toMatchObject({ delegated: 'none', lock: { locked: true, indefinite: false, untilRound: ROUND + 1 } });
    await expect(base.send({ asset: 'SATORI', to: '0x' + '33'.repeat(20), amount: '1' }))
      .rejects.toThrow(`SATORI is transfer-locked until round ${ROUND + 1} (free from ${new Date((ROUND + 2) * ROUND_S * 1000).toISOString().slice(0, 16)} UTC).`);
    base.stop();
  });

  test('claims: hub.claim when the lens says > 0, the merkle drop with central\'s proof, the airdrop; each on its own', async () => {
    vault = vaultKey;
    expect(await base.claim()).toEqual({
      rewards: { skipped: 'nothing to claim on-chain' },
      merkle: { skipped: 'no merkle drop published (https://central2.example: no reward drop has been published yet)' },
      airdrop: { skipped: 'no vested airdrop to claim' },
    });
    expect(rpc.sent).toHaveLength(0);

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
    await expect(base.send({ asset: 'SATORI', to, amount: '1' })).rejects.toThrow(/while delegated: stop delegating first/);
  });
});
