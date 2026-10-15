import { beforeEach, describe, expect, test } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { zeroAddress } from 'viem';
import * as abi from './abi.js';
import { DEFAULTS } from './config.js';
import { fakeRpc, revert } from './fake-rpc.js';
import { GATE, createChain, toObservation } from './index.js';

const identity = privateKeyToAccount('0x' + '11'.repeat(32));
const vault = privateKeyToAccount('0x' + '22'.repeat(32));
const I = identity.address.toLowerCase();
const V = vault.address.toLowerCase();
const ROUND = 20741n;
const E18 = 10n ** 18n;

/** A small stateful Satori deployment. */
function world() {
  const s = {
    streams: [1, 2, 3, 4],
    games: { 1: 11, 2: 0, 3: 13, 4: 14 },
    // stream 1: 600 hourly values (spans 3 pages), stream 3: 2 values
    history: {
      1: Array.from({ length: 600 }, (_, i) => ({ hour: 497000 + i, value: BigInt(i) * E18 })),
      3: [{ hour: 497700, value: -5n }, { hour: 497701, value: 7n }],
      4: [],
    },
    badGames: { 14: 'EmptyStream' },
    predicted: {}, // `${addr}:${round}` → count
    delegate: {}, // addr → {delegate, power}
    fee: { [I]: 500 },
    unclaimed: { [V]: 3n * E18, [I]: 0n },
    lock: { [V]: 0 },
    balance: { [V]: 300n * E18 },
    minted: { [V]: 40n },
    airdrop: { [V]: { allocation: 100n, claimed: 10n, claimable: 30n } },
  };
  const info = (a) => s.delegate[a] ?? { delegate: zeroAddress, power: 0n };
  const fns = (abiItems, f) => ({ abi: abiItems, fns: f });
  const contracts = {
    [DEFAULTS.registry]: fns(abi.registryAbi, {
      getAllDataStreams: () => s.streams,
      getHistoryPage: ([id, offset, limit]) => {
        const h = s.history[id] ?? [];
        const total = h.length;
        if (offset >= BigInt(total)) return [[], [], total];
        const end = total - Number(offset);
        const page = h.slice(Math.max(0, end - Number(limit)), end);
        return [page.map((e) => e.value), page.map((e) => e.hour), total];
      },
      getLatestUpdateInfo: ([id]) => {
        const h = s.history[id] ?? [];
        return [h.length, BigInt(h.at(-1)?.hour ?? 0), BigInt((h.at(-1)?.hour ?? 0) * 3600), 60];
      },
    }),
    [DEFAULTS.games]: fns(abi.gamesAbi, { binaryGameByStream: ([id]) => s.games[id] ?? 0 }),
    [DEFAULTS.engine]: fns(abi.engineAbi, {
      predictedStreamsCount: ([a, r]) => BigInt(s.predicted[`${a.toLowerCase()}:${r}`] ?? 0),
      predictMultipleWithPayloads: ([reqs], ctx) => {
        if (s.rpcDown) throw new Error('upstream 503');
        for (const r of reqs) if (s.badGames[r.gameId]) revert(s.badGames[r.gameId]);
        if (ctx.write) s.predicted[`${ctx.from}:${ROUND}`] = reqs.length;
      },
    }),
    [DEFAULTS.rewards]: fns(abi.rewardsAbi, {
      predictionDelegateInfo: ([a]) => { const d = info(a.toLowerCase()); return [d.delegate, d.power]; },
      effectivePredictorFee: ([a]) => s.fee[a.toLowerCase()] ?? 0,
      setPredictorFee: ([bps], ctx) => { if (ctx.write) s.fee[ctx.from] = bps; },
      unclaimedRewards: ([a]) => s.unclaimed[a.toLowerCase()] ?? 0n,
    }),
    [DEFAULTS.hub]: fns(abi.hubAbi, {
      delegatePredictionPower: ([to], ctx) => {
        if (s.refuseDelegation) revert('Unauthorized');
        if (!ctx.write) return;
        const prev = info(ctx.from).delegate.toLowerCase();
        if (prev !== zeroAddress) s.delegate[prev] = { ...info(prev), power: 0n };
        s.delegate[ctx.from] = { ...info(ctx.from), delegate: to };
        if (to !== zeroAddress) s.delegate[to.toLowerCase()] = { ...info(to.toLowerCase()), power: s.balance[ctx.from] };
        s.lock[ctx.from] = to === zeroAddress ? Number(ROUND) + 1 : 2 ** 24 - 1;
      },
      claim: (_, ctx) => {
        if (ctx.from === '0x' + '99'.repeat(20)) revert('Unauthorized');
        const amt = s.unclaimed[ctx.from] ?? 0n;
        if (ctx.write) s.unclaimed[ctx.from] = 0n;
        return amt;
      },
    }),
    [DEFAULTS.token]: fns(abi.tokenAbi, {
      balanceOf: ([a]) => s.balance[a.toLowerCase()] ?? 0n,
      transferLockedUntil: ([a]) => s.lock[a.toLowerCase()] ?? 0,
    }),
    [DEFAULTS.merkle]: fns(abi.merkleAbi, {
      alreadyMintedTo: ([a]) => s.minted[a.toLowerCase()] ?? 0n,
      claimMerkle: ([amount], ctx) => { if (ctx.write) s.minted[ctx.from] = amount; },
    }),
    [DEFAULTS.airdrop]: fns(abi.airdropAbi, {
      airdropAllocation: ([a]) => s.airdrop[a.toLowerCase()]?.allocation ?? 0n,
      airdropClaimed: ([a]) => s.airdrop[a.toLowerCase()]?.claimed ?? 0n,
      claimableAirdrop: ([a]) => s.airdrop[a.toLowerCase()]?.claimable ?? 0n,
      claimAirdrop: (_, ctx) => { if (ctx.write) s.airdrop[ctx.from].claimable = 0n; },
    }),
  };
  const rpc = fakeRpc(contracts, { timestamp: ROUND * 86400n + 3600n, eth: { [V]: 5n * 10n ** 15n, [I]: 10n ** 14n } });
  return { s, rpc };
}

let s, rpc, chain;
beforeEach(() => {
  ({ s, rpc } = world());
  chain = createChain({ config: DEFAULTS, transport: rpc.transport, pollingInterval: 1 });
});

describe('reads', () => {
  test('round = latest block timestamp / 86400', async () => {
    expect(await chain.round()).toBe(Number(ROUND));
  });

  test('baseGames: every registry stream with a non-zero binary game, in one multicall', async () => {
    expect(await chain.baseGames()).toEqual([
      { streamId: 1, gameId: 11 }, { streamId: 3, gameId: 13 }, { streamId: 4, gameId: 14 },
    ]);
    expect(rpc.log.filter((m) => m === 'eth_call')).toHaveLength(2); // getAllDataStreams + one multicall
  });

  test('history: the whole ring buffer, oldest first, across pages', async () => {
    const h = await chain.history(1);
    expect(h).toHaveLength(600);
    expect(h[0]).toEqual({ hour: 497000, value: 0n });
    expect(h.at(-1)).toEqual({ hour: 497599, value: 599n * E18 });
  });

  test('history since an hour: only newer entries, stops paging early', async () => {
    const calls = rpc.log.length;
    const h = await chain.history(1, 497597);
    expect(h.map((e) => e.hour)).toEqual([497598, 497599]);
    expect(rpc.log.slice(calls).filter((m) => m === 'eth_call')).toHaveLength(1);
  });

  test('history of an empty stream', async () => {
    expect(await chain.history(4)).toEqual([]);
  });

  test('latestInfo: one multicall for all games', async () => {
    const before = rpc.log.length;
    expect(await chain.latestInfo([1, 3])).toEqual([
      { streamId: 1, count: 600, latestHour: 497599, lastUpdateTimestamp: 497599 * 3600 },
      { streamId: 3, count: 2, latestHour: 497701, lastUpdateTimestamp: 497701 * 3600 },
    ]);
    expect(rpc.log.slice(before).filter((m) => m === 'eth_call')).toHaveLength(1);
  });

  test('toObservation: a registry entry as an observations row (provider base, round = hour)', () => {
    expect(toObservation(3, { hour: 497700, value: -5n }, 1.5)).toEqual({
      stream_name: '3', provider_pubkey: 'base', seq_num: 497700, observed_at: 497700 * 3600,
      received_at: 1.5, value_raw: '-5', value: -5, round: 497700,
    });
  });

  test('balances: ETH and SATORI for vault and identity, and the 250 gate', async () => {
    const b = await chain.balances({ vault: V, identity: I });
    expect(b).toEqual({
      vault: { eth: 5n * 10n ** 15n, satori: 300n * E18 },
      identity: { eth: 10n ** 14n, satori: 0n },
      gate: { required: GATE, met: true },
    });
    expect(rpc.log.filter((m) => m === 'eth_call')).toHaveLength(1);
    s.balance[V] = 249n * E18;
    expect((await chain.balances({ vault: V, identity: I })).gate.met).toBe(false);
  });
});

describe('delegate / revoke', () => {
  test('status before: not delegated, fee set, unlocked', async () => {
    expect(await chain.delegationStatus({ vault: V, identity: I })).toEqual({
      delegated: false, delegate: zeroAddress, power: 0n, identityFee: 500,
      lockedUntilRound: 0, lockedIndefinitely: false, round: Number(ROUND),
    });
  });

  test('delegate: identity zeroes its fee, then the vault delegates; status flips', async () => {
    const r = await chain.delegate({ vault, identity });
    expect(rpc.sent.map((t) => [t.from, t.functionName, t.args])).toEqual([
      [I, 'setPredictorFee', [0]],
      [V, 'delegatePredictionPower', [identity.address]],
    ]);
    expect(r.feeTx).toBe(rpc.sent[0].hash);
    expect(r.delegateTx).toBe(rpc.sent[1].hash);
    const st = await chain.delegationStatus({ vault: V, identity: I });
    expect(st).toMatchObject({ delegated: true, power: 300n * E18, identityFee: 0, lockedIndefinitely: true });
  });

  test('delegate is idempotent: nothing sent when already in place', async () => {
    await chain.delegate({ vault, identity });
    const n = rpc.sent.length;
    expect(await chain.delegate({ vault, identity })).toEqual({});
    expect(rpc.sent).toHaveLength(n);
  });

  test('accounts may be given as private keys', async () => {
    await chain.delegate({ vault: '0x' + '22'.repeat(32), identity: '0x' + '11'.repeat(32) });
    expect(rpc.sent.map((t) => t.from)).toEqual([I, V]);
  });

  test('revoke: vault delegates to 0x0; transfers locked until next round', async () => {
    await chain.delegate({ vault, identity });
    const r = await chain.revoke(vault);
    expect(rpc.sent.at(-1)).toMatchObject({ from: V, functionName: 'delegatePredictionPower', args: [zeroAddress] });
    expect(r.revokeTx).toBe(rpc.sent.at(-1).hash);
    expect(await chain.delegationStatus({ vault: V, identity: I })).toMatchObject({
      delegated: false, lockedUntilRound: Number(ROUND) + 1, lockedIndefinitely: false,
    });
    expect(await chain.revoke(vault)).toEqual({});
  });

  test('a write that would revert throws before anything is sent', async () => {
    s.fee[I] = 0;
    s.refuseDelegation = true;
    await expect(chain.delegate({ vault, identity })).rejects.toThrow();
    expect(rpc.sent).toHaveLength(0);
  });

  test('the read lags behind the receipt (load-balanced RPC): poll until it flips', async () => {
    let lag = 3;
    const real = s.delegate;
    s.delegate = new Proxy(real, { get: (t, k) => (k === V && lag-- > 0 ? undefined : t[k]) });
    s.fee[I] = 0;
    await chain.delegate({ vault, identity });
    expect(lag).toBeLessThanOrEqual(0);
  });
});

describe('daily batch', () => {
  const preds = [{ gameId: 11, direction: 1 }, { gameId: 13, direction: 2 }, { gameId: 14, direction: 1 }];

  test('not due without delegated power', async () => {
    expect(await chain.batchDue(I)).toEqual({ due: false, round: Number(ROUND), reason: 'no-power' });
  });

  test('due when delegated and this round has no batch; not due after one', async () => {
    await chain.delegate({ vault, identity });
    expect(await chain.batchDue(I)).toEqual({ due: true, round: Number(ROUND), reason: null });
    await chain.submitBatch(identity, preds);
    expect(await chain.batchDue(I)).toEqual({ due: false, round: Number(ROUND), reason: 'submitted' });
  });

  test('simulates each game, drops the failing ones, sends the rest in one tx', async () => {
    s.badGames[13] = 'StaleValue';
    let before = null;
    const r = await chain.submitBatch(identity, preds, { beforeSend: (games) => { before = { games, sent: rpc.sent.length }; } });
    expect(r.dropped).toEqual([{ gameId: 13, direction: 2, error: 'StaleValue' }, { gameId: 14, direction: 1, error: 'EmptyStream' }]);
    expect(r.sent).toEqual([{ gameId: 11, direction: 1 }]);
    expect(r.round).toBe(Number(ROUND));
    expect(before).toEqual({ games: [{ gameId: 11, direction: 1 }], sent: 0 }); // hook runs before the send
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.sent[0]).toMatchObject({ from: I, functionName: 'predictMultipleWithPayloads', hash: r.hash });
    expect(rpc.sent[0].args[0]).toEqual([{ gameId: 11, payload: '0x01' }]);
    expect(await chain.receipt(r.hash)).toBe('success');
  });

  test('all games fail → nothing sent, no hook', async () => {
    let called = false;
    const r = await chain.submitBatch(identity, [{ gameId: 14, direction: 1 }], { beforeSend: () => { called = true; } });
    expect(r).toMatchObject({ hash: null, sent: [] });
    expect(called).toBe(false);
    expect(rpc.sent).toHaveLength(0);
  });

  test('an RPC failure during the simulate is not a dropped game: it throws', async () => {
    s.rpcDown = true;
    await expect(chain.submitBatch(identity, preds.slice(0, 2))).rejects.toThrow();
    expect(rpc.sent).toHaveLength(0);
  });

  test('payload is the single direction byte, 0x01 UP / 0x02 DOWN', async () => {
    await chain.submitBatch(identity, preds.slice(0, 2));
    expect(rpc.sent[0].args[0]).toEqual([{ gameId: 11, payload: '0x01' }, { gameId: 13, payload: '0x02' }]);
  });
});

describe('claims', () => {
  test('merkle: claimable = entitlement − already minted; vault claims with the proof', async () => {
    const p = { amountWei: '100', proof: ['0x' + '22'.repeat(32)] };
    expect(await chain.merkleStatus(V, p)).toEqual({ entitlement: 100n, alreadyMinted: 40n, claimable: 60n });
    const hash = await chain.claimMerkle(vault, p);
    expect(rpc.sent[0]).toMatchObject({ from: V, functionName: 'claimMerkle', args: [100n, p.proof], hash });
    expect((await chain.merkleStatus(V, p)).claimable).toBe(0n);
  });

  test('merkle: never negative', async () => {
    expect((await chain.merkleStatus(V, { amountWei: '10' })).claimable).toBe(0n);
  });

  test('airdrop status and claim', async () => {
    expect(await chain.airdropStatus(V)).toEqual({ allocation: 100n, claimed: 10n, claimable: 30n });
    const hash = await chain.claimAirdrop(vault);
    expect(rpc.sent[0]).toMatchObject({ from: V, functionName: 'claimAirdrop', hash });
  });

  test('on-chain rewards: vault amount by simulating hub.claim, identity bucket read', async () => {
    s.unclaimed[I] = 7n;
    expect(await chain.rewardsStatus({ vault: V, identity: I })).toEqual({ vault: 3n * E18, identity: 7n });
    expect(rpc.sent).toHaveLength(0);
  });

  test('on-chain rewards: a reverting simulate reads as null, not a throw', async () => {
    expect((await chain.rewardsStatus({ vault: '0x' + '99'.repeat(20), identity: I })).vault).toBe(null);
  });

  test('hub.claim() from the vault', async () => {
    const hash = await chain.claimRewards(vault);
    expect(rpc.sent[0]).toMatchObject({ from: V, to: DEFAULTS.hub.toLowerCase(), functionName: 'claim', args: undefined, hash });
    expect((await chain.rewardsStatus({ vault: V, identity: I })).vault).toBe(0n);
  });
});
