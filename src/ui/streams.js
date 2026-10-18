// Streams: the Satori Network's (central: the data flow's facts and Poll now; each stream with its forecast, model and
// companions, and its history on a tap), the subscriptions on the Satori relays (Nostr), and the relays' streams to
// discover. The words people see (docs/intent/ui.md); the addresses are Settings'.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { fact, sparkPath } from './parts.js';
import {
  fmtNum, fmtWhen, registrationText, mismatchText, pollText, submitText, modelTitle, modelText, historyText,
  fmtCadence, shortKey, obsText, rawText, catalogMatch, predText,
} from './format.js';

export const CATALOG_SHOWN = 50;

function centralCard(a) {
  const c = () => state.central;
  return html`
  <section class="card central">
    <header class="card-head">
      <h2>Satori Network <small class="muted">free</small></h2>
      <button class="small-btn" data-test="poll-now" @click="${a.pollNow}" disabled="${() => state.central.polling}">${() => (state.central.polling ? 'Polling…' : 'Poll now')}</button>
    </header>
    <dl class="facts">
      ${fact('Registered', 'registered', () => registrationText(c().registration))}
      ${fact('Last poll', 'last-poll', () => pollText(c().lastPoll))}
      ${fact('Next poll', 'next-poll', () => fmtWhen(c().nextPoll))}
      ${fact('Last submission', 'last-submit', () => submitText(c().lastSubmit))}
      ${fact('Pending', 'pending', () => String(c().pending))}
      ${fact('History', 'history', () => historyText(c().history))}
    </dl>
    <p class="error small" role="status" data-test="mismatch" hidden="${() => !mismatchText(c().registration)}">${() => mismatchText(c().registration)}</p>
  </section>`;
}

function streamRow(r, names, a) {
  // One root node, no whitespace around it: ArrowJS 1.0.6 breaks a keyed list
  // of multi-node items once it goes empty and back.
  const sent = r.status === 'sent';
  return html`<div class="row srow" data-test="stream"><button class="sname" title="${r.uuid}" @click="${() => a.openStream(r.uuid)}">${r.name}</button><span class="num" data-label="Latest" data-test="obs">${fmtNum(r.obs_value)}</span><span class="muted small" data-label="Observed">${fmtWhen(r.obs_ts)}</span><span class="num" data-label="t1" data-test="t1">${fmtNum(r.t1)}</span><span class="num accent" data-label="t2" data-test="t2">${fmtNum(r.t2)}</span><span class="model" data-label="Model" data-test="model" title="${modelTitle(r, names)}">${modelText(r, names)}</span><span class="${r.status ? (sent ? 'badge on' : 'badge') : 'muted'}" data-test="status">${r.status ? (sent ? 'Sent' : 'Pending') : '–'}</span></div>`;
}

const predRow = (p) => html`<li data-test="stream-prediction"><span>${fmtWhen(p.made_at)}</span><span>${p.model}</span><span>${`t2 ${fmtNum(p.t2)}`}</span><span>${p.status === 'sent' ? 'Sent' : 'Pending'}</span></li>`;

/** The open stream: its trend, its model in words, its latest predictions. */
function detail(a) {
  const r = () => state.streams.find((s) => s.uuid === state.streamOpen);
  const names = () => new Map(state.streams.map((s) => [s.uuid, s.name]));
  return html`
    <div class="detail" data-test="stream-detail" hidden="${() => !r()}">
      <div class="card-head"><h3>${() => r()?.name ?? ''}</h3><button class="small-btn" @click="${() => a.openStream('')}">Close</button></div>
      <svg class="spark" viewBox="0 0 70 20" preserveAspectRatio="none" aria-hidden="true"><path d="${() => sparkPath(state.sparks[state.streamOpen])}"></path></svg>
      <p class="small muted">${() => (r() ? modelTitle(r(), names()) || 'No model yet' : '')}</p>
      <ol>${() => state.streamPreds.map((p) => predRow(p).key(`${p.id}:${p.status}`))}</ol>
    </div>`;
}

function streamsCard(a) {
  return html`
  <section class="card" data-test="streams">
    <header class="card-head"><h2>Streams</h2><span class="muted small" data-test="streams-count">${() => (state.streams.length ? `${state.streams.length} from the Satori Network, with our forecasts` : '')}</span></header>
    <p class="muted small" hidden="${() => state.streams.length > 0}">Streams: none yet. They arrive with the first poll.</p>
    <div class="srows" hidden="${() => !state.streams.length}">
      <div class="row srow head" aria-hidden="true"><span>Stream</span><span class="num">Latest</span><span>Observed</span><span class="num">t1</span><span class="num">t2</span><span>Model</span><span></span></div>
      <div>${() => {
        const names = new Map(state.streams.map((r) => [r.uuid, r.name]));
        return state.streams.map((r) => streamRow(r, names, a).key(r.uuid));
      }}</div>
    </div>
    ${detail(a)}
  </section>`;
}

/** The relays in a few words (their addresses and each one's state are in Settings). */
function relaysText(relays) {
  const up = relays.filter((r) => r.state === 'open').length;
  return relays.length ? `${up} of ${relays.length} relay${relays.length === 1 ? '' : 's'} connected` : 'no relay';
}

function subRow(s, a) {
  // One root node, no whitespace around it (see streamRow).
  const p = s.prediction;
  return html`<div class="row nrow" data-test="sub"><span class="sname" title="${`${s.stream} from ${s.provider}`}">${s.name || s.stream}</span><span class="num" data-label="Latest" data-test="sub-obs" title="${s.observation ? `sent as ${rawText(s.observation)}` : ''}">${obsText(s.observation)}</span><span class="muted small" data-label="Observed">${fmtWhen(s.observation?.ts)}</span><span class="num accent" data-label="Our _pred" data-test="sub-pred" title="${p ? `${p.stream} · ${p.model} · sent as "${p.value}"` : ''}">${predText(p?.value)}</span><span class="num muted" data-label="Seq" data-test="sub-seq">${p?.seq ?? '–'}</span><span class="muted small" data-label="Relays" data-test="sub-relays">${p ? `${p.relays} relay${p.relays === 1 ? '' : 's'}` : '–'}</span><button class="link" data-test="unsubscribe" @click="${() => a.subscribe(s.provider, s.stream, false)}" disabled="${() => !!state.subscribing}">Unsubscribe</button></div>`;
}

function nostrCard(a) {
  const n = () => state.nostr;
  return html`
  <section class="card nostr">
    <header class="card-head">
      <h2>Satori relays</h2>
      <span class="muted small">${() => `${n().subscriptions.length} of ${n().maxStreams} streams · ${relaysText(n().relays)}`}</span>
    </header>
    <p class="muted" hidden="${() => n().subscriptions.length > 0}">No streams yet: subscribe under Streams on the relays. Each new observation is forecast and published as <code>&lt;stream&gt;_pred</code>.</p>
    <div class="srows" hidden="${() => !n().subscriptions.length}">
      <div class="row nrow head" aria-hidden="true"><span>Stream</span><span class="num">Latest</span><span>Observed</span><span class="num">Our _pred</span><span class="num">Seq</span><span>Relays</span><span></span></div>
      <div>${() => n().subscriptions.map((s) => subRow(s, a).key(`${s.uuid} ${s.observation?.seq} ${s.prediction?.seq}`))}</div>
    </div>
  </section>`;
}

function catRow(s, a) {
  const key = `${s.pubkey}:${s.stream_name}`;
  const paid = s.price_per_obs > 0 || s.encrypted || s.approval_required;
  return html`<div class="crow" data-test="catalog-row"><div class="cmain"><span class="sname">${s.name || s.stream_name}</span> <span class="muted small">${s.stream_name} · ${fmtCadence(s.cadence_seconds)} · <span class="nowrap" title="${s.pubkey}">${shortKey(s.pubkey)}</span>${paid ? ' · paid or gated (later)' : ''}</span><div class="muted small desc">${s.description}</div></div><button class="${s.subscribed ? 'small-btn' : 'small-btn primary'}" data-test="catalog-action" disabled="${() => paid || !!state.subscribing}" @click="${() => a.subscribe(s.pubkey, s.stream_name, !s.subscribed)}">${() => (state.subscribing === key ? '…' : s.subscribed ? 'Unsubscribe' : 'Subscribe')}</button></div>`;
}

const shownCatalog = () => state.catalog.filter((s) => !s.pred && catalogMatch(s, state.catalogQuery));

function network(a) {
  const total = () => state.catalog.filter((s) => !s.pred).length;
  const summary = () => {
    if (!state.catalog.length) return state.discovering ? 'Asking the relays…' : 'Discover the streams the relays announce.';
    const hits = shownCatalog().length;
    return `${total()} streams (${state.catalog.length - total()} prediction streams hidden) · ${hits} match`
      + (hits > CATALOG_SHOWN ? `, the first ${CATALOG_SHOWN} shown` : '');
  };
  return html`
  <details class="card" data-test="network" @toggle="${(e) => e.target.open && !state.catalog.length && !state.discovering && a.discover()}">
    <summary>Streams on the relays</summary>
    <form class="search" @submit="${(e) => { e.preventDefault(); a.discover(); }}">
      <input name="q" type="search" aria-label="Search streams" placeholder="Search: bitcoin, weather, …" autocomplete="off"
        @input="${(e) => (state.catalogQuery = e.target.value)}">
      <button type="submit" disabled="${() => state.discovering}">${() => (state.discovering ? 'Discovering…' : state.catalog.length ? 'Refresh' : 'Discover')}</button>
    </form>
    <p class="muted small" data-test="catalog-summary">${() => state.networkLine || summary()}</p>
    <p class="error small" role="alert" hidden="${() => !state.networkError}">${() => state.networkError}</p>
    <div class="crows">${() => shownCatalog().slice(0, CATALOG_SHOWN).map((s) => catRow(s, a).key(`${s.pubkey}:${s.stream_name}:${s.subscribed}`))}</div>
  </details>`;
}

export function streamsTab(a) {
  return html`
  <section class="tab-page" data-test="streams-tab" hidden="${() => state.tab !== 'streams'}">
    ${centralCard(a)}
    ${streamsCard(a)}
    ${nostrCard(a)}
    ${network(a)}
  </section>`;
}
