// The other special keys' tabs (docs/design/roles.md): one per key the wallet holds (or was offered), drawn from
// src/neuron/roles.js's ROLES. Each: what the key is, its values now, then a card per action (its value now, a field,
// typed twice for the ones that can't be taken back, or one button that asks first). Every action is the wallet's.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { fact, form, unlockPrompt } from './parts.js';
import { txLink } from './wallet.js';
import { ROLES } from '../neuron/roles.js';

const R = () => state.roles;
const busy = () => !!state.rolesBusy;

/** An action's outcome, in the card it was asked from. */
const outcome = (card) => html`<div>
  <p class="small" role="status" data-test="${() => (R().did === card ? 'role-result' : false)}" hidden="${() => R().did !== card || !R().result}">${() => R().result}</p>
  <div class="txs" hidden="${() => R().did !== card || !R().txs.length}">${() => (R().did === card ? R().txs.map((t) => txLink(t.hash, t.label).key(t.hash)) : '')}</div>
  <p class="error small" role="alert" data-test="${() => (R().did === card ? 'role-error' : false)}" hidden="${() => R().did !== card || !R().actionError}">${() => R().actionError}</p>
</div>`;

function actionCard(a, role, x) {
  const card = `${role.id}:${x.id}`;
  const st = () => R().of?.[role.id];
  const v = () => st()?.values;
  const shown = () => !!v() && (x.show ? x.show(v(), st()) : !!st()?.isHolder);
  const frozen = () => !!v() && !!x.frozen?.(v());
  const body = html`
    ${x.now ? html`<dl class="facts">${fact('Now', `role-now-${x.id}`, () => (v() ? x.now(v()) : ''))}</dl>` : ''}
    <p class="muted small">${x.text}</p>
    ${x.field ? html`<form class="devfee-form" @submit="${(e) => { const f = form(e); a.role(role.id, x.id, f.v ?? '', x.twice ? f.again ?? '' : undefined); }}">
      <input name="v" data-test="role-input" aria-label="${x.field.label}" placeholder="${x.field.label}" autocomplete="off" spellcheck="false" disabled="${frozen}">
      ${x.twice ? html`<input name="again" data-test="role-again" aria-label="The same again" placeholder="The same again" autocomplete="off" spellcheck="false" disabled="${frozen}">` : ''}
      <button type="submit" data-test="role-save" disabled="${() => busy() || frozen()}">${() => (frozen() ? 'Frozen' : 'Save')}</button>
    </form>` : x.asks ? html`
      <div class="actions" hidden="${() => R().ask === card}"><button data-test="role-do" disabled="${busy}" @click="${() => a.roleAsk(card)}">${x.title}</button></div>
      <div class="confirm" hidden="${() => R().ask !== card}">
        <p class="small">${x.asks}</p>
        <div class="actions"><button data-test="role-yes" disabled="${busy}" @click="${() => a.role(role.id, x.id)}">${x.title}</button><button @click="${() => a.roleAsk('')}">Cancel</button></div>
      </div>` : html`<div class="actions"><button class="primary" data-test="role-do" disabled="${busy}" @click="${() => a.role(role.id, x.id)}">${x.title}</button></div>`}
    ${unlockPrompt(a, card, `change ${x.title.toLowerCase()}`)}
    ${outcome(card)}`;
  return x.folded
    ? html`<details class="card" data-test="role-card" data-action="${x.id}" hidden="${() => !shown()}"><summary>${x.title}</summary>${body}</details>`
    : html`<section class="card" data-test="role-card" data-action="${x.id}" hidden="${() => !shown()}"><h2>${x.title}</h2>${body}</section>`;
}

function roleTab(a, role) {
  const st = () => R().of?.[role.id];
  return html`<section class="tab-page" data-test="${`tab-page-${role.id}`}" hidden="${() => state.tab !== role.id}">
    <section class="card">
      <header class="card-head">
        <h2>${role.label}</h2>
        <button class="small-btn" data-test="role-refresh" disabled="${busy}" @click="${a.rolesRefresh}">Refresh</button>
      </header>
      <p class="muted small">${role.intro}</p>
      <dl class="facts">${() => (st()?.values ? role.facts(st().values).map(([l, t]) => fact(l, 'role-fact', t).key(`${l}:${t}`)) : '')}</dl>
      <p class="error small" role="status" hidden="${() => !R().error}">${() => (R().error ? `The chain did not answer: ${R().error}` : '')}</p>
    </section>
    ${role.actions.map((x) => actionCard(a, role, x))}
  </section>`;
}

export const rolesTabs = (a) => html`${ROLES.map((r) => roleTab(a, r))}`;
