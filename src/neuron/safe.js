// The governor Safe's keys (docs/design/safe.md): root, fee, upgrade, freeze and the airdrop loader, held by a Safe
// whose owners sign in this app. An owner proposes one of these keys' actions to Safe's transaction service (its own
// signature with it), the other owners sign it there, and any of them executes it once enough have. Declared as the
// other keys are (src/neuron/roles.js): how each key's holder is read, its page's values, its actions.
import { getAddress, isAddress, parseEther, zeroAddress } from 'viem';
import { fields, say } from './roles.js';
import { UPGRADEABLE } from '../chain/index.js';
import { execArgs, safeTx, safeTxHash, signSafeTx } from '../chain/safe.js';

const { address, percent } = fields;
const { short, who, satori } = say;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const NAMES = { rewards: 'Rewards', engine: 'Engine', hub: 'Hub', voting: 'Voting', registry: 'Registry', games: 'Games', merkle: 'Merkle' };
const CONTRACTS = UPGRADEABLE.map((n) => [n, NAMES[n]]);
const pct = (bps) => `${Number(bps) / 100}%`;

/** One of the upgradeable contracts, and (with `then`) what follows it: "hub 0x…" → { target, value }. */
const choice = (then) => ({
  choose: CONTRACTS,
  parse(v) {
    const [target, ...rest] = String(v ?? '').trim().split(/\s+/);
    if (!UPGRADEABLE.includes(target)) throw new Error(`Pick a contract: ${UPGRADEABLE.join(', ')}.`);
    return { target, value: then ? then.parse(rest.join(' ')) : undefined };
  },
});
/** An airdrop batch: one "address, amount" a line (SATORI) → [recipients, amounts]; no address twice, no amount 0. */
const batch = {
  lines: true,
  parse(v) {
    const rows = String(v ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!rows.length) throw new Error('Give one "address, amount" a line.');
    const seen = new Set();
    const out = rows.map((l, i) => {
      const [a, n] = l.split(/[,\s]+/);
      if (!isAddress(a ?? '')) throw new Error(`Line ${i + 1}: that is not a valid address.`);
      let wei;
      try { wei = parseEther(n ?? ''); } catch { throw new Error(`Line ${i + 1}: that is not an amount of SATORI.`); }
      if (!(wei > 0n)) throw new Error(`Line ${i + 1}: the amount must be above 0.`);
      if (seen.has(a.toLowerCase())) throw new Error(`Line ${i + 1}: that address is in the batch twice.`);
      seen.add(a.toLowerCase());
      return [getAddress(a), wei];
    });
    return [out.map((x) => x[0]), out.map((x) => x[1])];
  },
};
const authority = (id, key, fn, does) => ({ id, title: `Appoint the ${key.toLowerCase()}`, now: (v) => who(v[id]), twice: true,
  field: { label: `New ${key.toLowerCase()} (empty: no one)`, kind: address(true) }, text: `The ${key.toLowerCase()}: ${does} Empty leaves no one holding it, for good.`,
  call: (a) => ['token', fn, [a]], describe: ([a]) => `Appoint ${who(a)} the ${key.toLowerCase()}` });

/** The keys, as roles.js declares its: holder (one read), reads, facts, actions (`describe(args)`: a pending one said). */
export const SAFE_KEYS = [
  {
    id: 'root', name: 'Root authority', intro: 'Appoints every other key of the token, and can hand itself on (two steps) or give itself up.',
    holder: ['token', 'rootAuthority'],
    reads: { fee: ['token', 'feeAuthority'], upgrade: ['token', 'upgradeAuthority'], wiring: ['token', 'wiringAuthority'], appoint: ['token', 'appointAuthority'],
      freeze: ['token', 'freezeAuthority'], pending: ['token', 'pendingRootAuthority'] },
    facts: (v) => (v.pending !== zeroAddress ? [['Offered to', short(v.pending)]] : []),
    actions: [
      authority('fee', 'Fee authority', 'setFeeAuthority', 'it changes the dev fee, within 5% to 25%.'),
      authority('upgrade', 'Upgrade authority', 'setUpgradeAuthority', 'it upgrades the contracts, or gives that up for each.'),
      authority('wiring', 'Wiring authority', 'setWiringAuthority', 'it points the token at the contracts it trusts.'),
      authority('appoint', 'Appoint authority', 'setAppointAuthority', 'it replaces the admin and the job holders, and sets the scoring curve.'),
      authority('freeze', 'Freeze authority', 'setFreezeAuthority', 'it freezes the wiring and the dev fee, for good.'),
      { id: 'offer', title: 'Offer the root to another address', folded: true, twice: true, field: { label: 'Offer it to (empty: cancel an offer)', kind: address(true) },
        text: 'It moves when they accept, so a mistyped address never takes it.', call: (a) => ['token', 'setRootAuthority', [a]],
        describe: ([a]) => (a === zeroAddress ? 'Cancel the root offer' : `Offer the root to ${short(a)}`) },
      { id: 'renounce', title: 'Give up the root', folded: true, asks: 'Give up the root authority for good? No one can appoint the token\'s keys again.',
        text: "For good: the token's keys stay where they are, forever.", call: () => ['token', 'renounceRootAuthority', []], describe: () => 'Give up the root, for good' },
    ],
  },
  {
    id: 'fee', name: 'Fee authority', intro: 'Sets the dev fee: the share of every round paid to the dev fee splitters, within 5% to 25%. Two steps: propose, then accept in a later transaction, at most once every 30 rounds.',
    holder: ['token', 'feeAuthority'],
    reads: { bps: ['token', 'devFeeBps'], pending: ['token', 'pendingDevFeeBps'], frozen: ['token', 'devFeeBpsFrozen'], last: ['token', 'lastDevFeeChangeRound'] },
    facts: (v) => [['Dev fee', `${pct(v.bps)}${v.frozen ? ' (frozen)' : ''}`], ...(v.pending ? [['Proposed', pct(v.pending)]] : []), ['Last changed', `round ${v.last}`]],
    actions: [
      { id: 'propose', title: 'Propose a dev fee', field: { label: 'Percent, 5 to 25', kind: percent }, show: (v) => !v.frozen,
        check: (bps) => { if (bps < 500n || bps > 2500n) throw new Error('The dev fee must be from 5% to 25%.'); },
        text: 'Then accept it in a later transaction to make it the fee.', call: (bps) => ['token', 'proposeDevFeeBps', [bps]], describe: ([bps]) => `Propose a dev fee of ${pct(bps)}` },
      { id: 'accept', title: 'Accept the proposed fee', show: (v) => !v.frozen && v.pending > 0n, text: 'Makes the proposed fee the dev fee.',
        call: () => ['token', 'acceptDevFeeBps', []], describe: () => 'Accept the proposed dev fee' },
      { id: 'cancel', title: 'Cancel the proposed fee', show: (v) => v.pending > 0n, text: 'Drops the proposal; the fee stays.',
        call: () => ['token', 'cancelDevFeeBps', []], describe: () => 'Cancel the proposed dev fee' },
    ],
  },
  {
    id: 'upgrade', name: 'Upgrade authority', intro: 'Upgrades the contracts behind their proxies (only to a compatible build of the same contract), or gives that up for one of them, for good.',
    holder: ['token', 'upgradeAuthority'],
    reads: Object.fromEntries(UPGRADEABLE.flatMap((n) => [[`${n}Impl`, [`uups.${n}`, 'implementation']], [`${n}Ren`, [`uups.${n}`, 'upgradesRenounced']]])),
    facts: (v) => CONTRACTS.map(([n, label]) => [label, v[`${n}Ren`] ? `${short(v[`${n}Impl`])} (upgrades given up)` : short(v[`${n}Impl`])]),
    actions: [
      { id: 'upgrade', title: 'Upgrade a contract', twice: true, field: { label: 'New implementation (0x…)', kind: choice(address(false)) },
        text: 'The contract checks the new build is the same contract and keeps its state.',
        call: ({ target, value }) => [`uups.${target}`, 'upgradeTo', [value]], describe: ([a], name) => `Upgrade ${NAMES[name.slice(5)]} to ${short(a)}` },
      { id: 'renounce', title: 'Give up upgrades for a contract', folded: true, asks: 'Give up upgrades for this contract for good? Its code can never change again.',
        field: { label: 'Contract', kind: choice() }, text: 'For good: its code can never change again.',
        call: ({ target }) => [`uups.${target}`, 'renounceUpgrade', []], describe: (_, name) => `Give up upgrades for ${NAMES[name.slice(5)]}, for good` },
    ],
  },
  {
    id: 'freeze', name: 'Freeze authority', intro: "Freezes the token's wiring and the dev fee, each for good: no one can change it after.",
    holder: ['token', 'freezeAuthority'],
    reads: { controller: ['token', 'controllerFrozen'], hook: ['token', 'hookFrozen'], bridge: ['token', 'bridgeAuthorityFrozen'], fee: ['token', 'devFeeBpsFrozen'] },
    facts: (v) => [['Controller', v.controller ? 'Frozen' : 'Open'], ['Transfer hook', v.hook ? 'Frozen' : 'Open'], ['Bridge authority', v.bridge ? 'Frozen' : 'Open'], ['Dev fee', v.fee ? 'Frozen' : 'Open']],
    actions: [['controller', 'Controller', 'freezeController'], ['hook', 'Transfer hook', 'freezeHook'], ['bridge', 'Bridge authority', 'freezeBridgeAuthority'], ['fee', 'Dev fee', 'freezeDevFeeBps']]
      .map(([id, label, fn]) => ({ id, title: `Freeze the ${label.toLowerCase()}`, show: (v) => !v[id], asks: `Freeze the ${label.toLowerCase()} for good? No one can change it again.`,
        text: 'For good.', call: () => ['token', fn, []], describe: () => `Freeze the ${label.toLowerCase()}, for good` })),
  },
  {
    id: 'loader', name: 'Airdrop loader', intro: 'Loads the airdrop: who gets how much. Each row can be claimed as soon as its batch lands, and rows can\'t be changed. Then closes loading for good.',
    holder: ['airdrop', 'airdropAuthority'],
    reads: { loaded: ['airdrop', 'airdropLoadedTotal'], finalized: ['airdrop', 'airdropLoadingFinalized'], cap: ['token', 'AIRDROP_TOTAL_SUPPLY'] },
    facts: (v) => [['Loaded', `${satori(v.loaded)} of ${satori(v.cap)}`], ['Loading', v.finalized ? 'Closed for good' : 'Open']],
    actions: [
      { id: 'load', title: 'Load a batch', field: { label: 'One "address, amount" a line (SATORI)', kind: batch }, show: (v) => !v.finalized,
        text: 'Check it before proposing: a row can be claimed the moment its batch lands, and can\'t be changed.',
        call: ([recipients, amounts]) => ['airdrop', 'loadAirdropBatch', [recipients, amounts]],
        describe: ([recipients, amounts]) => `Load ${recipients.length} airdrop row${recipients.length === 1 ? '' : 's'}, ${satori(amounts.reduce((a, b) => a + b, 0n))} in all` },
      { id: 'finalize', title: 'Close loading', show: (v) => !v.finalized, asks: 'Close airdrop loading for good? Nothing more can ever be loaded.',
        text: 'For good. Claims do not wait for it.', call: () => ['airdrop', 'finalizeAirdropLoading', []], describe: () => 'Close airdrop loading, for good' },
    ],
  },
];
export const safeKeyOf = (id) => SAFE_KEYS.find((k) => k.id === id);

/**
 * The Safes `me` owns among the keys' holders, each with the keys it holds and their values: { safes: [{ address,
 * owners, threshold, nonce, keys: { [id]: values } }] }. An RPC error throws.
 */
export async function safesOf(chain, me) {
  const holders = await chain.roleReads(SAFE_KEYS.map((k) => k.holder));
  const distinct = [...new Set(holders.filter((h) => h !== zeroAddress).map((h) => getAddress(h)))];
  const safes = (await chain.safeReads(distinct)).filter((s) => s && s.owners.some((o) => same(o, me)));
  for (const s of safes) {
    const keys = SAFE_KEYS.filter((k, i) => same(holders[i], s.address));
    const reads = keys.flatMap((k) => Object.values(k.reads));
    const vals = reads.length ? await chain.roleReads(reads) : [];
    let at = 0;
    s.keys = Object.fromEntries(keys.map((k) => {
      const names = Object.keys(k.reads);
      const v = Object.fromEntries(names.map((n, i) => [n, vals[at + i]]));
      at += names.length;
      return [k.id, v];
    }));
  }
  return { safes };
}

/** A pending transaction said in words: the key's action it is, or the contract and function, or the raw call. */
export function describe(chain, tx) {
  const call = chain.roleDecode(tx.to, tx.data);
  if (!call) return `A call to ${short(tx.to)} (not one of Satori's)`;
  for (const k of SAFE_KEYS) {
    for (const a of k.actions) {
      const [name, fn] = a.call(a.field ? sample(a) : undefined);
      if (fn === call.functionName && (name === call.name || (name.startsWith('uups.') && call.name.startsWith('uups.')))) return a.describe(call.args ?? [], call.name);
    }
  }
  return `${call.functionName} on ${call.name}`;
}
/** A value of the action's field's shape, to learn which function it calls. */
function sample(a) {
  const k = a.field.kind;
  if (k.choose) return { target: UPGRADEABLE[0], value: zeroAddress };
  if (k.lines) return [[], []];
  if (k === percent) return 1000n;
  return zeroAddress;
}

/**
 * The Safe's transactions waiting, from its nonce on: [{ ...tx, description, confirmations, signedByMe, enough, next }]
 * (`next`: the one it executes first; `enough`: signed by as many owners as it needs).
 */
export async function pendingOf(chain, service, safe, me) {
  const list = await service.pending(safe.address, safe.nonce);
  return list.map((t) => ({ ...t, description: describe(chain, t), signedByMe: t.confirmations.some((c) => same(c.owner, me)),
    enough: BigInt(t.confirmations.length) >= safe.threshold, next: t.nonce === safe.nonce }));
}

/** One key's action as a Safe transaction, checked as the contract would, with `typed` as on its card. → [contract, fn, args] */
export function safeCall(safe, keyId, action, typed) {
  const k = safeKeyOf(keyId);
  const a = k?.actions.find((x) => x.id === action);
  if (!a) throw new Error(`No action ${action} for ${keyId}.`);
  const v = safe.keys[keyId];
  if (!v) throw new Error(`This Safe doesn't hold the ${k.name.toLowerCase()}.`);
  if (a.show && !a.show(v)) throw new Error(`${a.title}: not now (${k.facts(v).map(([l, t]) => `${l}: ${t}`).join('; ')}).`);
  const value = a.field ? a.field.kind.parse(typed) : undefined;
  a.check?.(value, v);
  return a.call(value);
}

/**
 * Propose `keyId`'s `action` to the Safe from `key` (an owner), signed: the next free nonce (after those waiting).
 * → { safeTxHash, nonce }
 */
export async function proposeSafe(chain, service, key, safe, pending, keyId, action, typed) {
  const [name, fn, args] = safeCall(safe, keyId, action, typed);
  const { to, data } = chain.roleEncode(name, fn, args);
  const nonce = pending.reduce((n, t) => (t.nonce >= n ? t.nonce + 1n : n), safe.nonce);
  const tx = safeTx({ safe: safe.address, to, data, nonce });
  const chainId = chain.config.chainId;
  await service.propose(chainId, tx, key.evmAddress ?? key.address, await signSafeTx(key, chainId, tx));
  return { safeTxHash: safeTxHash(chainId, tx), nonce };
}

const pendingAt = (pending, hash) => {
  const t = pending.find((x) => x.safeTxHash.toLowerCase() === String(hash).toLowerCase());
  if (!t) throw new Error('That transaction is not waiting in this Safe.');
  return t;
};

/** Sign a waiting transaction from `key` (an owner who hasn't yet). */
export async function signSafe(chain, service, key, safe, pending, hash) {
  const t = pendingAt(pending, hash);
  if (t.signedByMe) throw new Error('This wallet has signed it already.');
  const tx = safeTx({ safe: safe.address, to: t.to, data: t.data, nonce: t.nonce });
  if (safeTxHash(chain.config.chainId, tx).toLowerCase() !== t.safeTxHash.toLowerCase()) throw new Error("This transaction isn't a plain call this app can sign.");
  await service.confirm(t.safeTxHash, await signSafeTx(key, chain.config.chainId, tx));
}

/** Execute a waiting transaction from `key`: the next one, signed by enough owners. → [{ hash, label }] */
export async function executeSafe(chain, key, safe, pending, hash, { step, opts }) {
  const t = pendingAt(pending, hash);
  if (!t.next) throw new Error(`Execute the Safe's transaction ${safe.nonce} first: they run in order.`);
  if (!t.enough) throw new Error(`It needs ${safe.threshold} signatures; it has ${t.confirmations.length}.`);
  const tx = safeTx({ safe: safe.address, to: t.to, data: t.data, nonce: t.nonce });
  step('send', 1, 1);
  return [{ hash: (await chain.safeExec(key, safe.address, execArgs(tx, t.confirmations.slice(0, Number(safe.threshold))), opts(step))).hash, label: 'Executed' }];
}
