// The dev fee's splitters (docs/design/devfee.md), as the dapp reads and drives them (contract/satori-ui/src/hooks/useDevFee.ts):
// the tree walked from the token's PLATFORM_FEE_RECIPIENT (the top, then the splitters among its payees: two deep by
// design), the wallet's slots in it and what it may do. Every write is the wallet's.
import { getAddress, isAddress, zeroAddress } from 'viem';

const BPS = 10_000n;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const ok = (r) => {
  if (r.status !== 'success') throw r.error ?? new Error('a splitter read failed');
  return r.result;
};

/** One splitter's facts and slots; null when `address` is no splitter (its slotCount fails: a plain address). */
async function node(chain, address, me) {
  const [count] = await chain.splitterReads([[address, 'slotCount']]);
  if (count.status !== 'success') return null;
  const n = Number(count.result);
  const r = await chain.splitterReads([[address, 'authority'], [address, 'pendingAuthority'], [address, 'rotationThresholdBps'],
    [address, 'totalShares'], ...Array.from({ length: n }, (_, i) => [[address, 'getSlot', [BigInt(i)]], [address, 'withdrawCaller', [BigInt(i)]],
      [address, 'releasable', [chain.config.token, BigInt(i)]]]).flat()]);
  const slots = Array.from({ length: n }, (_, i) => {
    const [payee, shares] = ok(r[4 + 3 * i]);
    return { slotId: i, payee, shares, trigger: ok(r[5 + 3 * i]), releasable: ok(r[6 + 3 * i]) };
  });
  const [authority, pendingAuthority] = [ok(r[0]), ok(r[1])];
  return { address: getAddress(address), authority, pendingAuthority, thresholdBps: ok(r[2]), totalShares: ok(r[3]), slots,
    mySlotId: slots.find((s) => same(s.payee, me))?.slotId ?? null,
    isAuthority: same(authority, me), isOffered: same(pendingAuthority, me) };
}

/**
 * The tree and the wallet `me`'s part in it: { top, nodes: [the top, then its branches: each with parent and
 * parentSlotId], mine: [{ node, slotId, shares, wholeBps, claimable, waiting, trigger }], shown }. `waiting`: the
 * slot's part of what the top still holds for its branch (moved down by Claim). `shown`: a slot, or an authority (held
 * or offered). An RPC error throws (never "not shown" from a read that did not come).
 */
export async function devFeeOf(chain, me) {
  const top = await chain.platformFeeRecipient();
  const root = await node(chain, top, me);
  if (!root) return { top, nodes: [], mine: [], shown: false };
  const nodes = [{ ...root, parent: null, parentSlotId: null }];
  for (const s of root.slots) {
    const branch = await node(chain, s.payee, me);
    if (branch) nodes.push({ ...branch, parent: root.address, parentSlotId: s.slotId });
  }
  const mine = nodes.flatMap((n) => n.slots.filter((s) => same(s.payee, me)).map((s) => {
    const up = n.parent ? root.slots[n.parentSlotId] : null;
    return { node: n.address, slotId: s.slotId, shares: s.shares, trigger: s.trigger, claimable: s.releasable,
      wholeBps: up ? (up.shares * s.shares) / BPS : s.shares, waiting: up ? (up.releasable * s.shares) / n.totalShares : 0n };
  }));
  return { top: root.address, nodes, mine, shown: mine.length > 0 || nodes.some((n) => n.isAuthority || n.isOffered) };
}

const nodeOf = (tree, address) => {
  const n = tree.nodes.find((x) => same(x.address, address));
  if (!n) throw new Error(`${address} is not one of the dev fee's splitters`);
  return n;
};
const addressIn = (to, what = 'address') => {
  const t = String(to ?? '').trim();
  if (!isAddress(t)) throw new Error(`That is not a valid ${what}.`);
  return getAddress(t);
};
const parentOf = (n) => {
  if (!n.parent) throw new Error('The top splitter has no slot anywhere to redirect.');
  return n.parent;
};
const mySlot = (n) => {
  if (n.mySlotId == null) throw new Error('This wallet holds no slot in that splitter.');
  return n.mySlotId;
};

/**
 * The wallet's actions (docs/design/devfee.md#the-cards), each from `key` with `tree` (devFeeOf) just read;
 * step(name, k, n) says the work, opts(step) a write's options. → [{ hash, label }]
 */
export const devFeeOps = {
  /** The slot's SATORI: what waits one level up moved down first (anyone may), then the slot's. */
  async claim(chain, key, tree, address, { step, opts }) {
    const n = nodeOf(tree, address);
    const s = tree.mine.find((m) => same(m.node, n.address));
    if (!s) throw new Error('This wallet holds no slot in that splitter.');
    if (!(s.claimable + s.waiting > 0n)) throw new Error('Nothing to claim yet.');
    const txs = [];
    const total = s.waiting > 0n ? 2 : 1;
    if (s.waiting > 0n) {
      step('move', 1, total);
      txs.push({ hash: (await chain.splitterWrite(key, n.parent, 'withdraw', [chain.config.token, BigInt(n.parentSlotId)], opts(step))).hash,
        label: 'Moved down' });
    }
    step('claim', total, total);
    txs.push({ hash: (await chain.splitterWrite(key, n.address, 'withdraw', [chain.config.token, BigInt(s.slotId)], opts(step))).hash,
      label: 'Claimed' });
    return txs;
  },
  /** Who may trigger the slot's payout: one address, or anyone (empty). */
  async trigger(chain, key, tree, address, caller, { step, opts }) {
    const n = nodeOf(tree, address);
    mySlot(n);
    const to = String(caller ?? '').trim() === '' ? zeroAddress : addressIn(caller);
    step('send', 1, 1);
    return [{ hash: (await chain.splitterWrite(key, n.address, 'setWithdrawCaller', [to], opts(step))).hash, label: 'Set' }];
  },
  /** The slot handed to `to`, with every future payment: refused here as the chain would. */
  async moveSlot(chain, key, tree, address, to, { step, opts }) {
    const n = nodeOf(tree, address);
    mySlot(n);
    const t = addressIn(to);
    if (same(t, n.address)) throw new Error('That is the splitter itself: the slot would be lost for good.');
    if (n.slots.some((s) => same(s.payee, t))) throw new Error('That address already holds a slot in this splitter.');
    step('send', 1, 1);
    return [{ hash: (await chain.splitterWrite(key, n.address, 'rotateRecipient', [t], opts(step))).hash, label: 'Moved' }];
  },
  async vote(chain, key, tree, address, to, { step, opts }) {
    const n = nodeOf(tree, address);
    mySlot(n);
    step('send', 1, 1);
    return [{ hash: (await chain.splitterWrite(key, n.address, 'approveRotation', [parentOf(n), addressIn(to)], opts(step))).hash, label: 'Agreed' }];
  },
  async unvote(chain, key, tree, address, to, { step, opts }) {
    const n = nodeOf(tree, address);
    mySlot(n);
    step('send', 1, 1);
    return [{ hash: (await chain.splitterWrite(key, n.address, 'revokeRotation', [parentOf(n), addressIn(to)], opts(step))).hash, label: 'Taken back' }];
  },
  /** rotateAt: the authority alone, or anyone once the threshold agreed (the chain decides). */
  async redirect(chain, key, tree, address, to, { step, opts }) {
    const n = nodeOf(tree, address);
    step('send', 1, 1);
    return [{ hash: (await chain.splitterWrite(key, n.address, 'rotateAt', [parentOf(n), addressIn(to)], opts(step))).hash, label: 'Redirected' }];
  },
  async offer(chain, key, tree, address, to, { step, opts }) {
    const n = nodeOf(tree, address);
    step('send', 1, 1);
    return [{ hash: (await chain.splitterWrite(key, n.address, 'transferAuthority', [addressIn(to)], opts(step))).hash, label: 'Offered' }];
  },
  async accept(chain, key, tree, address, { step, opts }) {
    const n = nodeOf(tree, address);
    step('send', 1, 1);
    return [{ hash: (await chain.splitterWrite(key, n.address, 'acceptAuthority', [], opts(step))).hash, label: 'Accepted' }];
  },
  async giveUp(chain, key, tree, address, { step, opts }) {
    const n = nodeOf(tree, address);
    step('send', 1, 1);
    return [{ hash: (await chain.splitterWrite(key, n.address, 'renounceAuthority', [], opts(step))).hash, label: 'Given up' }];
  },
};

/**
 * Where one "redirect this splitter to `to`" proposal stands (proposals are hash-keyed, not listed):
 * { to, agreedBps, thresholdBps, cleared, iAgreed }, agreedBps of the splitter's shares.
 */
export async function proposalOf(chain, tree, address, to) {
  const n = nodeOf(tree, address);
  const t = addressIn(to);
  const [id] = await chain.splitterReads([[n.address, 'proposalId', [parentOf(n), t]]]);
  const r = await chain.splitterReads([[n.address, 'approvedShares', [ok(id)]], [n.address, 'rotationApproved', [n.parent, t]],
    ...(n.mySlotId == null ? [] : [[n.address, 'approved', [ok(id), BigInt(n.mySlotId)]]])]);
  return { to: t, agreedBps: (ok(r[0]) * BPS) / n.totalShares, thresholdBps: n.thresholdBps, cleared: ok(r[1]),
    iAgreed: n.mySlotId == null ? false : ok(r[2]) };
}
