// Test double (never imported by the app): a small, stateful Satori D7 on
// fake-rpc.js, with the rules the app depends on (docs/design/base.md):
// the engine's batch checks (C/next/SatoriEngine.sol:698-810), staking (delegatePredictionPower) and
// its locks (C/next/SatoriHub.sol:426-434,813-877), the set-once predictor fee
// (C/SatoriRewards.sol:119-143,651-669), the token's transfer lock
// (C/next/SatoriToken.sol:816-821), the registry's history page
// (C/SatoriRegistry.sol:1375-1393), claims (hub, merkle, airdrop).
// Unit tests (src/chain, src/neuron) and the e2e (/rpc) share it.
import { encodeAbiParameters, keccak256, parseAbiParameters, zeroAddress } from 'viem';
import * as abi from '../src/chain/abi.js';
import { DEFAULTS } from '../src/chain/config.js';
import { UPGRADEABLE } from '../src/chain/index.js';
import { safeTxHash } from '../src/chain/safe.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

/** The owner whose 65-byte signature (r, s, v) `sig` (hex, no 0x) is of `hash`: lowercase. */
function recoverOwner(hash, sig) {
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(parseInt(sig.slice(128, 130), 16) - 27)
    .recoverPublicKey(hash.slice(2)).toRawBytes(false);
  return `0x${bytesToHex(keccak_256(pub.slice(1))).slice(-40)}`;
}
import { INDEFINITE, HISTORY } from '../src/chain/index.js';
import { fakeRpc, revert, panic } from './fake-rpc.js';

export const E18 = 10n ** 18n;
export const SPLIT_A = '0x6c5722c65041341c16d892235ea6076f05cf4238';
export const SPLIT_C = '0x52b7ee858379509f7bdbc239da0f1ff36bead2ed';
export const SPLIT_B = '0xc082ccc8d827b58bc848d5918ca92eee5c06f5f7';
const SPLITTERS = { [SPLIT_A]: [SPLIT_C, SPLIT_B], [SPLIT_C]: [`0x${'c1'.repeat(20)}`, `0x${'c2'.repeat(20)}`], [SPLIT_B]: [`0x${'b1'.repeat(20)}`, `0x${'b2'.repeat(20)}`] };

const lc = (a) => a.toLowerCase();
const ADAPTER = `0x${'ad'.repeat(20)}`;
export const ADMIN = `0x${'a0'.repeat(20)}`;
/** The governor Safe (docs/design/safe.md): root, fee, upgrade and freeze on the token, and the airdrop loader. */
export const SAFE = `0x${'5a'.repeat(20)}`;
export const SAFE_OWNERS = [1, 2, 3, 4, 5].map((i) => `0x${`0${i}`.repeat(20)}`); // SatoriRewards.admin() unless a test names the wallet // the adapter whose valueDisplay a stream's `display` answers

/**
 * @param {{round?: number, hour?: number, eth?: Record<string, bigint>}} [opts]
 * @returns {{ s: object, rpc: ReturnType<typeof fakeRpc> }} s is the state to arrange and inspect
 */
export function fakeSatori({ round = 20741, hour = 9, eth = {} } = {}) {
  const s = {
    // streams: id → { game, named, cadence (minutes), history: [{hour, value}], pulls? }; stream 1 is the default stream;
    // pulls: a Sentiment stream on D7, which records its first value when it is first predicted (updateValuesStrict)
    streams: {
      1: { game: 1, named: false, cadence: 1440, history: [{ hour: (round - 1) * 24, value: 0n }, { hour: round * 24, value: 59058240589371161n }] },
    },
    deadGames: {}, // gameId → error name ('' = none): a game that always reverts (a stale bridge, say)
    predicted: {}, // `${addr}:${round}` → games in the batch
    streak: {}, // `${addr}:${gameId}` → the player's streak
    threshold: {}, // gameId → its adaptive streak threshold (the bar: max(2, it))
    lastPred: {}, // `${addr}:${gameId}` → hour
    batches: [], // [{ from, round, hour, requests }]
    delegateOf: {}, // addr → delegate
    feeStored: {}, // addr → bps (0 = never set: the 10 % default)
    allowed: {}, // addr → the one wallet it accepts (allowedDelegator)
    referral: {}, // addr → its referrer (set once)
    lock: {}, // addr → round (transferLockedUntil)
    balance: {}, // SATORI
    rewards: {}, // what the lens says the address can claim with hub.claim()
    airdrop: {}, // vested and unclaimed
    claimer: {}, // owner → its named claimer (delegateClaimAbility)
    openClaim: false, // the permissionless claim to the owner (contract humble, 2026-10-29); false: as deployed (D7)
    merkle: { drop: {}, minted: {}, available: null }, // drop: addr → { amount, proof }; available: the lane's reserve (null: plenty)
    weights: { 1: E18 }, // gameId → voting weight (the engine pays only games with weight, SatoriEngine.sol:828)
    splitters: Object.fromEntries(Object.entries(SPLITTERS).map(([a, payees]) => [a, { slots: payees.map((p, i) => ({ payee: lc(p), shares: a === SPLIT_A ? [6000n, 4000n][i] : 5000n })),
      authority: zeroAddress, pending: zeroAddress, threshold: 9000n, trigger: {}, claimed: {}, withdrawn: 0n, approvals: {}, epoch: {} }])),
    // the admin and its levers (docs/design/admin.md): capability bits as deployed live (0, 1, 5, 7: 0xa3)
    admin: ADMIN, caps: 0xa3n, relayer: zeroAddress, regFee: 10n ** 15n, reporter: zeroAddress, approved: {}, adapters: [],
    // the other special keys (docs/design/roles.md), held by the admin's address as deployed live, but split and
    // schedule left at zero (the admin's)
    splitSet: zeroAddress, share: 5000n, scheduleSet: zeroAddress, appoint: ADMIN, wiring: ADMIN,
    emission: { issued: 2116n * E18, nextStepAt: 2962n * E18, rate: 846n * E18, prevRate: 847n * E18, from: 20756n, ratioWad: 999708061412966511n, stepsTaken: 1 },
    publisher: ADMIN, pendingPublisher: zeroAddress, root: `0x${'12'.repeat(32)}`, loader: SAFE, operator: zeroAddress,
    curve: [2n, 3n, 12n, 0n], target: 5000n, controller: DEFAULTS.hub.toLowerCase(), hook: DEFAULTS.hub.toLowerCase(), airdropAt: DEFAULTS.airdrop.toLowerCase(),
    bridge: zeroAddress, frozen: { controller: false, hook: false, bridge: false, voteLock: false }, voteLock: `0x${'bd'.repeat(20)}`,
    // the Safe and its keys (docs/design/safe.md; no fee key: the dev fee is 15% for good): 3 of 5; execTransaction checks the signatures as the Safe does
    safe: { owners: [...SAFE_OWNERS], threshold: 3n, nonce: 0n, executed: [] },
    rootKey: SAFE, pendingRoot: zeroAddress, upgradeKey: SAFE, freezeKey: SAFE,
    airdropLoaded: 0n, airdropFinalized: false, airdropRows: {},
    impl: Object.fromEntries(UPGRADEABLE.map((n, i) => [n, `0x${`${i + 1}0`.repeat(20)}`])), renounced: {},
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
      if (!st.history.length && st.id !== 1 && !st.pulls) revert('EmptyStream');
      if (!st.history.length && st.pulls && ctx.write) s.streams[st.id].history.push({ hour: ctx.round * 24 + ctx.hour % 24, value: 0n });
      const last = s.lastPred[`${ctx.from}:${r.gameId}`];
      if (last) {
        if (Math.floor(last / 24) === ctx.round) revert('DuplicatePrediction');
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
  const onlyAdmin = (ctx, error = 'Unauthorized') => { if (ctx.from !== s.admin) revert(error); };
  const only = (ctx, ...who) => { if (!who.includes(ctx.from)) revert('Unauthorized'); };
  const tuner = (ctx) => { if (ctx.from !== s.appoint && (s.operator === zeroAddress || ctx.from !== s.operator)) revert('NotCurveOperator'); };
  const curve = (ctx, i, n, min, max, ok = () => true) => {
    tuner(ctx);
    if (n < min || n > max || !ok()) revert('BadInput');
    if (ctx.write) s.curve[i] = BigInt(n);
  };
  const wire = (ctx, field, a, { frozen, zero }) => {
    only(ctx, s.wiring);
    if (frozen && s.frozen[frozen]) revert('Frozen');
    if (!zero && lc(a) === zeroAddress) revert('BadInput');
    if (ctx.write) s[field] = lc(a);
  };
  const register = (kind, impl, name, ctx) => {
    onlyAdmin(ctx);
    if (lc(impl) === zeroAddress) revert(kind === 'stream' ? 'InvalidAdapter' : 'InvalidGameAdapter');
    if (ctx.write) s.adapters.push({ kind, impl: lc(impl), name });
    return s.adapters.length + 1;
  };
  const contracts = {
    [DEFAULTS.engine]: fns(abi.engineAbi, {
      predictMultipleWithPayloads: predict,
      predictMultipleWithReferral: ([ref, requests], ctx) => {
        predict([requests], ctx);
        const r = lc(ref);
        if (ctx.write && r !== zeroAddress && r !== ctx.from && !s.referral[ctx.from]) s.referral[ctx.from] = r; // setReferralFor
      },
      predictedStreamsCount: ([a, r]) => BigInt(s.predicted[`${lc(a)}:${r}`] ?? 0),
      streaks: ([a, g]) => BigInt(s.streak[`${lc(a)}:${g}`] ?? 0),
      gameStreakState: ([g]) => [s.threshold[g] ?? 0, 0],
      offchainReporter: () => s.reporter,
      curveOperator: () => s.operator,
      setCurveOperator: ([a], ctx) => { only(ctx, s.appoint); if (ctx.write) s.operator = lc(a); },
      curveConfig: () => s.curve,
      dustTargetBps: () => s.target,
      setDustFloor: ([n], ctx) => curve(ctx, 0, n, 1, 64),
      setTopGradient: ([n], ctx) => curve(ctx, 1, n, 1, 8, () => BigInt(n) <= s.curve[2]),
      setBottomGradient: ([n], ctx) => curve(ctx, 2, n, 1, 64, () => BigInt(n) >= s.curve[1]),
      setTopShift: ([n], ctx) => curve(ctx, 3, n, 0, 64),
      setDustTarget: ([n], ctx) => { tuner(ctx); if (n > 9999) revert('BadInput'); if (ctx.write) s.target = BigInt(n); },
      setOffchainReporter: ([who], ctx) => { onlyAdmin(ctx, 'OnlyAdmin'); if (ctx.write) s.reporter = lc(who); },
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
      getDataStreamInfo: ([id]) => {
        const st = s.streams[id] ?? revert('InvalidStreamId');
        return [st.name ?? (id === 1 ? 'satori' : `stream ${id}`), zeroAddress, 1, BigInt(st.history.at(-1)?.value ?? 0), BigInt(st.history.at(-1)?.hour ?? 0), true];
      },
      // streams[id].display ({ decimals, unit, label }): an adapter stream (ADAPTER says it); else a simple one (adapterId 0)
      streams: ([i]) => {
        const id = Number(i) + 1;
        const st = s.streams[id] ?? revert();
        return [zeroAddress, st.display ? 2 : 1, st.cadence ?? 0, st.display ? 7 : 0, !!st.named, `0x${id.toString(16).padStart(64, '0')}`, st.name ?? ''];
      },
      adapter: ([a]) => (a === 7 ? ADAPTER : zeroAddress),
      isNamedStream: ([id]) => (s.streams[id] && !s.streams[id].namedReverts ? s.streams[id].named : revert()), // reverts for an unknown id (D6 and D7)
    }),
    [ADAPTER]: fns(abi.adapterUiAbi, {
      valueDisplay: ([, config]) => { const d = s.streams[Number(BigInt(config))].display; return [d.decimals, d.unit, d.label]; },
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
      // SatoriRewards._checkClaimAuth: the named claimer, any recipient; with openClaim, anyone to the owner when none is named
      claimFor: ([owner, recipient], ctx) => {
        const o = lc(owner);
        const named = s.claimer[o];
        const may = named ? named === ctx.from : s.openClaim && lc(recipient) === o;
        if (!may) revert('Unauthorized');
        const amount = s.rewards[o] ?? 0n;
        if (ctx.write) {
          s.rewards[o] = 0n;
          s.balance[lc(recipient)] = (s.balance[lc(recipient)] ?? 0n) + amount;
        }
        return amount;
      },
      emissionHolder: () => (s.scheduleSet === zeroAddress ? s.admin : s.scheduleSet),
      emissionAuthority: () => s.scheduleSet,
      emission: () => { const e = s.emission; return [e.issued, e.nextStepAt, e.rate, e.prevRate, e.from, e.ratioWad, e.stepsTaken, 0n]; },
      emissionRateNow: () => s.emission.prevRate,
      setEmissionRatio: ([wad], ctx) => {
        only(ctx, s.scheduleSet === zeroAddress ? s.admin : s.scheduleSet);
        if (wad < 10n ** 15n) revert('BadInput');
        if (ctx.write) s.emission.ratioWad = wad;
      },
      setEmissionAuthority: ([a], ctx) => { only(ctx, s.scheduleSet === zeroAddress ? s.admin : s.scheduleSet, s.appoint); if (ctx.write) s.scheduleSet = lc(a); },
      voteLockGovernor: () => s.voteLock,
      voteLockGovernorFrozen: () => s.frozen.voteLock,
      setVoteLockGovernor: ([a], ctx) => { only(ctx, s.wiring); if (s.frozen.voteLock) revert('AlreadySet'); if (ctx.write) s.voteLock = lc(a); },
      freezeVoteLockGovernor: (_, ctx) => { only(ctx, s.wiring); if (ctx.write) s.frozen.voteLock = true; },
      registerAdapter: ([impl, name], ctx) => register('stream', impl, name, ctx),
      registerGameAdapter: ([impl, name], ctx) => register('game', impl, name, ctx),
    }),
    [DEFAULTS.rewards]: fns(abi.rewardsAbi, {
      admin: () => s.admin,
      emissionSplitAuthority: () => s.splitSet,
      setEmissionSplitAuthority: ([a], ctx) => { only(ctx, s.splitSet === zeroAddress ? s.admin : s.splitSet, s.appoint); if (ctx.write) s.splitSet = lc(a); },
      offchainShareBps: () => s.share,
      setOffchainShareBps: ([bps], ctx) => { only(ctx, s.splitSet === zeroAddress ? s.admin : s.splitSet); if (bps >= 10000n) revert('BadInput'); if (ctx.write) s.share = bps; },
      setAdmin: ([to], ctx) => { only(ctx, s.admin, s.appoint); if (lc(to) === zeroAddress) revert('BadInput'); if (ctx.write) s.admin = lc(to); },
      capabilityAllowed: ([bit, who]) => ((s.caps >> BigInt(bit)) & 1n) === 1n || lc(who) === s.admin,
      setCapabilities: ([bits], ctx) => { onlyAdmin(ctx); if (ctx.write) s.caps = bits; },
      officialRelayer: () => s.relayer,
      setOfficialRelayer: ([to], ctx) => { onlyAdmin(ctx); if (ctx.write) s.relayer = lc(to); },
      registrationFee: () => s.regFee,
      setRegistrationFee: ([fee], ctx) => { onlyAdmin(ctx); if (fee === 0n) revert('BadInput'); if (ctx.write) s.regFee = fee; },
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
      PLATFORM_FEE_RECIPIENT: () => SPLIT_A,
      rootAuthority: () => s.rootKey,
      pendingRootAuthority: () => s.pendingRoot,
      upgradeAuthority: () => s.upgradeKey,
      freezeAuthority: () => s.freezeKey,
      setUpgradeAuthority: ([a], ctx) => { only(ctx, s.rootKey); if (ctx.write) s.upgradeKey = lc(a); },
      setWiringAuthority: ([a], ctx) => { only(ctx, s.rootKey); if (ctx.write) s.wiring = lc(a); },
      setAppointAuthority: ([a], ctx) => { only(ctx, s.rootKey); if (ctx.write) s.appoint = lc(a); },
      setFreezeAuthority: ([a], ctx) => { only(ctx, s.rootKey); if (ctx.write) s.freezeKey = lc(a); },
      setRootAuthority: ([a], ctx) => { only(ctx, s.rootKey); if (ctx.write) s.pendingRoot = lc(a); },
      renounceRootAuthority: (_, ctx) => { only(ctx, s.rootKey); if (ctx.write) { s.rootKey = zeroAddress; s.pendingRoot = zeroAddress; } },
      freezeController: (_, ctx) => { only(ctx, s.freezeKey); if (ctx.write) s.frozen.controller = true; },
      freezeHook: (_, ctx) => { only(ctx, s.freezeKey); if (ctx.write) s.frozen.hook = true; },
      freezeBridgeAuthority: (_, ctx) => { only(ctx, s.freezeKey); if (ctx.write) s.frozen.bridge = true; },
      AIRDROP_TOTAL_SUPPLY: () => 1_100_000n * E18,
      appointAuthority: () => s.appoint,
      wiringAuthority: () => s.wiring,
      controller: () => s.controller,
      hook: () => s.hook,
      airdrop: () => s.airdropAt,
      bridgeAuthority: () => s.bridge,
      controllerFrozen: () => s.frozen.controller,
      hookFrozen: () => s.frozen.hook,
      bridgeAuthorityFrozen: () => s.frozen.bridge,
      setController: ([a], ctx) => wire(ctx, 'controller', a, { frozen: 'controller', zero: false }),
      setHook: ([a], ctx) => wire(ctx, 'hook', a, { frozen: 'hook', zero: true }),
      setAirdrop: ([a], ctx) => wire(ctx, 'airdropAt', a, { zero: false }),
      setBridgeAuthority: ([a], ctx) => wire(ctx, 'bridge', a, { frozen: 'bridge', zero: true }),
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
    [DEFAULTS.voting]: fns(abi.votingAbi, {
      weightOf: ([g]) => s.weights[g] ?? 0n,
      gameApproved: ([g]) => !!s.approved[g],
      setGameApproved: ([g, on], ctx) => {
        onlyAdmin(ctx, 'NotAdmin');
        if (!Object.values(s.streams).some((st) => st.game === g)) revert('UnknownGame');
        if (g === 1) revert('CannotSetDefaultApproval');
        if (ctx.write) s.approved[g] = on;
      },
    }),
    [DEFAULTS.merkle]: fns(abi.merkleAbi, {
      alreadyMintedTo: ([a]) => s.merkle.minted[lc(a)] ?? 0n,
      rootPublisher: () => s.publisher,
      pendingRootPublisher: () => s.pendingPublisher,
      merkleRoot: () => s.root,
      setMerkleRoot: ([h], ctx) => { only(ctx, s.publisher); if (ctx.write) s.root = h; },
      setRootPublisher: ([a], ctx) => { only(ctx, s.publisher); if (ctx.write) s.pendingPublisher = lc(a); },
      acceptRootPublisher: (_, ctx) => { only(ctx, s.pendingPublisher); if (ctx.write) { s.publisher = s.pendingPublisher; s.pendingPublisher = zeroAddress; } },
      // claimMerkle(amount, proof) for the sender, or (D8) claimMerkle(account, amount, proof) by anyone, paid to account
      claimMerkle: (args, ctx) => {
        const [who, amount, proof] = args.length === 3 ? [lc(args[0]), args[1], args[2]] : [ctx.from, ...args];
        if (args.length === 3 && s.merkle.forAccountMissing) revert(); // an implementation before D8's upgrade: no such function
        const d = s.merkle.drop[who];
        if (!d || d.amount !== amount || JSON.stringify(d.proof) !== JSON.stringify(proof)) revert('InvalidProof');
        const already = s.merkle.minted[who] ?? 0n;
        if (amount <= already) revert('NothingToClaim');
        const avail = s.merkle.available;
        const paid = avail != null && avail > 0n && amount - already > avail ? avail : amount - already; // SatoriMerkle.sol:196-201
        if (ctx.write) {
          s.merkle.minted[who] = already + paid;
          s.balance[who] = (s.balance[who] ?? 0n) + paid;
          if (avail != null) s.merkle.available -= paid;
        }
      },
    }),
    [DEFAULTS.airdrop]: fns(abi.airdropAbi, {
      claimableAirdrop: ([a]) => s.airdrop[lc(a)] ?? 0n,
      airdropAuthority: () => s.loader,
      airdropLoadedTotal: () => s.airdropLoaded,
      airdropLoadingFinalized: () => s.airdropFinalized,
      loadAirdropBatch: ([to, amounts], ctx) => {
        only(ctx, s.loader);
        if (s.airdropFinalized) revert('AirdropLoadingClosed');
        if (to.length !== amounts.length) revert('LengthMismatch');
        if (to.some((a) => s.airdropRows[lc(a)])) revert('DuplicateRecipient');
        if (ctx.write) to.forEach((a, i) => { s.airdropRows[lc(a)] = amounts[i]; s.airdropLoaded += amounts[i]; });
      },
      finalizeAirdropLoading: (_, ctx) => { only(ctx, s.loader); if (s.airdropFinalized) revert('AlreadySet'); if (ctx.write) s.airdropFinalized = true; },
      setAirdropAuthority: ([a], ctx) => { only(ctx, s.loader, s.appoint); if (ctx.write) s.loader = lc(a); },
      claimAirdrop: (_, ctx) => {
        const x = s.airdrop[ctx.from] ?? 0n;
        if (x === 0n) revert('NothingToClaim');
        if (ctx.write) {
          s.airdrop[ctx.from] = 0n;
          s.balance[ctx.from] = (s.balance[ctx.from] ?? 0n) + x;
        }
      },
      claimAirdropFor: ([user], ctx) => { // anyone; minted to `user` (SatoriAirdrop.sol:118-124)
        const u = lc(user);
        const x = s.airdrop[u] ?? 0n;
        if (x === 0n) revert('NothingToClaim');
        if (ctx.write) {
          s.airdrop[u] = 0n;
          s.balance[u] = (s.balance[u] ?? 0n) + x;
        }
      },
    }),
  };
  // the dev fee's splitters (C/SatoriSplitterImmutable.sol), Base Sepolia's tree: A 60 % C, 40 % B; C and B 50/50
  for (const [a, sp] of Object.entries(s.splitters)) contracts[a] = splitter(s, sp, a);
  // the upgradeable ones answer the upgrade calls too (SatoriUUPS), at their own addresses
  for (const n of UPGRADEABLE) {
    const c = contracts[DEFAULTS[n]];
    c.abi = [...c.abi, ...abi.uupsAbi.filter((i) => i.type === 'function')];
    Object.assign(c.fns, {
      implementation: () => s.impl[n],
      upgradesRenounced: () => !!s.renounced[n],
      upgradeTo: ([impl], ctx) => { only(ctx, s.upgradeKey); if (s.renounced[n]) revert('UpgradeUnauthorized'); if (ctx.write) s.impl[n] = lc(impl); },
      renounceUpgrade: (_, ctx) => { only(ctx, s.upgradeKey); if (ctx.write) s.renounced[n] = true; },
    });
  }
  contracts[SAFE] = fns(abi.safeAbi, {
    getOwners: () => s.safe.owners,
    getThreshold: () => s.safe.threshold,
    nonce: () => s.safe.nonce,
    // as the Safe: the hash at its nonce, `threshold` signatures by distinct owners in rising order, then the call as it
    execTransaction: ([to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, sigs], ctx) => {
      const hash = safeTxHash(84532, { safe: SAFE, to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce: s.safe.nonce });
      const signers = [];
      for (let i = 0; i < Number(s.safe.threshold); i++) {
        const sig = sigs.slice(2 + 130 * i, 2 + 130 * (i + 1));
        if (sig.length < 130) revert('GS020');
        signers.push(recoverOwner(hash, sig));
      }
      if (signers.some((a, i) => !s.safe.owners.some((o) => lc(o) === a) || (i && BigInt(a) <= BigInt(signers[i - 1])))) revert('GS026');
      if (ctx.write) {
        s.safe.nonce += 1n;
        s.safe.executed.push({ to: lc(to), data });
      }
      ctx.exec(to, data, SAFE);
      return true;
    },
  });
  const rpc = fakeRpc(contracts, { timestamp: round * 86400 + hour * 3600, eth });
  return { s, rpc };
}

/** One SatoriSplitterImmutable at `me` (SATORI only: its balance is s.balance[me]); `sp` its state in s.splitters. */
function splitter(s, sp, me) {
  const slotOf = (a) => { const i = sp.slots.findIndex((x) => x.payee === lc(a)); if (i < 0) revert('NotARecipient'); return i; };
  const releasable = (i) => {
    const x = sp.slots[i];
    if (!x) return 0n;
    const entitled = (((s.balance[me] ?? 0n) + sp.withdrawn) * x.shares) / 10000n;
    return entitled > (sp.claimed[i] ?? 0n) ? entitled - (sp.claimed[i] ?? 0n) : 0n;
  };
  const id = (parent, to) => keccak256(encodeAbiParameters(parseAbiParameters('address, address, address, uint256'), [me, parent, to, BigInt(sp.epoch[lc(parent)] ?? 0)]));
  const agreed = (pid) => Object.keys(sp.approvals[pid] ?? {}).reduce((n, i) => n + sp.slots[i].shares, 0n);
  return { abi: abi.splitterAbi, fns: {
    slotCount: () => BigInt(sp.slots.length),
    getSlot: ([i]) => (sp.slots[Number(i)] ? [sp.slots[Number(i)].payee, sp.slots[Number(i)].shares] : revert('UnknownSlot')),
    releasable: ([, i]) => releasable(Number(i)),
    withdrawCaller: ([i]) => sp.trigger[Number(i)] ?? zeroAddress,
    totalShares: () => 10000n,
    authority: () => sp.authority,
    pendingAuthority: () => sp.pending,
    rotationThresholdBps: () => sp.threshold,
    proposalId: ([p, to]) => id(p, to),
    approvedShares: ([pid]) => agreed(pid),
    approved: ([pid, i]) => !!sp.approvals[pid]?.[Number(i)],
    rotationApproved: ([p, to]) => agreed(id(p, to)) * 10000n >= 10000n * sp.threshold,
    withdraw: ([, i], ctx) => {
      const n = Number(i);
      const x = sp.slots[n] ?? revert('UnknownSlot');
      const gate = sp.trigger[n];
      if (gate && gate !== zeroAddress && ctx.from !== gate && ctx.from !== x.payee) revert('NotWithdrawCaller');
      const owed = releasable(n);
      if (owed === 0n) revert('NothingToWithdraw');
      if (ctx.write) {
        sp.claimed[n] = (sp.claimed[n] ?? 0n) + owed;
        sp.withdrawn += owed;
        s.balance[me] -= owed;
        s.balance[x.payee] = (s.balance[x.payee] ?? 0n) + owed;
      }
      return owed;
    },
    setWithdrawCaller: ([c], ctx) => { const n = slotOf(ctx.from); if (ctx.write) sp.trigger[n] = lc(c); },
    rotateRecipient: ([to], ctx) => {
      if (lc(to) === zeroAddress) revert('ZeroAddress');
      if (lc(to) === me) revert('PayeeIsSelf');
      const n = slotOf(ctx.from);
      if (sp.slots.some((x) => x.payee === lc(to))) revert('AlreadyRecipient');
      if (ctx.write) { sp.slots[n].payee = lc(to); delete sp.trigger[n]; }
    },
    approveRotation: ([p, to], ctx) => {
      const n = slotOf(ctx.from);
      const pid = id(p, to);
      if (sp.approvals[pid]?.[n]) revert('AlreadyApproved');
      if (ctx.write) sp.approvals[pid] = { ...sp.approvals[pid], [n]: true };
    },
    revokeRotation: ([p, to], ctx) => {
      const n = slotOf(ctx.from);
      const pid = id(p, to);
      if (!sp.approvals[pid]?.[n]) revert('NotApproved');
      if (ctx.write) delete sp.approvals[pid][n];
    },
    rotateAt: ([p, to], ctx) => {
      const byAuthority = sp.authority !== zeroAddress && ctx.from === sp.authority;
      if (!byAuthority && agreed(id(p, to)) * 10000n < 10000n * sp.threshold) revert('InsufficientConsent');
      if (ctx.write) {
        sp.epoch[lc(p)] = (sp.epoch[lc(p)] ?? 0) + 1;
        const parent = s.splitters[lc(p)];
        const k = parent.slots.findIndex((x) => x.payee === me);
        parent.slots[k].payee = lc(to);
      }
    },
    transferAuthority: ([to], ctx) => {
      if (ctx.from !== sp.authority) revert('NotAuthority');
      if (ctx.write) sp.pending = lc(to);
    },
    acceptAuthority: (_, ctx) => {
      if (ctx.from !== sp.pending) revert('NotPendingAuthority');
      if (ctx.write) { sp.authority = ctx.from; sp.pending = zeroAddress; }
    },
    renounceAuthority: (_, ctx) => {
      if (ctx.from !== sp.authority) revert('NotAuthority');
      if (ctx.write) { sp.authority = zeroAddress; sp.pending = zeroAddress; }
    },
  } };
}

