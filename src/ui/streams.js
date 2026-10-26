// Streams: the Satori Network's (central: one line, its facts under Details, and Poll now; each stream with its latest
// value and its forecast in 24 h; on a tap, in place, its trend, the forecast in 12 h, its model and its predictions), the subscriptions on the Satori relays (Nostr), every prediction stream on the
// relays with its verified track record (docs/design/track-record.md#ui-streams; folded, it opens on a tap), and the relays' streams to discover.
// Paid streams (docs/design/market.md) have their own tab (src/ui/market.js): the catalog sends a priced stream there (its streams for sale open).
// The words people see (docs/intent/ui.md); the addresses are Settings'.
import { html } from '@arrow-js/core';
import { formatEther } from 'viem';
import { state } from './state.js';
import { fact, sparkPath } from './parts.js';
import {
  fmtNum, fmtWhen, networkLine, registrationText, mismatchText, pollText, submitText, modelTitle, modelText, historyText,
  fmtCadence, shortKey, obsText, rawText, catalogMatch, predText, relaysText,
} from './format.js';
import { listingOf } from '../neuron/market.js';
import { watchText, recordGroups, firstRows, recordDetail, SHOWN } from './record.js';

export const CATALOG_SHOWN = 50;

function centralCard(a) {
  const c = () => state.central;
  const failing = () => (c().registration && !c().registration.ok) || !!c().lastSubmit?.error || c().lastSubmit?.successful === 0;
  return html`
  <section class="card central">
    <header class="card-head">
      <h2>Satori Network <small class="muted">free</small></h2>
      <button class="small-btn" data-test="poll-now" @click="${a.pollNow}" disabled="${() => state.central.polling}">${() => (state.central.polling ? 'Polling…' : 'Poll now')}</button>
    </header>
    <p data-test="network-line" class="${() => (failing() ? 'error' : '')}">${() => networkLine(c())}</p>
    <p class="error small" role="status" data-test="mismatch" hidden="${() => !mismatchText(c().registration)}">${() => mismatchText(c().registration)}</p>
    <details class="mdetails" data-test="network-details">
      <summary>Details</summary>
      <dl class="facts">
        ${fact('Registered', 'registered', () => registrationText(c().registration))}
        ${fact('Last poll', 'last-poll', () => pollText(c().lastPoll))}
        ${fact('Next poll', 'next-poll', () => fmtWhen(c().nextPoll))}
        ${fact('Last submission', 'last-submit', () => submitText(c().lastSubmit))}
        ${fact('Pending', 'pending', () => String(c().pending))}
        ${fact('History', 'history', () => historyText(c().history))}
      </dl>
    </details>
  </section>`;
}

function streamRow(r, names, a) {
  // One root node, no whitespace around it: ArrowJS 1.0.6 breaks a keyed list
  // of multi-node items once it goes empty and back. The detail opens in place under the row.
  const sent = r.status === 'sent';
  const open = () => state.streamOpen === r.uuid;
  return html`<div class="sitem" data-test="stream"><div class="row srow"><button class="sname" title="${r.uuid}" aria-expanded="${() => String(open())}" @click="${() => a.openStream(open() ? '' : r.uuid)}">${r.name}</button><span class="num" data-label="Latest" data-test="obs">${fmtNum(r.obs_value)}</span><span class="muted small" data-label="Observed">${fmtWhen(r.obs_ts)}</span><span class="num accent" data-label="In 24 h" data-test="t2">${fmtNum(r.t2)}</span><span class="${r.status ? (sent ? 'badge on' : 'badge') : 'muted'}" data-test="status">${r.status ? (sent ? 'Sent' : 'Pending') : '–'}</span></div>${() => (open() ? detail(r, names, a) : '')}</div>`;
}

const predRow = (p) => html`<li data-test="stream-prediction"><span>${fmtWhen(p.made_at)}</span><span>${p.model}</span><span>${`in 24 h ${fmtNum(p.t2)}`}</span><span>${p.status === 'sent' ? 'Sent' : 'Pending'}</span></li>`;

/** An open stream, under its row: its trend, the forecast in 12 h, its model, its latest predictions. */
function detail(r, names, a) {
  return html`<div class="detail" data-test="stream-detail"><div class="card-head"><h3>${r.name}</h3><button class="small-btn" @click="${() => a.openStream('')}">Close</button></div><svg class="spark" viewBox="0 0 70 20" preserveAspectRatio="none" aria-hidden="true"><path d="${() => sparkPath(state.sparks[r.uuid])}"></path></svg><dl class="facts">${fact('In 12 h', 't1', fmtNum(r.t1))}<div class="fact"><dt>Model</dt><dd data-test="model" title="${modelTitle(r, names)}">${modelText(r, names)}</dd></div></dl><p class="small muted">${modelTitle(r, names) || 'No model yet'}</p><ol>${() => state.streamPreds.map((p) => predRow(p).key(`${p.id}:${p.status}`))}</ol></div>`;
}

function streamsCard(a) {
  return html`
  <section class="card" data-test="streams">
    <header class="card-head"><h2>Streams</h2><span class="muted small" data-test="streams-count">${() => (state.streams.length ? `${state.streams.length} from the Satori Network, with our forecasts` : '')}</span></header>
    <p class="muted small" hidden="${() => state.streams.length > 0}">Streams: none yet. They arrive with the first poll.</p>
    <div class="srows" hidden="${() => !state.streams.length}">
      <div class="row srow head" aria-hidden="true"><span>Stream</span><span class="num">Latest</span><span>Observed</span><span class="num">In 24 h</span><span></span></div>
      <div>${() => {
        const names = new Map(state.streams.map((r) => [r.uuid, r.name]));
        return state.streams.map((r) => streamRow(r, names, a).key(r.uuid));
      }}</div>
    </div>
  </section>`;
}


function subRow(s, a) {
  // One root node, no whitespace around it (see streamRow).
  const p = s.prediction;
  return html`<div class="row nrow" data-test="sub"><span class="sname" title="${`${s.stream} from ${s.provider}`}">${s.name || s.stream}</span><span class="num" data-label="Latest" data-test="sub-obs" title="${s.observation ? `sent as ${rawText(s.observation)}` : ''}">${obsText(s.observation)}</span><span class="muted small" data-label="Observed">${fmtWhen(s.observation?.ts)}</span><span class="num accent" data-label="Our _pred" data-test="sub-pred" title="${p ? `${p.stream} · ${p.model} · sent as "${p.value}"` : ''}">${predText(p?.value)}</span><span class="num muted" data-label="Seq" data-test="sub-seq">${p?.seq ?? '–'}</span><span class="muted small" data-label="Relays" data-test="sub-relays">${p ? `${p.relays} relay${p.relays === 1 ? '' : 's'}` : '–'}</span><span class="subacts"><button class="small-btn" data-test="sub-predict" aria-pressed="${String(!!s.predict)}" title="${s.predict ? 'Stop predicting it: its _pred is withdrawn from the relays; still followed' : 'Predict it: each new value is forecast and the prediction published to the relays'}" @click="${() => a.setPredict(s.provider, s.stream, !s.predict)}" disabled="${() => !!state.subscribing}">${s.predict ? 'Stop predicting' : 'Predict'}</button><button class="link" data-test="unsubscribe" @click="${() => a.subscribe(s.provider, s.stream, false)}" disabled="${() => !!state.subscribing}">Unsubscribe</button></span></div>`;
}

function nostrCard(a) {
  const n = () => state.nostr;
  return html`
  <section class="card nostr">
    <header class="card-head">
      <h2>Satori relays</h2>
      <span class="muted small">${() => `${n().subscriptions.length} of ${n().maxStreams} streams · ${relaysText(n().relays)}`}</span>
    </header>
    <p class="muted" hidden="${() => n().subscriptions.length > 0}">No streams yet: subscribe under Streams on the relays to follow one. Predict it to forecast each new value and publish the prediction as <code>&lt;stream&gt;_pred</code>.</p>
    <div class="srows" hidden="${() => !n().subscriptions.length}">
      <div class="row nrow head" aria-hidden="true"><span>Stream</span><span class="num">Latest</span><span>Observed</span><span class="num">Our _pred</span><span class="num">Seq</span><span>Relays</span><span></span></div>
      <div>${() => n().subscriptions.map((s) => subRow(s, a).key(`${s.uuid} ${s.observation?.seq} ${s.prediction?.seq} ${s.predict}`))}</div>
    </div>
  </section>`;
}

// ── the track record: every prediction stream on the relays, watched on its own ──

/** An open stream's detail, in place under its row: the record in words, the pairs as a chart, since when and what counts. */
function recordOpen(a) {
  const d = () => (state.recordDetail ? recordDetail(state.recordDetail) : null);
  const c = () => d()?.chart;
  return html`<div class="detail rdetail" data-test="record-detail"><div class="card-head"><h3>${() => d()?.title ?? ''}</h3><button class="small-btn" @click="${() => a.openRecord('')}">Close</button></div><p class="muted small">${() => d()?.sub ?? (state.recordError || 'Reading its record…')}</p><p class="muted small" data-test="record-source-line">${() => d()?.source ?? ''}</p><ul class="rlines">${() => (d()?.lines ?? []).map((l) => html`<li>${l}</li>`.key(l))}</ul><figure class="rchart" hidden="${() => !c()}"><svg viewBox="0 0 300 80" preserveAspectRatio="none" role="img" aria-label="${() => (c() ? `The last ${c().n} outcomes and what was predicted for each, from ${c().bottom} to ${c().top}` : '')}"><path class="ra" d="${() => c()?.actual ?? ''}"></path><path class="rp" d="${() => c()?.predicted ?? ''}"></path></svg><figcaption class="small muted"><span class="lg la">Actual</span><span class="lg lp">Predicted</span><span>${() => (c() ? `the last ${c().n} outcomes, from ${c().bottom} to ${c().top}` : '')}</span></figcaption></figure><p class="small muted" data-test="record-note">${() => d()?.note ?? ''}</p></div>`;
}

function recordItem(v, a) {
  // One root node, no whitespace around it (see streamRow); the detail opens in place under the row.
  return html`<div class="ritem" data-test="record" data-key="${v.key}" data-mark="${v.mark}"><button class="rrow" title="${v.title}" aria-expanded="${() => String(state.recordOpen === v.key)}" @click="${() => a.openRecord(state.recordOpen === v.key ? '' : v.key)}"><span class="rname"><b data-test="record-by" title="${v.byTitle}">${v.by}</b>${v.own ? html`<span class="badge warn" data-test="record-own">${v.own}</span>` : ''}</span><span class="q" data-q="${v.mark}" title="${v.markTitle}"><b data-test="record-mark" data-short="${v.markShort}">${v.markText}</b></span><span class="rfrom muted small" data-test="record-from">${v.from}</span><span class="rcad muted small">${v.cadence}</span></button>${() => (state.recordOpen === v.key ? recordOpen(a) : '')}</div>`;
}

/** A source's group: its name, its author, "not announced" when so, then its prediction streams, best first. */
function recordGroup(g, a) {
  // One root node, no whitespace around it (see streamRow); keyed by everything it shows, so a change draws it again.
  return html`<div class="rgroup" data-test="record-source" data-key="${g.key}"><div class="rsrc"><b data-test="record-source-name" title="${g.stream}">${g.name}</b><span class="muted small" data-test="record-source-by" title="${g.byTitle}">${`by ${g.by}`}</span>${g.note ? html`<span class="badge warn" data-test="record-source-note">${g.note}</span>` : ''}</div>${g.rows.map((v) => recordItem(v, a))}</div>`;
}
const groupKey = (g) => `${g.key}|${g.note}|${g.rows.map((v) => `${v.key},${v.markText},${v.from},${v.by},${v.own},${v.title}`).join(';')}`;

function recordsCard(a) {
  const groups = () => recordGroups(state.records);
  const shown = () => (state.recordsAll ? groups() : firstRows(groups(), SHOWN));
  return html`
  <details class="card records" data-test="records">
    <summary>Prediction streams <span class="muted small" data-test="records-count">${() => (state.records.length ? `${state.records.length} on the relays` : '')}</span></summary>
    <p class="muted small rstatus" data-test="records-status"><i class="spin" aria-hidden="true" hidden="${() => !state.watchLine}"></i><span>${() => state.watchLine || watchText(state.nostr.watching, state.records)}</span></p>
    <div class="rrows" hidden="${() => !state.records.length}">
      <div class="rrow head" aria-hidden="true"><span>Source, then its predictors</span><span>Against no change</span><span class="rfrom">Scored</span><span>Cadence</span></div>
      <div>${() => shown().map((g) => recordGroup(g, a).key(groupKey(g)))}</div>
    </div>
    <button class="small-btn" data-test="records-all" hidden="${() => state.recordsAll || state.records.length <= SHOWN}" @click="${() => { state.recordsAll = true; }}">${() => `Show all ${state.records.length}`}</button>
  </details>`;
}

function catRow(s, a) {
  const key = `${s.pubkey}:${s.stream_name}`;
  const l = listingOf(s);
  const paid = !l && (s.price_per_obs > 0 || s.encrypted || s.approval_required);
  return html`<div class="crow" data-test="catalog-row"><div class="cmain"><span class="sname">${s.name || s.stream_name}</span> <span class="muted small">${s.stream_name} · ${fmtCadence(s.cadence_seconds)} · <span class="nowrap" title="${s.pubkey}">${shortKey(s.pubkey)}</span>${paid ? ' · paid or gated (later)' : ''}${l ? html` · <b data-test="catalog-price">${`${formatEther(l.price)} SATORI each`}</b>` : ''}</span><div class="muted small desc">${s.description}</div></div>${l ? html`<button class="small-btn" data-test="catalog-market" @click="${() => { state.forSaleOpen = true; a.go('market'); }}">On the Market</button>` : html`<button class="${s.subscribed ? 'small-btn' : 'small-btn primary'}" data-test="catalog-action" disabled="${() => paid || !!state.subscribing}" @click="${() => a.subscribe(s.pubkey, s.stream_name, !s.subscribed)}">${() => (state.subscribing === key ? '…' : s.subscribed ? 'Unsubscribe' : 'Subscribe')}</button>`}</div>`;
}

/** Shown: the streams to subscribe to, and the ones sold on the Satori contract (prediction streams too); the rest of the prediction streams hidden. */
const listed = (s) => !s.pred || !!listingOf(s);
const shownCatalog = () => state.catalog.filter((s) => listed(s) && catalogMatch(s, state.catalogQuery));

function network(a) {
  const total = () => state.catalog.filter(listed).length;
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
    <p class="error small" role="alert" data-test="network-error" hidden="${() => !state.networkError}">${() => state.networkError}</p>
    <div class="crows">${() => shownCatalog().slice(0, CATALOG_SHOWN).map((s) => catRow(s, a).key(`${s.pubkey}:${s.stream_name}:${s.subscribed}`))}</div>
  </details>`;
}

export function streamsTab(a) {
  return html`
  <section class="tab-page" data-test="streams-tab" hidden="${() => state.tab !== 'streams'}">
    ${centralCard(a)}
    ${streamsCard(a)}
    ${nostrCard(a)}
    ${recordsCard(a)}
    ${network(a)}
  </section>`;
}
