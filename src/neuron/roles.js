// The contracts' special keys held by one wallet (docs/design/roles.md): the emission split, the emission schedule, the
// Merkle root publisher, the appoint authority and the wiring authority, each a page of its own (the admin has its own
// module, admin.js; the dev fee's splitters theirs, devfee.js). Each key is declared here once: how its holder is read,
// what its page shows, and its actions, each one contract call. The UI, the agent calls and the tests all read these.
import { formatEther, getAddress, isAddress, isHex, parseUnits, zeroAddress } from 'viem';

const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const NO_STEP = 2n ** 128n - 1n; // SatoriHub.NO_STEP: the multiplier is 1, so no step comes
export const RATIO_DEFAULT = '0.999708061412966511'; // 1 - 846.62/2,900,000 (contract/satori-ui/src/lib/emissionStatus.ts)
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const who = (a) => (!a || a === zeroAddress ? 'None' : short(a));
const satori = (wei) => `${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 2 })} SATORI`;
const ratio = (wad) => {
  const s = formatEther(wad);
  return s.includes('.') ? s : `${s}.0`;
};

// ── what a field takes (each parser throws what is wrong, said plainly) ──
const text = (v) => String(v ?? '').trim();
/** An address; `empty`: what an empty field means (the zero address), else one is required. */
const address = (empty) => ({
  empty,
  parse(v) {
    const t = text(v);
    if (t === '' && empty) return zeroAddress;
    if (!isAddress(t)) throw new Error('That is not a valid address.');
    return getAddress(t);
  },
});
/** A percent with up to two decimals, below 100 → basis points. */
const percent = {
  parse(v) {
    const t = text(v).replace(/%$/, '');
    const bps = Math.round(Number(t) * 100);
    if (t === '' || !Number.isFinite(Number(t)) || Math.abs(Number(t) * 100 - bps) > 1e-6) throw new Error('Give a percent, such as 50 or 12.5.');
    if (bps < 0 || bps >= 10000) throw new Error('The percent must be from 0 to below 100.');
    return BigInt(bps);
  },
};
/** A whole number from `min` to `max`. */
const whole = (min, max) => ({
  parse(v) {
    const n = Number(text(v));
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Give a whole number from ${min} to ${max}.`);
    return n;
  },
});
/** The emission step multiplier: a decimal from 0.001 → wad (SatoriHub.MIN_EMISSION_RATIO). */
const multiplier = {
  parse(v) {
    let wad;
    try { wad = parseUnits(text(v), 18); } catch { throw new Error('Give a multiplier, such as 0.999708 or 1.'); }
    if (wad < 10n ** 15n) throw new Error('The multiplier must be at least 0.001: emission is never ended outright.');
    return wad;
  },
};
/** A 32-byte hash (0x and 64 hex digits). */
const hash = {
  parse(v) {
    const t = text(v);
    if (!isHex(t) || t.length !== 66) throw new Error('Give the root: 0x and 64 hex digits.');
    return t.toLowerCase();
  },
};

/**
 * The keys. Each: id (its tab), label (the menu), name (a wallet holding it is named so), intro; holder: its reads and
 * how they give { holder, pending }; reads: its page's values; facts: (values) → [[label, text]]; actions: [{ id,
 * title, text, now?, field?: { label, kind }, twice?, folded?, asks?, show?(values, role), call(value) → [contract,
 * functionName, args], done(value) }].
 */
export const ROLES = [
  {
    id: 'split', label: 'Emission Split', name: 'Emission split',
    intro: "This wallet holds the emission split: what share of each round's rewards goes to the off-chain channel (paid by Merkle claims) rather than on-chain.",
    holder: { reads: [['rewards', 'emissionSplitAuthority'], ['rewards', 'admin']], of: ([set, admin]) => ({ holder: set === zeroAddress ? admin : set }) },
    reads: { share: ['rewards', 'offchainShareBps'], set: ['rewards', 'emissionSplitAuthority'] },
    facts: (v) => [['Off-chain share', `${Number(v.share) / 100}%`], ['On-chain share', `${100 - Number(v.share) / 100}%`]],
    actions: [
      { id: 'share', title: 'Off-chain share', field: { label: 'Percent off-chain (0 to below 100)', kind: percent },
        text: "The share of each round's rewards, after the dev fee, paid off-chain; the rest is paid on-chain. It applies from the next round.",
        call: (bps) => ['rewards', 'setOffchainShareBps', [bps]], done: (bps) => `The off-chain share is ${Number(bps) / 100}% from the next round.` },
      { id: 'hand', title: 'Hand this job to another address', folded: true, twice: true, field: { label: 'New holder (empty: the admin)', kind: address(true) },
        text: "From then on only the new address (or the appoint authority) can set the split. Empty gives it back to the admin.",
        call: (a) => ['rewards', 'setEmissionSplitAuthority', [a]], done: (a) => (a === zeroAddress ? 'The admin holds the split now.' : `${short(a)} holds the split now.`) },
    ],
  },
  {
    id: 'schedule', label: 'Emission Schedule', name: 'Emission schedule',
    intro: 'This wallet holds the emission schedule: the multiplier each step applies to the rewards paid every round.',
    holder: { reads: [['hub', 'emissionHolder']], of: ([h]) => ({ holder: h }) },
    reads: { e: ['hub', 'emission'], now: ['hub', 'emissionRateNow'], set: ['hub', 'emissionAuthority'] },
    facts: (v) => {
      const [issued, nextStepAt, rate, , , ratioWad, stepsTaken] = v.e;
      return [['This round', `${satori(v.now)} a round`], ['Next round', `${satori(rate)} a round`], ['Multiplier', `× ${ratio(ratioWad)}`],
        ['Issued so far', satori(issued)], ['Next step', nextStepAt >= NO_STEP ? 'None: the multiplier is 1' : `at ${satori(nextStepAt)} issued`],
        ['Steps taken', String(stepsTaken)]];
    },
    actions: [
      { id: 'ratio', title: 'Step multiplier', field: { label: 'Multiplier (e.g. 0.999708 or 1)', kind: multiplier },
        text: `What the next step multiplies the rate by. It never moves this round's or the next round's rate. The default is ${RATIO_DEFAULT} (lifetime emission approaches 2,900,000); 1 stops the steps; above 1 raises the rate, never past 1,440 a round.`,
        call: (wad) => ['hub', 'setEmissionRatio', [wad]], done: (wad) => `The multiplier is × ${ratio(wad)} from the next step.` },
      { id: 'hand', title: 'Hand this job to another address', folded: true, twice: true, field: { label: 'New holder (empty: the admin)', kind: address(true) },
        text: 'From then on only the new address (or the appoint authority) can set the multiplier. Empty gives it back to the admin.',
        call: (a) => ['hub', 'setEmissionAuthority', [a]], done: (a) => (a === zeroAddress ? 'The admin holds the schedule now.' : `${short(a)} holds the schedule now.`) },
    ],
  },
  {
    id: 'publisher', label: 'Root Publisher', name: 'Root publisher',
    intro: "This wallet is the Merkle root publisher: it publishes the root that off-chain rewards are claimed against. The Satori Service publishes it every day with this key.",
    holder: { reads: [['merkle', 'rootPublisher'], ['merkle', 'pendingRootPublisher']], of: ([h, p]) => ({ holder: h, pending: p }) },
    reads: { root: ['merkle', 'merkleRoot'], pending: ['merkle', 'pendingRootPublisher'] },
    facts: (v) => [['Root now', short(v.root)], ['Offered to', who(v.pending)]],
    actions: [
      { id: 'accept', title: 'Accept the job', show: (v, r) => r.isPending, call: () => ['merkle', 'acceptRootPublisher', []], done: () => 'This wallet is the root publisher now.',
        text: 'The root publisher offered this wallet the job. It moves when you accept.' },
      { id: 'root', title: 'Publish a root', folded: true, twice: true, field: { label: 'The root (0x and 64 hex digits)', kind: hash }, show: (v, r) => r.isHolder,
        text: "The Satori Service publishes the root each day, so one set here is replaced at its next publish. A wrong root lets people claim the wrong amounts: only by hand when the Service can't.",
        call: (h) => ['merkle', 'setMerkleRoot', [h]], done: (h) => `Published ${short(h)}.` },
      { id: 'offer', title: 'Offer the job to another address', folded: true, twice: true, field: { label: 'Offer it to (empty: cancel an offer)', kind: address(true) }, show: (v, r) => r.isHolder,
        text: 'It moves when they accept, so a mistyped address never takes it. Empty cancels an offer.',
        call: (a) => ['merkle', 'setRootPublisher', [a]], done: (a) => (a === zeroAddress ? 'The offer is cancelled.' : `Offered to ${short(a)}: it moves when they accept.`) },
    ],
  },
  {
    id: 'appoint', label: 'Appoint', name: 'Appoint',
    intro: 'This wallet is the appoint authority: it can replace the admin and the holders of the emission split, the emission schedule and the airdrop loader, and it sets the scoring curve.',
    holder: { reads: [['token', 'appointAuthority']], of: ([h]) => ({ holder: h }) },
    reads: { admin: ['rewards', 'admin'], split: ['rewards', 'emissionSplitAuthority'], schedule: ['hub', 'emissionHolder'], loader: ['airdrop', 'airdropAuthority'],
      operator: ['engine', 'curveOperator'], curve: ['engine', 'curveConfig'], target: ['engine', 'dustTargetBps'] },
    facts: () => [],
    actions: [
      { id: 'admin', title: 'Admin', now: (v) => short(v.admin), twice: true, field: { label: 'New admin', kind: address(false) },
        text: 'Replaces the admin at once (a recovery for a lost or stolen admin key).',
        call: (a) => ['rewards', 'setAdmin', [a]], done: (a) => `${short(a)} is the admin now.` },
      { id: 'split', title: 'Emission split holder', now: (v) => (v.split === zeroAddress ? `${short(v.admin)} (the admin)` : short(v.split)), twice: true,
        field: { label: 'New holder (empty: the admin)', kind: address(true) }, text: "Who sets the off-chain share of each round's rewards.",
        call: (a) => ['rewards', 'setEmissionSplitAuthority', [a]], done: (a) => (a === zeroAddress ? 'The admin holds the split now.' : `${short(a)} holds the split now.`) },
      { id: 'schedule', title: 'Emission schedule holder', now: (v) => short(v.schedule), twice: true, field: { label: 'New holder (empty: the admin)', kind: address(true) },
        text: 'Who sets the emission step multiplier.',
        call: (a) => ['hub', 'setEmissionAuthority', [a]], done: (a) => (a === zeroAddress ? 'The admin holds the schedule now.' : `${short(a)} holds the schedule now.`) },
      { id: 'loader', title: 'Airdrop loader', now: (v) => who(v.loader), twice: true, field: { label: 'New loader', kind: address(false) },
        text: 'Who loads airdrop batches and closes loading.',
        call: (a) => ['airdrop', 'setAirdropAuthority', [a]], done: (a) => `${short(a)} is the airdrop loader now.` },
      { id: 'operator', title: 'Curve operator', now: (v) => who(v.operator), field: { label: 'Operator (empty: none)', kind: address(true) },
        text: 'A second key that may set the scoring curve below. This wallet keeps the power either way.',
        call: (a) => ['engine', 'setCurveOperator', [a]], done: (a) => (a === zeroAddress ? 'No curve operator now.' : `${short(a)} is the curve operator now.`) },
      { id: 'floor', title: 'Curve: floor (f)', now: (v) => String(v.curve[0]), field: { label: 'Floor, 1 to 64', kind: whole(1, 64) }, curve: true, folded: true,
        text: "The streak a game's bar starts from, and the lowest it goes.",
        call: (n) => ['engine', 'setDustFloor', [n]], done: (n) => `The floor is ${n} now.` },
      { id: 'top', title: 'Curve: top gradient (g)', now: (v) => String(v.curve[1]), field: { label: 'Top gradient, 1 to 8 (at most r)', kind: whole(1, 8) }, curve: true, folded: true,
        text: 'How fast pay grows with a streak above the bar.',
        check: (n, v) => { if (BigInt(n) > v.curve[2]) throw new Error(`The top gradient can't be above the bottom gradient (${v.curve[2]}).`); },
        call: (n) => ['engine', 'setTopGradient', [n]], done: (n) => `The top gradient is ${n} now.` },
      { id: 'bottom', title: 'Curve: bottom gradient (r)', now: (v) => String(v.curve[2]), field: { label: 'Bottom gradient, 1 to 64 (at least g)', kind: whole(1, 64) }, curve: true, folded: true,
        text: 'How hard pay falls for a streak below the bar.',
        check: (n, v) => { if (BigInt(n) < v.curve[1]) throw new Error(`The bottom gradient can't be below the top gradient (${v.curve[1]}).`); },
        call: (n) => ['engine', 'setBottomGradient', [n]], done: (n) => `The bottom gradient is ${n} now.` },
      { id: 'shift', title: 'Curve: top shift (b)', now: (v) => String(v.curve[3]), field: { label: 'Top shift, 0 to 64', kind: whole(0, 64) }, curve: true, folded: true,
        text: 'A flat lift for streaks above the bar; higher starves those below it.',
        call: (n) => ['engine', 'setTopShift', [n]], done: (n) => `The top shift is ${n} now.` },
      { id: 'target', title: 'Curve: dust target', now: (v) => `${Number(v.target) / 100}%`, field: { label: 'Percent below the bar (0 to below 100)', kind: percent }, curve: true, folded: true,
        text: 'The share of prediction power the bar aims to keep below it. Higher raises the bar. Set it at a round boundary.',
        call: (bps) => ['engine', 'setDustTarget', [Number(bps)]], done: (bps) => `The dust target is ${Number(bps) / 100}% now.` },
    ],
  },
  {
    id: 'wiring', label: 'Wiring', name: 'Wiring',
    intro: "This wallet is the wiring authority: it points the token at the contracts it trusts. A wrong address here can stop the whole protocol, so each one is typed twice.",
    holder: { reads: [['token', 'wiringAuthority']], of: ([h]) => ({ holder: h }) },
    reads: { controller: ['token', 'controller'], hook: ['token', 'hook'], airdrop: ['token', 'airdrop'], bridge: ['token', 'bridgeAuthority'],
      controllerFrozen: ['token', 'controllerFrozen'], hookFrozen: ['token', 'hookFrozen'], bridgeFrozen: ['token', 'bridgeAuthorityFrozen'],
      voteLock: ['hub', 'voteLockGovernor'], voteLockFrozen: ['hub', 'voteLockGovernorFrozen'] },
    facts: () => [],
    actions: [
      { id: 'controller', title: 'Controller', now: (v) => `${short(v.controller)}${v.controllerFrozen ? ' (frozen)' : ''}`, twice: true, frozen: (v) => v.controllerFrozen,
        field: { label: 'New controller', kind: address(false) }, text: 'The contract the token lets mint rewards and set locks: the hub.',
        call: (a) => ['token', 'setController', [a]], done: (a) => `The controller is ${short(a)} now.` },
      { id: 'hook', title: 'Transfer hook', now: (v) => `${who(v.hook)}${v.hookFrozen ? ' (frozen)' : ''}`, twice: true, frozen: (v) => v.hookFrozen,
        field: { label: 'New hook (empty: none)', kind: address(true) }, text: 'The contract every transfer calls, to keep staking power in step. It must be a contract.',
        call: (a) => ['token', 'setHook', [a]], done: (a) => (a === zeroAddress ? 'No transfer hook now.' : `The hook is ${short(a)} now.`) },
      { id: 'airdrop', title: 'Airdrop contract', now: (v) => short(v.airdrop), twice: true, field: { label: 'New airdrop contract', kind: address(false) },
        text: 'The contract the token lets mint the airdrop.',
        call: (a) => ['token', 'setAirdrop', [a]], done: (a) => `The airdrop contract is ${short(a)} now.` },
      { id: 'bridge', title: 'Bridge authority', now: (v) => `${who(v.bridge)}${v.bridgeFrozen ? ' (frozen)' : ''}`, twice: true, frozen: (v) => v.bridgeFrozen,
        field: { label: 'New bridge authority (empty: none)', kind: address(true) }, text: 'The contract that says which bridges may move SATORI between chains. It must be a contract.',
        call: (a) => ['token', 'setBridgeAuthority', [a]], done: (a) => (a === zeroAddress ? 'No bridge authority now.' : `The bridge authority is ${short(a)} now.`) },
      { id: 'voteLock', title: 'Vote-lock contract', now: (v) => `${who(v.voteLock)}${v.voteLockFrozen ? ' (frozen)' : ''}`, twice: true, frozen: (v) => v.voteLockFrozen,
        field: { label: 'New vote-lock contract (empty: none)', kind: address(true) }, text: 'The contract that may lock a wallet while it votes. Empty stops new locks; the ones already set run out.',
        call: (a) => ['hub', 'setVoteLockGovernor', [a]], done: (a) => (a === zeroAddress ? 'No vote-lock contract now.' : `The vote-lock contract is ${short(a)} now.`) },
      { id: 'freezeVoteLock', title: 'Freeze the vote-lock contract', asks: 'Freeze the vote-lock contract where it is, for good? No one can change it again.',
        show: (v) => !v.voteLockFrozen, text: 'Pins the vote-lock contract where it is, for good.',
        call: () => ['hub', 'freezeVoteLockGovernor', []], done: () => 'The vote-lock contract is frozen for good.' },
    ],
  },
];
export const ROLE_IDS = ROLES.map((r) => r.id);
export const roleOf = (id) => ROLES.find((r) => r.id === id);

/**
 * Which keys `me` holds: { [id]: { holder, pending, isHolder, isPending, held, values } } (values: its page's reads, only
 * for a key it holds or was offered). One multicall for the holders, one for the pages. An RPC error throws.
 */
export async function rolesOf(chain, me) {
  const calls = ROLES.flatMap((r) => r.holder.reads);
  const got = await chain.roleReads(calls);
  const out = {};
  let at = 0;
  for (const r of ROLES) {
    const { holder, pending = zeroAddress } = r.holder.of(got.slice(at, at += r.holder.reads.length));
    const isHolder = same(holder, me);
    const isPending = same(pending, me);
    out[r.id] = { holder, pending, isHolder, isPending, held: isHolder || isPending, values: null };
  }
  const shown = ROLES.filter((r) => out[r.id].held);
  const reads = shown.flatMap((r) => Object.values(r.reads));
  const vals = reads.length ? await chain.roleReads(reads) : [];
  at = 0;
  for (const r of shown) {
    const keys = Object.keys(r.reads);
    out[r.id].values = Object.fromEntries(keys.map((k, i) => [k, vals[at + i]]));
    at += keys.length;
  }
  return out;
}

/** An action's value from what was typed (nothing for a button), checked as the contract would: → the call's value. */
export function valueOf(role, action, typed, values) {
  const a = roleOf(role)?.actions.find((x) => x.id === action);
  if (!a) throw new Error(`No action ${action} for ${role}.`);
  const v = a.field ? a.field.kind.parse(typed) : undefined;
  if (a.check) a.check(v, values);
  return v;
}

/**
 * One key's action from `key` (the wallet), on `roles` (rolesOf) read just now: refused for a key it doesn't hold, and
 * for a frozen lever; step(name, k, n) says the work, opts(step) a write's options. → [{ hash, label }]
 */
export async function roleAct(chain, key, roles, role, action, typed, { step, opts }) {
  const r = roleOf(role);
  const st = roles[role];
  if (!r || !st) throw new Error(`No special key ${role}.`);
  const a = r.actions.find((x) => x.id === action);
  if (!a) throw new Error(`No action ${action} for ${role}.`);
  if (a.show ? !a.show(st.values, st) : !st.isHolder) throw new Error(`This wallet can't do that: it doesn't hold the ${r.name.toLowerCase()} key${st.isPending ? ' yet (accept it first)' : ''}.`);
  if (a.frozen?.(st.values)) throw new Error(`${a.title} is frozen: no one can change it.`);
  const v = valueOf(role, action, typed, st.values);
  const [contract, fn, args] = a.call(v);
  step('send', 1, 1);
  return [{ hash: (await chain.roleWrite(key, contract, fn, args, opts(step))).hash, label: a.title }];
}

/** What an action did, said in its card. */
export const doneText = (role, action, typed, values) => {
  const a = roleOf(role).actions.find((x) => x.id === action);
  return a.done(valueOf(role, action, typed, values));
};

/** A key's page as plain values (agents: specialKeys()): bigints as strings. */
export const plain = (x) => (typeof x === 'bigint' ? x.toString() : Array.isArray(x) ? x.map(plain)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)])) : x);

/** The field kinds and the ways values are said, for the Safe's keys (src/neuron/safe.js). */
export const fields = { address, percent, whole, multiplier, hash };
export const say = { short, who, satori };

/** specialKeys()'s answer: each key, its holder, and (held) its page's values, as plain values. */
export function rolesView(of) {
  return Object.fromEntries(ROLES.map((r) => {
    const x = of?.[r.id];
    return [r.id, { label: r.label, holder: x?.holder ?? null, pending: x?.pending ?? null, held: !!x?.held, isHolder: !!x?.isHolder,
      isPending: !!x?.isPending, values: x?.values ? plain(x.values) : null, actions: r.actions.map((a) => a.id) }];
  }));
}
