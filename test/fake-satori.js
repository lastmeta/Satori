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
import { INDEFINITE, HISTORY } from '../src/chain/index.js';
import { fakeRpc, revert, panic } from './fake-rpc.js';

export const E18 = 10n ** 18n;
export const SPLIT_A = '0x6c5722c65041341c16d892235ea6076f05cf4238';
export const SPLIT_C = '0x52b7ee858379509f7bdbc239da0f1ff36bead2ed';
export const SPLIT_B = '0xc082ccc8d827b58bc848d5918ca92eee5c06f5f7';
const SPLITTERS = { [SPLIT_A]: [SPLIT_C, SPLIT_B], [SPLIT_C]: [`0x${'c1'.repeat(20)}`, `0x${'c2'.repeat(20)}`], [SPLIT_B]: [`0x${'b1'.repeat(20)}`, `0x${'b2'.repeat(20)}`] };

const lc = (a) => a.toLowerCase();
const ADAPTER = `0x${'ad'.repeat(20)}`; // the adapter whose valueDisplay a stream's `display` answers

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
      curveConfig: () => [2n, 3n, 12n, 0n],
      gameStreakState: ([g]) => [s.threshold[g] ?? 0, 0],
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
      PLATFORM_FEE_RECIPIENT: () => SPLIT_A,
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

