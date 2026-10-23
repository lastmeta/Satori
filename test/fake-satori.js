// Test double (never imported by the app): a small, stateful Satori D7 on
// fake-rpc.js, with the rules the app depends on (docs/design/base.md):
// the engine's batch checks (C/next/SatoriEngine.sol:698-810), staking (delegatePredictionPower) and
// its locks (C/next/SatoriHub.sol:426-434,813-877), the set-once predictor fee
// (C/SatoriRewards.sol:119-143,651-669), the token's transfer lock
// (C/next/SatoriToken.sol:816-821), the registry's history page
// (C/SatoriRegistry.sol:1375-1393), claims (hub, merkle, airdrop).
// Unit tests (src/chain, src/neuron) and the e2e (/rpc) share it.
import { zeroAddress } from 'viem';
import * as abi from '../src/chain/abi.js';
import { DEFAULTS } from '../src/chain/config.js';
import { INDEFINITE, HISTORY } from '../src/chain/index.js';
import { fakeRpc, revert, panic } from './fake-rpc.js';

export const E18 = 10n ** 18n;

const lc = (a) => a.toLowerCase();

/**
 * @param {{round?: number, hour?: number, eth?: Record<string, bigint>}} [opts]
 * @returns {{ s: object, rpc: ReturnType<typeof fakeRpc> }} s is the state to arrange and inspect
 */
export function fakeSatori({ round = 20741, hour = 9, eth = {} } = {}) {
  const s = {
    // streams: id → { game, named, cadence (minutes), history: [{hour, value}] }; stream 1 is the default stream
    streams: {
      1: { game: 1, named: false, cadence: 1440, history: [{ hour: (round - 1) * 24, value: 0n }, { hour: round * 24, value: 59058240589371161n }] },
    },
    deadGames: {}, // gameId → error name ('' = none): a game that always reverts (a stale bridge, say)
    predicted: {}, // `${addr}:${round}` → games in the batch
    lastPred: {}, // `${addr}:${gameId}` → hour
    batches: [], // [{ from, round, hour, requests }]
    delegateOf: {}, // addr → delegate
    feeStored: {}, // addr → bps (0 = never set: the 10 % default)
    allowed: {}, // addr → the one vault it accepts (allowedDelegator)
    referral: {}, // addr → its referrer (set once)
    lock: {}, // addr → round (transferLockedUntil)
    balance: {}, // SATORI
    rewards: {}, // what the lens says the address can claim with hub.claim()
    airdrop: {}, // vested and unclaimed
    merkle: { drop: {}, minted: {}, available: null }, // drop: addr → { amount, proof }; available: the lane's reserve (null: plenty)
    weights: { 1: E18 }, // gameId → voting weight (the engine pays only games with weight, SatoriEngine.sol:828)
    short: {}, // delegate → SATORI its stakers received with the transfer hook skipped (the token-hook bug): power under their balance
  };
  const powerOf = (a) => Object.entries(s.delegateOf).filter(([, d]) => d === a).reduce((n, [x]) => n + (s.balance[x] ?? 0n), 0n) - (s.short[a] ?? 0n);
  /** SATORI to a staked address in a transaction whose hook ran out of gas: the balance moves, the booked power does not. */
  s.skipHook = (to, amount) => {
    const a = lc(to);
    s.balance[a] = (s.balance[a] ?? 0n) + amount;
    const d = s.delegateOf[a];
    if (d && d !== zeroAddress) s.short[d] = (s.short[d] ?? 0n) + amount;
  };
  const fee = (a) => ({ 0: 1000, 1000: 0 })[s.feeStored[a] ?? 0] ?? s.feeStored[a];
  const latestHour = (st) => st.history.at(-1)?.hour ?? 0;

  /** The default stream is written by the round's first predict (flushDefaultStream, SatoriEngine.sol:619-638). */
  function flush(ctx) {
    const st = s.streams[1];
    if (st && latestHour(st) < ctx.round * 24) {
      const v = { hour: ctx.round * 24, value: Object.values(s.predicted).length ? 1n : 0n };
      if (ctx.write) st.history.push(v);
      return v.hour;
    }
    return st ? latestHour(st) : 0;
  }

  function predict([requests], ctx) {
    const flushed = flush(ctx);
    if (!requests.length) revert('EmptyBatch');
    if (s.delegateOf[ctx.from] && s.delegateOf[ctx.from] !== zeroAddress) revert('Delegated');
    if (s.predicted[`${ctx.from}:${ctx.round}`]) revert('AlreadyPredicted');
    const byGame = Object.fromEntries(Object.entries(s.streams).map(([id, st]) => [st.game, { id: Number(id), ...st }]));
    requests.forEach((r, i) => {
      if (r.payload === '0x') revert('BadDirection');
      if (!byGame[r.gameId]) revert('UnknownStream');
      if (requests.slice(0, i).some((q) => q.gameId === r.gameId)) revert('DuplicatePrediction');
    });
    for (const r of requests) {
      const st = byGame[r.gameId];
      if (r.gameId in s.deadGames) revert(s.deadGames[r.gameId]); // '' = a bare revert
      const latest = st.id === 1 ? flushed : latestHour(st);
      if (!st.history.length && st.id !== 1) revert('EmptyStream');
      const last = s.lastPred[`${ctx.from}:${r.gameId}`];
      if (last) {
        if (Math.floor(last / 24) === ctx.round) revert('DuplicatePrediction');
        if (st.named && ctx.hour < last + 24) revert('DuplicatePrediction');
        if (latest <= last) revert('StaleValue');
      }
    }
    if (!ctx.write) return;
    s.predicted[`${ctx.from}:${ctx.round}`] = requests.length;
    for (const r of requests) s.lastPred[`${ctx.from}:${r.gameId}`] = ctx.hour;
    s.batches.push({ from: ctx.from, round: ctx.round, hour: ctx.hour, requests });
  }

  function delegate([to], ctx) {
    const user = ctx.from;
    let d = lc(to);
    if (d === user) d = zeroAddress;
    if (d !== zeroAddress && s.allowed[d] && s.allowed[d] !== zeroAddress && s.allowed[d] !== user) revert('DelegatorNotAllowed');
    const current = s.delegateOf[user] ?? zeroAddress;
    if (current === zeroAddress && (s.lock[user] ?? 0) > ctx.round && d !== zeroAddress) revert('Locked');
    if (current !== zeroAddress && d !== zeroAddress && s.predicted[`${current}:${ctx.round}`]) revert('DelegateActive');
    // leaving subtracts the live balance from the booked power (SatoriRewards.sol:1884): under it, Panic 0x11
    if (current !== zeroAddress && (s.short[current] ?? 0n) > 0n) panic(0x11);
    if (!ctx.write) return;
    s.delegateOf[user] = d;
    if (d !== zeroAddress) s.lock[user] = INDEFINITE;
    else if (current !== zeroAddress) s.lock[user] = ctx.round + 1; // lockUntilNextRound
  }

  const fns = (a, f) => ({ abi: a, fns: f });
  const contracts = {
    [DEFAULTS.engine]: fns(abi.engineAbi, {
      predictMultipleWithPayloads: predict,
      predictedStreamsCount: ([a, r]) => BigInt(s.predicted[`${lc(a)}:${r}`] ?? 0),
    }),
    [DEFAULTS.games]: fns(abi.gamesAbi, { binaryGameByStream: ([id]) => s.streams[id]?.game ?? 0 }),
    [DEFAULTS.registry]: fns(abi.registryAbi, {
      getAllDataStreams: () => Object.keys(s.streams).map(Number),
      getLatestUpdateInfo: ([id]) => {
        const st = s.streams[id];
        return [st?.history.length ?? 0, BigInt(st ? latestHour(st) : 0), BigInt(st ? latestHour(st) * 3600 : 0), st?.cadence ?? 0,
          st?.named ?? false, BigInt(st?.history.at(-1)?.value ?? 0)];
      },
      getHistoryPage: ([id, offset, limit]) => {
        const h = (s.streams[id]?.history ?? []).slice(-HISTORY);
        const total = h.length;
        if (limit === 0n || offset >= BigInt(total)) return [[], [], total];
        const take = Math.min(total - Number(offset), Number(limit));
        const page = h.slice(total - Number(offset) - take, total - Number(offset));
        return [page.map((e) => e.value), page.map((e) => e.hour), total];
      },
      isNamedStream: ([id]) => (s.streams[id] && !s.streams[id].namedReverts ? s.streams[id].named : revert()), // reverts for an unknown id (D6 and D7)
    }),
    [DEFAULTS.hub]: fns(abi.hubAbi, {
      delegatePredictionPower: delegate,
      setAllowedDelegator: ([a], ctx) => { if (ctx.write) s.allowed[ctx.from] = lc(a); },
      allowedDelegator: ([a]) => s.allowed[lc(a)] ?? zeroAddress,
      claim: (_, ctx) => {
        const amount = s.rewards[ctx.from] ?? 0n;
        if (ctx.write) {
          s.rewards[ctx.from] = 0n;
          s.balance[ctx.from] = (s.balance[ctx.from] ?? 0n) + amount;
        }
        return amount;
      },
    }),
    [DEFAULTS.rewards]: fns(abi.rewardsAbi, {
      setPredictorFee: ([bps], ctx) => {
        if (s.feeStored[ctx.from]) revert('AlreadySet');
        if (ctx.write) s.feeStored[ctx.from] = bps === 0 ? 1000 : bps;
      },
      effectivePredictorFee: ([a]) => fee(lc(a)),
      predictionDelegateInfo: ([a]) => [s.delegateOf[lc(a)] ?? zeroAddress, powerOf(lc(a))],
      referral: ([a]) => s.referral[lc(a)] ?? zeroAddress,
      setReferral: ([ref], ctx) => {
        if (lc(ref) === zeroAddress || lc(ref) === ctx.from) revert('InvalidReferral');
        if (s.referral[ctx.from]) revert('AlreadySet');
        if (ctx.write) s.referral[ctx.from] = lc(ref);
      },
    }),
    [DEFAULTS.lens]: fns(abi.lensAbi, { getTotalClaimableRewards: ([a]) => [s.rewards[lc(a)] ?? 0n, true] }),
    [DEFAULTS.token]: fns(abi.tokenAbi, {
      balanceOf: ([a]) => s.balance[lc(a)] ?? 0n,
      transferLockedUntil: ([a]) => s.lock[lc(a)] ?? 0,
      getCurrentRound: (_, ctx) => BigInt(ctx.round),
      transfer: ([to, value], ctx) => {
        const l = s.lock[ctx.from] ?? 0;
        if (l !== 0 && l >= ctx.round) revert('Locked');
        if ((s.balance[ctx.from] ?? 0n) < value) revert('ERC20InsufficientBalance');
        if (ctx.write) {
          s.balance[ctx.from] -= value;
          s.balance[lc(to)] = (s.balance[lc(to)] ?? 0n) + value;
        }
        return true;
      },
    }),
    [DEFAULTS.voting]: fns(abi.votingAbi, { weightOf: ([g]) => s.weights[g] ?? 0n }),
    [DEFAULTS.merkle]: fns(abi.merkleAbi, {
      alreadyMintedTo: ([a]) => s.merkle.minted[lc(a)] ?? 0n,
      claimMerkle: ([amount, proof], ctx) => {
        const d = s.merkle.drop[ctx.from];
        if (!d || d.amount !== amount || JSON.stringify(d.proof) !== JSON.stringify(proof)) revert('InvalidProof');
        const already = s.merkle.minted[ctx.from] ?? 0n;
        if (amount <= already) revert('NothingToClaim');
        const avail = s.merkle.available;
        const paid = avail != null && avail > 0n && amount - already > avail ? avail : amount - already; // SatoriMerkle.sol:196-201
        if (ctx.write) {
          s.merkle.minted[ctx.from] = already + paid;
          s.balance[ctx.from] = (s.balance[ctx.from] ?? 0n) + paid;
          if (avail != null) s.merkle.available -= paid;
        }
      },
    }),
    [DEFAULTS.airdrop]: fns(abi.airdropAbi, {
      claimableAirdrop: ([a]) => s.airdrop[lc(a)] ?? 0n,
      claimAirdrop: (_, ctx) => {
        const x = s.airdrop[ctx.from] ?? 0n;
        if (x === 0n) revert('NothingToClaim');
        if (ctx.write) {
          s.airdrop[ctx.from] = 0n;
          s.balance[ctx.from] = (s.balance[ctx.from] ?? 0n) + x;
        }
      },
    }),
  };
  const rpc = fakeRpc(contracts, { timestamp: round * 86400 + hour * 3600, eth });
  return { s, rpc };
}
