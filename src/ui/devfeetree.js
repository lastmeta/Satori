// The Dev Fee page's picture of the splitters (owner, 2026-10-29: "a representation of the contract"): the top splitter,
// its branches (each with its authority and what a redirect needs), and every payee as a dot with its share on its line
// and the SATORI it has not claimed yet. The wallet is green; a line it can change carries a word (move, vote,
// redirect), explained under the picture. Lines are one SVG path each (no nested templates inside an <svg>); the boxes,
// dots and words are HTML over it, x in % of the width, y in px.
import { html } from '@arrow-js/core';
import { formatEther, zeroAddress } from 'viem';
import { state } from './state.js';
import { shortHash } from './format.js';

const TOP_H = 48;
const BOX_TOP = 118;
const BOX_H = 66;
const DOT_TOP = BOX_TOP + BOX_H + 70;
const HEIGHT = DOT_TOP + 52;
const COL = 84; // px a payee needs: the picture scrolls sideways below that

const pctOf = (shares, total) => `${Number(((Number(shares) * 100) / Number(total)).toFixed(2))}%`;
const satori = (wei) => `${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 2 })} SATORI`;
const nameOf = (n) => `${n.parent ? 'Splitter' : 'Top splitter'} ${shortHash(n.address)}`;

/** A cubic from (x1, y1) down to (x2, y2), and the point at t along it. */
const curve = (x1, y1, x2, y2) => {
  const ym = (y1 + y2) / 2;
  const at = (t) => {
    const u = 1 - t;
    const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [b[0] * x1 + b[1] * x1 + b[2] * x2 + b[3] * x2, b[0] * y1 + (b[1] + b[2]) * ym + b[3] * y2];
  };
  return { d: `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`, at };
};

/**
 * The picture of `tree` (devFeeOf): { height, minWidth, plain, mine (the two paths' d), items: [box | dot | pct | word],
 * legend: [{ word, text }] }, or null before the tree is read.
 */
export function treeLayout(tree) {
  const top = tree?.nodes?.[0];
  if (!top) return null;
  const branchOf = (payee) => tree.nodes.find((n) => n.parent && n.address.toLowerCase() === payee.toLowerCase());
  // the payees, left to right: a branch's own payees in its place
  const leaves = top.slots.flatMap((s) => {
    const b = branchOf(s.payee);
    return b ? b.slots.map((x) => ({ node: b, slot: x, up: s })) : [{ node: top, slot: s, up: null }];
  });
  const cols = leaves.length || 1;
  const xOf = (i) => ((i + 0.5) * 100) / cols;
  const items = [{ kind: 'box', id: top.address, x: 50, y: 0, w: 100, title: nameOf(top), lines: [{ text: "The token's dev fee goes here" }] }];
  const plain = [];
  const mine = [];
  const legend = [];
  const edge = (x1, y1, x2, y2, { pct, word, green }) => {
    const c = curve(x1, y1, x2, y2);
    (green ? mine : plain).push(c.d);
    const [px, py] = c.at(0.75);
    items.push({ kind: 'pct', id: `pct:${x2}:${y2}`, x: px, y: py, text: pct });
    if (word) {
      const [wx, wy] = c.at(0.5);
      items.push({ kind: 'word', id: `word:${x2}:${y2}`, x: wx, y: wy, text: word });
    }
  };
  let i = 0;
  for (const s of top.slots) {
    const b = branchOf(s.payee);
    if (!b) { // a plain payee of the top
      const me = top.mySlotId === s.slotId;
      const x = xOf(i++);
      edge(50, TOP_H, x, DOT_TOP, { pct: pctOf(s.shares, top.totalShares), word: me ? 'move' : '', green: me });
      items.push({ kind: 'dot', id: `${top.address}:${s.slotId}`, x, y: DOT_TOP, me, name: me ? 'You' : shortHash(s.payee), amount: satori(s.releasable) });
      if (me) legend.push({ word: 'move', text: `Move your slot: hand your ${pctOf(s.shares, top.totalShares)} of the ${nameOf(top).toLowerCase()} and all its future payments to another address. Only you can, and it can't be undone.` });
      continue;
    }
    const x0 = i;
    const x = (xOf(x0) + xOf(x0 + b.slots.length - 1)) / 2;
    const iMember = b.mySlotId != null;
    const word = b.isAuthority ? 'redirect' : iMember ? 'vote' : '';
    const auth = b.isOffered ? { text: 'Authority offered to you', me: true }
      : b.authority === zeroAddress ? { text: 'No authority' }
        : { text: b.isAuthority ? 'Authority: you' : `Authority ${shortHash(b.authority)}`, me: b.isAuthority };
    edge(50, TOP_H, x, BOX_TOP, { pct: pctOf(s.shares, top.totalShares), word, green: !!word });
    items.push({ kind: 'box', id: b.address, x, y: BOX_TOP, w: (b.slots.length * 100) / cols, title: nameOf(b), mine: b.isAuthority,
      lines: [auth, { text: `${pctOf(b.thresholdBps, 10_000n)} must agree to redirect`, muted: true }] });
    const share = pctOf(s.shares, top.totalShares);
    if (b.isAuthority) legend.push({ word: 'redirect', text: `As its authority you can redirect ${nameOf(b)}'s ${share} of the dev fee alone, offer the authority to another address, or give it up.` });
    else if (iMember) {
      const held = pctOf(b.slots[b.mySlotId].shares, b.totalShares);
      legend.push({ word: 'vote', text: `Redirect ${nameOf(b)}: change where the top splitter sends its ${share}. ${pctOf(b.thresholdBps, 10_000n)} of its shares must agree${b.authority !== zeroAddress ? ', or its authority alone' : ''}; you hold ${held}.` });
    }
    for (const t of b.slots) {
      const me = b.mySlotId === t.slotId;
      const tx = xOf(i++);
      edge(x, BOX_TOP + BOX_H, tx, DOT_TOP, { pct: pctOf(t.shares, b.totalShares), word: me ? 'move' : '', green: me });
      const unclaimed = t.releasable + (s.releasable * t.shares) / b.totalShares; // with its part of what waits in the top
      items.push({ kind: 'dot', id: `${b.address}:${t.slotId}`, x: tx, y: DOT_TOP, me, name: me ? 'You' : shortHash(t.payee), amount: satori(unclaimed) });
      if (me) legend.push({ word: 'move', text: `Move your slot: hand your ${pctOf(t.shares, b.totalShares)} of ${nameOf(b)} and all its future payments to another address. Only you can, and it can't be undone.` });
    }
  }
  return { height: HEIGHT, minWidth: leaves.length * COL, plain: plain.join(''), mine: mine.join(''), items, legend };
}

const item = (n) => {
  const at = `left:${n.x}%;top:${n.y}px`;
  if (n.kind === 'box') {
    return html`<div class="${n.mine ? 'dft-box mine' : 'dft-box'}" data-test="devfee-tree-box" style="${`${at};width:calc(${n.w}% - 8px)`}">
      <b>${n.title}</b>${n.lines.map((l) => html`<span class="${l.me ? 'you' : l.muted ? 'muted' : ''}">${l.text}</span>`)}</div>`;
  }
  if (n.kind === 'dot') {
    return html`<div class="${n.me ? 'dft-dot me' : 'dft-dot'}" data-test="devfee-tree-member" style="${at}"><i></i><b>${n.name}</b><span>${n.amount}</span></div>`;
  }
  return html`<span class="${n.kind === 'word' ? 'dft-word' : 'dft-pct'}" data-test="${`devfee-tree-${n.kind}`}" style="${at}">${n.text}</span>`;
};

export function devFeeTree() {
  const L = () => treeLayout(state.devFee.tree);
  return html`<section class="card" data-test="devfee-tree" hidden="${() => !L()}">
    <h2>How it splits</h2>
    <p class="muted small">Each splitter's share on its line; under each address, the SATORI it has not claimed yet. You are in green.</p>
    <div class="dft-scroll"><div class="dft" style="${() => `height:${L()?.height ?? 0}px;min-width:${L()?.minWidth ?? 0}px`}">
      <svg viewBox="${() => `0 0 100 ${L()?.height ?? 1}`}" preserveAspectRatio="none" aria-hidden="true"><path class="dft-line" d="${() => L()?.plain ?? ''}"></path><path class="dft-line mine" d="${() => L()?.mine ?? ''}"></path></svg>
      ${() => (L()?.items ?? []).map((n) => item(n).key(`${n.id}:${n.kind}:${n.text ?? n.amount ?? n.title}:${n.me ?? n.mine ?? ''}:${n.lines?.map((l) => l.text).join() ?? ''}`))}
    </div></div>
    <ul class="dft-legend" data-test="devfee-tree-legend" hidden="${() => !L()?.legend.length}">
      ${() => (L()?.legend ?? []).map((l) => html`<li><span class="dft-word">${l.word}</span> ${l.text}</li>`.key(l.text))}
    </ul>
  </section>`;
}
