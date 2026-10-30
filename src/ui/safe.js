// The Safe tab (docs/design/safe.md): for an owner of the Safe that holds the token's keys. The Safe (its owners and
// how many must sign), its waiting transactions (Sign, Execute), then a card per key's action, which proposes it to the
// Safe with this wallet's signature. Drawn from src/neuron/safe.js's SAFE_KEYS.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { fact, form, unlockPrompt } from './parts.js';
import { shortHash } from './format.js';
import { txLink } from './wallet.js';
import { SAFE_KEYS } from '../neuron/safe.js';

const S = () => state.safe;
const safe = () => S().safes?.[0];
const busy = () => !!state.safeBusy;

const outcome = (card) => html`<div>
  <p class="small" role="status" data-test="${() => (S().did === card ? 'safe-result' : false)}" hidden="${() => S().did !== card || !S().result}">${() => S().result}</p>
  <div class="txs" hidden="${() => S().did !== card || !S().txs.length}">${() => (S().did === card ? S().txs.map((t) => txLink(t.hash, t.label).key(t.hash)) : '')}</div>
  <p class="error small" role="alert" data-test="${() => (S().did === card ? 'safe-error' : false)}" hidden="${() => S().did !== card || !S().actionError}">${() => S().actionError}</p>
</div>`;

function waitingCard(a) {
  const row = (t) => html`<li class="safe-tx" data-test="safe-tx" data-nonce="${String(t.nonce)}">
    <span class="safe-tx-what"><b>${t.description}</b><span class="muted small">${`Transaction ${t.nonce} · ${t.confirmations.length} of ${safe()?.threshold} signed${t.signedByMe ? ', you too' : ''}`}</span></span>
    <span class="safe-tx-do">
      <button class="small-btn" data-test="safe-sign" hidden="${t.signedByMe}" disabled="${busy}" @click="${() => a.safeWaiting('sign', t.safeTxHash)}">Sign</button>
      <button class="small-btn primary" data-test="safe-execute" hidden="${!(t.enough && t.next)}" disabled="${busy}" @click="${() => a.safeWaiting('execute', t.safeTxHash)}">Execute</button>
    </span>
  </li>`.key(`${t.safeTxHash}:${t.confirmations.length}:${t.signedByMe}`);
  return html`<section class="card" data-test="safe-waiting">
    <h2>Waiting</h2>
    <p class="muted small" hidden="${() => !!safe()?.pending.length}">Nothing is waiting for signatures.</p>
    <ul class="safe-txs">${() => (safe()?.pending ?? []).map(row)}</ul>
    <p class="muted small" hidden="${() => !safe()?.pending.length}">Signing is free. Execute sends the transaction from this wallet (it pays the gas) once enough owners signed; they run in order.</p>
    ${unlockPrompt(a, 'safe-waiting', 'sign for the Safe')}
    ${outcome('waiting')}
  </section>`;
}

function actionCard(a, k, x) {
  const card = `${k.id}:${x.id}`;
  const v = () => safe()?.keys[k.id];
  const shown = () => !!v() && (!x.show || x.show(v()));
  const f = x.field;
  const submit = (e) => {
    const d = form(e);
    const pre = f?.kind.choose ? `${d.c} ` : '';
    a.safe(k.id, x.id, f?.kind.choose && !d.v ? d.c : `${pre}${d.v ?? ''}`, x.twice ? `${pre}${d.again ?? ''}` : undefined);
  };
  const fieldset = !f ? '' : html`
    ${f.kind.choose ? html`<select name="c" data-test="safe-choose" aria-label="Contract">${f.kind.choose.map(([val, label]) => html`<option value="${val}">${label}</option>`)}</select>` : ''}
    ${f.kind.lines ? html`<textarea name="v" data-test="safe-input" aria-label="${f.label}" placeholder="${f.label}" rows="4" spellcheck="false"></textarea>`
      : f.kind.choose && !x.twice ? '' : html`<input name="v" data-test="safe-input" aria-label="${f.label}" placeholder="${f.label}" autocomplete="off" spellcheck="false">`}
    ${x.twice ? html`<input name="again" data-test="safe-again" aria-label="The same again" placeholder="The same again" autocomplete="off" spellcheck="false">` : ''}`;
  const body = html`
    ${x.now ? html`<dl class="facts">${fact('Now', `safe-now-${x.id}`, () => (v() ? x.now(v()) : ''))}</dl>` : ''}
    <p class="muted small">${x.text}</p>
    ${x.asks ? html`
      <div class="actions" hidden="${() => S().ask === card}"><button data-test="safe-ask" disabled="${busy}" @click="${() => a.safeAsk(card)}">${x.title}</button></div>
      <form class="devfee-form confirm" hidden="${() => S().ask !== card}" @submit="${submit}">
        <p class="small">${x.asks} The other owners sign it too before it runs.</p>
        ${fieldset}
        <div class="actions"><button type="submit" data-test="safe-propose" disabled="${busy}">Propose</button><button type="button" @click="${() => a.safeAsk('')}">Cancel</button></div>
      </form>`
    : html`<form class="devfee-form" @submit="${submit}">${fieldset}<button type="submit" data-test="safe-propose" disabled="${busy}">Propose</button></form>`}
    ${unlockPrompt(a, `safe-${card}`, 'sign the proposal')}
    ${outcome(card)}`;
  // folded, each (a key's whole page would be a long scroll on a phone): its title, open to act
  return html`<details class="card" data-test="safe-card" data-key="${k.id}" data-action="${x.id}" hidden="${() => !shown()}"><summary>${x.title}</summary>${body}</details>`;
}

function keySection(a, k) {
  const v = () => safe()?.keys[k.id];
  return html`<div data-test="safe-key" data-key="${k.id}" hidden="${() => !v()}">
    <section class="card safe-key-head">
      <h2>${k.name}</h2>
      <p class="muted small">${k.intro}</p>
      <dl class="facts">${() => (v() ? k.facts(v()).map(([l, t]) => fact(l, 'safe-fact', t).key(`${l}:${t}`)) : '')}</dl>
    </section>
    ${k.actions.map((x) => actionCard(a, k, x))}
  </div>`;
}

export function safeTab(a) {
  return html`<section class="tab-page" data-test="safe-tab" hidden="${() => state.tab !== 'safe'}">
    <section class="card">
      <header class="card-head">
        <h2>Safe</h2>
        <button class="small-btn" data-test="safe-refresh" disabled="${busy}" @click="${a.safeRefresh}">Refresh</button>
      </header>
      <p class="muted small">This wallet is an owner of the Safe that holds the token's keys. A change here is proposed to the Safe with your signature; it runs once enough owners sign, and any of them executes it. Proposals made here show in Safe's own app (app.safe.global), and the other way round.</p>
      <dl class="facts">
        ${fact('Safe', 'safe-address', () => shortHash(safe()?.address ?? ''))}
        ${fact('Signatures needed', 'safe-threshold', () => (safe() ? `${safe().threshold} of ${safe().owners.length} owners` : ''))}
      </dl>
      <p class="error small" role="status" hidden="${() => !S().error}">${() => (S().error ? `Could not read the Safe: ${S().error}` : '')}</p>
    </section>
    ${waitingCard(a)}
    ${SAFE_KEYS.map((k) => keySection(a, k))}
  </section>`;
}
