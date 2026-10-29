// Admin (docs/design/admin.md): only for the Satori contract's admin (SatoriRewards.admin()). A card per lever: the
// capabilities, the games' approval, the official relayer, the registration fee, the off-chain reporter, an official
// adapter, and handing the admin on. Every action is the wallet's: the inline Unlock in its card.
import { html } from '@arrow-js/core';
import { formatEther, zeroAddress } from 'viem';
import { state } from './state.js';
import { fact, form, unlockPrompt } from './parts.js';
import { fmtNum, shortHash } from './format.js';
import { txLink } from './wallet.js';

const d = () => state.admin;
const l = () => d().levers;
const busy = () => !!state.adminBusy;
const who = (a) => (!a || a === zeroAddress ? 'None' : shortHash(a));

/** An action's outcome, in the card (`card`) it was asked from. */
const outcome = (card) => html`<div>
  <p class="small" role="status" data-test="${() => (d().did === card ? 'admin-result' : false)}" hidden="${() => d().did !== card || !d().result}">${() => d().result}</p>
  <div class="txs" hidden="${() => d().did !== card || !d().txs.length}">${() => (d().did === card ? d().txs.map((t) => txLink(t.hash, t.label).key(t.hash)) : '')}</div>
  <p class="error small" role="alert" data-test="${() => (d().did === card ? 'admin-error' : false)}" hidden="${() => d().did !== card || !d().actionError}">${() => d().actionError}</p>
</div>`;

/** A card of one address-or-amount lever: what it is now, a field, Save. */
function setting(a, { card, title, text, now, nowTest, field, op }) {
  return html`<section class="card" data-test="${card}">
    <h2>${title}</h2>
    <dl class="facts">${fact('Now', nowTest, now)}</dl>
    <p class="muted small">${text}</p>
    <form class="devfee-form" @submit="${(e) => a.admin(card, op, [form(e).v ?? ''])}">
      <input name="v" data-test="${`${card}-to`}" aria-label="${field}" placeholder="${field}" autocomplete="off" spellcheck="false">
      <button type="submit" data-test="${`${card}-save`}" disabled="${busy}">Save</button>
    </form>
    ${unlockPrompt(a, card, 'change it')}
    ${outcome(card)}
  </section>`;
}

function capabilitiesCard(a) {
  const card = 'admin-capabilities';
  return html`<section class="card" data-test="${card}">
    <h2>Capabilities</h2>
    <p class="muted small">What everyone may do. Off means only the admin may: the admin can always do all of them.</p>
    <form @submit="${(e) => { const f = form(e); a.admin(card, 'capabilities', [(l()?.capabilities ?? []).filter((c) => f[`cap${c.bit}`]).map((c) => c.bit)]); }}">
      <div class="admin-caps">${() => (l()?.capabilities ?? []).map((c) => html`<label class="admin-cap" data-test="admin-cap">
        <input type="checkbox" name="${`cap${c.bit}`}" checked="${c.on}"><span><b>${c.name}</b><span class="muted small">${c.text}</span></span>
      </label>`.key(`${c.bit}:${c.on}`))}</div>
      <div class="actions"><button type="submit" class="primary" data-test="admin-caps-save" disabled="${busy}">Save</button></div>
    </form>
    ${unlockPrompt(a, card, 'change the capabilities')}
    ${outcome(card)}
  </section>`;
}

function gamesCard(a) {
  const card = 'admin-games';
  return html`<section class="card" data-test="${card}">
    <h2>Games</h2>
    <p class="muted small">A game earns nothing until it is approved (the default game always is). Disapproving one stops it earning; its voters keep their weight and can move it to another game. Either way can be undone.</p>
    <div class="admin-games">${() => (l()?.games ?? []).map((g) => html`<div class="admin-game" data-test="admin-game" data-game="${g.gameId}">
      <span class="admin-game-name"><b>${g.name}</b><span class="muted small">${`stream ${g.streamId} · game ${g.gameId}`}</span></span>
      <span class="admin-game-do"><span class="${g.approved ? 'chip' : 'chip n'}">${g.isDefault ? 'Always approved' : g.approved ? 'Approved' : 'Not approved'}</span>
      <button class="small-btn" hidden="${g.isDefault}" disabled="${busy}" @click="${() => a.admin(card, 'game', [g.gameId, !g.approved])}">${g.approved ? 'Disapprove' : 'Approve'}</button></span>
    </div>`.key(`${g.gameId}:${g.approved}`))}</div>
    ${unlockPrompt(a, card, 'change a game')}
    ${outcome(card)}
  </section>`;
}

function adapterCard(a) {
  const card = 'admin-adapter';
  return html`<details class="card" data-test="${card}">
    <summary>Register an official adapter</summary>
    <p class="muted small">Adds a stream or game adapter as an official one, with no fee. Anyone else registering one needs the capability, and burns the registration fee.</p>
    <form class="devfee-form" @submit="${(e) => { const f = form(e); a.admin(card, 'registerAdapter', [f.kind, f.impl ?? '', f.name ?? '']); }}">
      <select name="kind" aria-label="Kind" data-test="admin-adapter-kind"><option value="stream">Stream adapter</option><option value="game">Game adapter</option></select>
      <input name="impl" aria-label="Its contract address" placeholder="Its contract address: 0x…" autocomplete="off" spellcheck="false" required>
      <input name="name" aria-label="Its name" placeholder="Its name" autocomplete="off" required>
      <button type="submit" data-test="admin-adapter-save" disabled="${busy}">Register</button>
    </form>
    ${unlockPrompt(a, card, 'register it')}
    ${outcome(card)}
  </details>`;
}

function transferCard(a) {
  const card = 'admin-transfer';
  return html`<details class="card" data-test="${card}">
    <summary>Hand the admin to another address</summary>
    <p class="small"><strong>This happens at once, and this wallet can't take it back.</strong> The new address holds every lever on this page; the token's appoint authority can still replace the admin.</p>
    <form class="devfee-form" @submit="${(e) => { const f = form(e); a.admin(card, 'transfer', [f.to], f.again); }}">
      <input name="to" aria-label="New admin" placeholder="New admin: 0x…" autocomplete="off" spellcheck="false" required>
      <input name="again" aria-label="The same address again" placeholder="The same address again" autocomplete="off" spellcheck="false" required>
      <button type="submit" data-test="admin-transfer-save" disabled="${busy}">Hand it on</button>
    </form>
    ${unlockPrompt(a, card, 'hand the admin on')}
    ${outcome(card)}
  </details>`;
}

export function adminTab(a) {
  return html`
  <section class="tab-page" data-test="admin-tab" hidden="${() => state.tab !== 'admin'}">
    <section class="card">
      <header class="card-head">
        <h2>Admin</h2>
        <button class="small-btn" data-test="admin-refresh" disabled="${busy}" @click="${a.adminRefresh}">Refresh</button>
      </header>
      <p class="muted small">This wallet is the Satori contract's admin. Each change here is a transaction from it, which the contracts take from no one else.</p>
      <p class="error small" role="status" data-test="admin-read-error" hidden="${() => !d().error}">${() => (d().error ? `The chain did not answer: ${d().error}` : '')}</p>
      <p class="muted small" hidden="${() => !!l()}">Reading the contracts…</p>
    </section>
    <div hidden="${() => !l()}">
      ${capabilitiesCard(a)}
      ${gamesCard(a)}
      ${setting(a, { card: 'admin-relayer', title: 'Official relayer', op: 'relayer', nowTest: 'admin-relayer-now', now: () => who(l()?.relayer),
        field: 'Relayer address (empty: none)',
        text: "The one relayer that may be paid out of a person's unclaimed rewards after they predict. Anyone can still relay; this only decides who can be paid that way." })}
      ${setting(a, { card: 'admin-fee', title: 'Registration fee', op: 'registrationFee', nowTest: 'admin-fee-now',
        now: () => (l() ? `${fmtNum(Number(formatEther(l().registrationFee)))} SATORI` : ''), field: 'SATORI per registration',
        text: 'SATORI burned to register a community stream or game adapter. Raise it before switching those capabilities on: each registration takes one of a limited number of ids.' })}
      ${setting(a, { card: 'admin-reporter', title: 'Off-chain reporter', op: 'reporter', nowTest: 'admin-reporter-now',
        now: () => (l()?.reporter && l().reporter !== zeroAddress ? shortHash(l().reporter) : 'Off'), field: 'Reporter address (empty: off)',
        text: "The one key that may add off-chain predictions to the default stream's count, so it doesn't fall as predictors are paid off-chain." })}
      ${adapterCard(a)}
      ${transferCard(a)}
    </div>
  </section>`;
}
