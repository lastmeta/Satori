// Dev Fee (docs/design/devfee.md): only for a wallet in the dev fee's splitters. A card for each of its slots (its share,
// what it can claim, Claim; folded: who can trigger its payout, Move your slot), Redirect for a branch it holds a slot
// in, and Authority for a splitter it holds (or was offered). Every action is the wallet's: the inline Unlock in its card.
import { html } from '@arrow-js/core';
import { formatEther, zeroAddress } from 'viem';
import { state } from './state.js';
import { fact, form, unlockPrompt } from './parts.js';
import { fmtNum, shortHash } from './format.js';
import { txLink } from './wallet.js';

const same = (x, y) => !!x && !!y && x.toLowerCase() === y.toLowerCase();
const d = () => state.devFee;
const nodeAt = (address) => d().tree?.nodes.find((n) => same(n.address, address));
const slotAt = (address) => d().tree?.mine.find((m) => same(m.node, address));
const pct = (bps) => `${fmtNum(Number(bps) / 100)}%`;
const satori = (wei) => `${fmtNum(Number(formatEther(wei ?? 0n)))} SATORI`;
const busy = () => !!state.devFeeBusy;
const name = (address) => {
  const n = nodeAt(address);
  return n ? `${n.parent ? 'Splitter' : 'Top splitter'} ${shortHash(n.address)}` : shortHash(address);
};

/** An action's outcome, in the card (`card`) it was asked from. */
const outcome = (card) => html`<div>
  <p class="small" role="status" data-test="${() => (d().did === card ? 'devfee-result' : false)}" hidden="${() => d().did !== card || !d().result}">${() => d().result}</p>
  <div class="txs" hidden="${() => d().did !== card || !d().txs.length}">${() => (d().did === card ? d().txs.map((t) => txLink(t.hash, t.label).key(t.hash)) : '')}</div>
  <p class="error small" role="alert" data-test="${() => (d().did === card ? 'devfee-error' : false)}" hidden="${() => d().did !== card || !d().actionError}">${() => d().actionError}</p>
</div>`;

/** An address typed twice, then the action (one that can't be undone). */
const twice = (a, card, op, address, { label, button, test }) => html`<form class="devfee-form" data-test="${test}" @submit="${(e) => { const f = form(e); a.devFee(card, op, address, f.to, f.again); }}">
  <input name="to" aria-label="${label}" placeholder="${`${label}: 0x…`}" autocomplete="off" spellcheck="false" required>
  <input name="again" aria-label="The same address again" placeholder="The same address again" autocomplete="off" spellcheck="false" required>
  <button type="submit" disabled="${busy}">${button}</button>
</form>`;

function slotCard(a, address) {
  const m = () => slotAt(address);
  const card = `devfee-slot-${address.toLowerCase()}`;
  const total = () => (m()?.claimable ?? 0n) + (m()?.waiting ?? 0n);
  const gated = () => m() && m().trigger !== zeroAddress;
  return html`<section class="card" data-test="devfee-slot" data-splitter="${address}">
    <h2>Your share</h2>
    <dl class="facts">
      ${fact('Splitter', 'devfee-splitter', () => name(address))}
      ${fact('Share', 'devfee-share', () => (m() ? `${pct(m().shares)} of this splitter · ${pct(m().wholeBps)} of the whole dev fee` : ''))}
      <div class="fact"><dt>Claimable</dt><dd class="claim-dd"><span data-test="devfee-claimable">${() => satori(total())}</span>
        <button class="primary" data-test="devfee-claim" hidden="${() => !(total() > 0n)}" disabled="${busy}" @click="${() => a.devFee(card, 'claim', address)}">${() => (state.devFeeBusy === `claim:${address}` ? 'Claiming…' : 'Claim')}</button></dd></div>
    </dl>
    <p class="muted small" data-test="devfee-waiting" hidden="${() => !(m()?.waiting > 0n)}">${() => `${satori(m()?.waiting)} of it is still in the top splitter: Claim moves it down to yours first (two transactions).`}</p>
    <p class="muted small">Your share is fixed for good. It waits in the splitter until it is claimed, and it is always paid to you, whoever claims it.</p>
    ${unlockPrompt(a, card, 'claim or change your dev fee slot')}
    ${outcome(card)}
    <details class="devfee-more" data-test="devfee-trigger-card">
      <summary>${() => (gated() ? `Only ${shortHash(m().trigger)} can trigger your payout` : 'Who can trigger your payout')}</summary>
      <p class="muted small">By default anyone can, which is harmless: the SATORI always goes to you. Naming an address means only it (and you) can. You can change it any time; moving your slot clears it.</p>
      <form class="devfee-form" @submit="${(e) => a.devFee(card, 'trigger', address, form(e).to ?? '')}">
        <input name="to" data-test="devfee-trigger-to" aria-label="The address allowed to trigger it (empty: anyone)" placeholder="0x… (empty: anyone)" autocomplete="off" spellcheck="false">
        <button type="submit" data-test="devfee-trigger" disabled="${busy}">Save</button>
      </form>
    </details>
    <details class="devfee-more" data-test="devfee-move-card">
      <summary>Move your slot to another address</summary>
      <p class="small"><strong>This can't be undone from this wallet.</strong> The new address takes the slot and every payment from now on, and only it can move the slot again. What you already claimed stays yours.</p>
      ${twice(a, card, 'moveSlot', address, { label: 'New address', button: 'Move my slot', test: 'devfee-move' })}
    </details>
  </section>`;
}

function redirectCard(a, address) {
  const n = () => nodeAt(address);
  const card = `devfee-redirect-${address.toLowerCase()}`;
  const p = () => (same(d().proposal?.splitter, address) ? d().proposal : null);
  return html`<details class="card" data-test="devfee-redirect" data-splitter="${address}">
    <summary>${() => `Redirect ${name(address)}`}</summary>
    <p class="small"><strong>This moves everyone's income, not just yours.</strong> Every future payment the top splitter makes to this one goes to the new address instead. What is already in this splitter stays claimable, at the same shares.</p>
    <p class="muted small">${() => (n() ? `It needs ${pct(n().thresholdBps)} of this splitter's shares to agree${n().authority !== zeroAddress ? ', or its authority acting alone' : ''}. Then anyone can carry it out.` : '')}</p>
    <form class="devfee-form" @submit="${(e) => a.devFeeCheck(address, form(e).to)}">
      <input name="to" data-test="devfee-redirect-to" aria-label="Redirect it to" placeholder="Redirect it to: 0x…" autocomplete="off" spellcheck="false" required>
      <button type="submit" data-test="devfee-redirect-check">Check</button>
    </form>
    <div data-test="devfee-tally" hidden="${() => !p()}">
      <p class="error small" hidden="${() => !p()?.error}">${() => p()?.error ?? ''}</p>
      <p class="small" hidden="${() => !!p()?.error}">${() => (p() && !p().error ? `${fmtNum(Number(p().agreedBps) / 100)}% agree of ${pct(p().thresholdBps)} needed. ${p().cleared ? 'Enough: anyone can carry it out now.' : 'Not enough yet.'} You have ${p().iAgreed ? '' : 'not '}agreed.` : '')}</p>
      <div class="actions" hidden="${() => !!p()?.error}">
        <button data-test="devfee-vote" disabled="${busy}" @click="${() => a.devFee(card, p()?.iAgreed ? 'unvote' : 'vote', address, p()?.to)}">${() => (p()?.iAgreed ? 'Take back my agreement' : 'Agree to this')}</button>
      </div>
      <div hidden="${() => !p()?.cleared}">
        ${twice(a, card, 'redirect', address, { label: 'Carry it out to', button: 'Redirect it', test: 'devfee-redirect-do' })}
      </div>
    </div>
    ${unlockPrompt(a, card, 'redirect this splitter')}
    ${outcome(card)}
  </details>`;
}

function authorityCard(a, address) {
  const n = () => nodeAt(address);
  const card = `devfee-authority-${address.toLowerCase()}`;
  const holds = () => !!n()?.isAuthority;
  return html`<section class="card" data-test="devfee-authority" data-splitter="${address}">
    <h2>${() => `Authority of ${name(address)}`}</h2>
    <p class="muted small">The authority can redirect this splitter on its own: every future payment the top splitter makes to it goes elsewhere. That is its only power: it can't change anyone's share or claim anyone's SATORI.</p>
    <div class="side-row" hidden="${() => !n()?.isOffered}">
      <p class="small">${() => (n()?.isOffered ? `${shortHash(n().authority)} offered this wallet the authority. It moves when you accept.` : '')}</p>
      <button class="primary" data-test="devfee-accept" disabled="${busy}" @click="${() => a.devFee(card, 'accept', address)}">Accept</button>
    </div>
    <div hidden="${() => !holds()}">
      <h3>Redirect it alone</h3>
      ${twice(a, card, 'redirect', address, { label: 'New address', button: 'Redirect it', test: 'devfee-authority-redirect' })}
      <h3>Offer it to another address</h3>
      <p class="muted small" hidden="${() => !(n()?.pendingAuthority && n().pendingAuthority !== zeroAddress)}">${() => (n()?.pendingAuthority && n().pendingAuthority !== zeroAddress ? `Offered to ${shortHash(n().pendingAuthority)}; a new offer replaces it.` : '')}</p>
      ${twice(a, card, 'offer', address, { label: 'Offer it to', button: 'Offer', test: 'devfee-offer' })}
      <h3>Give it up</h3>
      <p class="muted small">For good: then only its payees' agreement can redirect it.</p>
      <div class="actions" hidden="${() => state.devFeeGiveUp === address}"><button data-test="devfee-give-up" disabled="${busy}" @click="${() => { state.devFeeGiveUp = address; }}">Give up the authority</button></div>
      <div class="confirm" hidden="${() => state.devFeeGiveUp !== address}">
        <p class="small">Give up this splitter's authority for good? No one can take it again.</p>
        <div class="actions"><button data-test="devfee-give-up-yes" disabled="${busy}" @click="${() => { state.devFeeGiveUp = ''; a.devFee(card, 'giveUp', address); }}">Give it up</button><button @click="${() => { state.devFeeGiveUp = ''; }}">Cancel</button></div>
      </div>
    </div>
    ${unlockPrompt(a, card, 'act as its authority')}
    ${outcome(card)}
  </section>`;
}

export function devFeeTab(a) {
  const t = () => d().tree;
  const slots = () => (t()?.mine ?? []).map((m) => m.node);
  const branches = () => (t()?.nodes ?? []).filter((n) => n.parent && n.mySlotId != null).map((n) => n.address);
  const held = () => (t()?.nodes ?? []).filter((n) => n.isAuthority || n.isOffered).map((n) => n.address);
  return html`
  <section class="tab-page" data-test="devfee-tab" hidden="${() => state.tab !== 'devfee'}">
    <section class="card">
      <header class="card-head">
        <h2>Dev Fee</h2>
        <button class="small-btn" data-test="devfee-refresh" disabled="${busy}" @click="${a.devFeeRefresh}">Refresh</button>
      </header>
      <p class="muted small">A share of every round goes to the dev fee's splitters, set in the Satori token for good. Each slot's share in them never changes, and nothing arrives on its own: it waits in its splitter until it is claimed.</p>
      <p class="error small" role="status" data-test="devfee-read-error" hidden="${() => !d().error}">${() => (d().error ? `The chain did not answer: ${d().error}` : '')}</p>
      <p class="muted small" hidden="${() => !!t()}">Reading the splitters…</p>
    </section>
    ${() => slots().map((x) => slotCard(a, x).key(`slot:${x}`))}
    ${() => branches().map((x) => redirectCard(a, x).key(`redirect:${x}`))}
    ${() => held().map((x) => authorityCard(a, x).key(`authority:${x}`))}
  </section>`;
}
