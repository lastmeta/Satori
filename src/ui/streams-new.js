// The new Streams tab (src/ui/layout.js): what this app works on, and finding more. Your streams: every stream the
// app follows in one list, the Satori Network's and the relays', each with where it comes from, its latest value and
// our forecast; a relay stream's Predict switch and, predicted, its price (Sell at the default, or the price and
// buyers). Find streams: one search over the relays, Free / For sale / Predictors (track records), Subscribe or Buy
// in the row. The money is the Market's (src/ui/market-new.js).
import { html } from '@arrow-js/core';
import { formatEther } from 'viem';
import { state } from './state.js';
import { fact, form, unlockPrompt } from './parts.js';
import {
  fmtNum, fmtWhen, networkLine, mismatchText, registrationText, pollText, submitText, historyText,
  fmtCadence, shortKey, obsText, catalogMatch, predText, saleText,
} from './format.js';
import { listingOf } from '../neuron/market.js';
import { watchText, recordGroups, firstRows, SHOWN } from './record.js';
import { detail, recordGroup, groupKey, buyPart, listed, DEFAULT_PRICE, CATALOG_SHOWN } from './streams.js';
import { layoutSwitch } from './layout.js';

const recordOf = (s) => state.records.find((r) => r.pubkey === s.pubkey && r.stream === s.stream_name);
const saleOf = (sub) => state.nostr.market?.selling.find((x) => x.stream === `${sub.stream}_pred`);

/** A Satori Network stream: tap its name for its trend, model and predictions (the current layout's detail). */
function networkRow(r, names, a) {
  // One root node, no whitespace around it (src/ui/streams.js streamRow).
  const open = () => state.streamOpen === r.uuid;
  const sent = r.status === 'sent';
  return html`<div class="yitem" data-test="stream"><div class="yrow"><div class="ymain"><button class="sname" title="${r.uuid}" aria-expanded="${() => String(open())}" @click="${() => a.openStream(open() ? '' : r.uuid)}">${r.name}</button><span class="ytag">Satori Network</span><div class="yvals small"><span>Latest <b data-test="obs">${fmtNum(r.obs_value)}</b> <span class="muted">${fmtWhen(r.obs_ts)}</span></span><span>Forecast <b class="accent" data-test="t2">${fmtNum(r.t2)}</b> <span class="muted">in 24 h</span></span></div></div><div class="yacts"><span class="${r.status ? (sent ? 'badge on' : 'badge') : 'muted'}" data-test="status">${r.status ? (sent ? 'Sent' : 'Pending') : '–'}</span></div></div>${() => (open() ? detail(r, names, a) : '')}</div>`;
}

/** A stream followed on the relays: Predict on or off; predicted, Sell (the default price unless typed) or its price. */
function relayRow(s, a) {
  // One root node, no whitespace around it; keyed by what it shows.
  const p = s.prediction;
  const stream = `${s.stream}_pred`;
  const sale = saleOf(s);
  const busy = () => state.marketBusy === `sell:${stream}`;
  const sell = !s.predict ? ''
    : sale ? html`<span class="ysale" data-test="sell-state"><span class="badge on">Selling</span> ${saleText(sale)} <button class="link" data-test="unsell" disabled="${() => !!state.marketBusy}" @click="${() => a.unsell(stream)}">${() => (busy() ? '…' : 'Make free')}</button></span>`
      : html`<form class="sell" @submit="${(e) => a.sell(stream, form(e))}"><input name="price" inputmode="decimal" autocomplete="off" aria-label="${`Price per value of ${stream}, in SATORI (empty: ${DEFAULT_PRICE})`}" placeholder="${DEFAULT_PRICE}" data-test="sell-price"><button class="small-btn" type="submit" data-test="sell" disabled="${() => !!state.marketBusy}">${() => (busy() ? '…' : 'Sell')}</button></form>`;
  return html`<div class="yitem" data-test="sub"><div class="yrow"><div class="ymain"><span class="sname" title="${`${s.stream} from ${s.provider}`}">${s.name || s.stream}</span><span class="ytag">Relays</span><div class="yvals small"><span>Latest <b data-test="sub-obs">${obsText(s.observation)}</b> <span class="muted">${fmtWhen(s.observation?.ts)}</span></span><span>${s.predict ? html`Forecast <b class="accent" data-test="sub-pred">${predText(p?.value)}</b> <span class="muted">${p ? `to ${p.relays} relay${p.relays === 1 ? '' : 's'}` : 'soon'}</span>` : html`<span class="muted">Not predicted</span>`}</span></div></div><div class="yacts"><button class="small-btn" data-test="sub-predict" aria-pressed="${String(!!s.predict)}" title="${s.predict ? 'Stop predicting it (still followed)' : 'Predict it: each new value is forecast and the forecast published to the relays'}" @click="${() => a.setPredict(s.provider, s.stream, !s.predict)}" disabled="${() => !!state.subscribing}">${s.predict ? 'Predicting' : 'Predict'}</button><button class="link muted" data-test="unsubscribe" @click="${() => a.subscribe(s.provider, s.stream, false)}" disabled="${() => !!state.subscribing}">Unsubscribe</button></div></div>${sell ? html`<div class="ybar">${sell}</div>` : ''}</div>`;
}

function yours(a) {
  const c = () => state.central;
  const failing = () => (c().registration && !c().registration.ok) || !!c().lastSubmit?.error || c().lastSubmit?.successful === 0;
  const subs = () => state.nostr.subscriptions;
  const count = () => state.streams.length + subs().length;
  return html`
  <section class="card" data-test="your-streams">
    <header class="card-head"><h2>Your streams</h2><span class="muted small" data-test="streams-count">${() => (count() ? `${count()} followed · ${subs().filter((s) => s.predict).length + state.streams.length} predicted` : '')}</span></header>
    <div class="ysrc">
      <p class="small"><b>Satori Network</b> <span data-test="network-line" class="${() => (failing() ? 'error' : 'muted')}">${() => networkLine(c())}</span></p>
      <button class="small-btn" data-test="poll-now" @click="${a.pollNow}" disabled="${() => state.central.polling}">${() => (state.central.polling ? 'Polling…' : 'Poll now')}</button>
    </div>
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
    <p class="muted small" hidden="${() => count() > 0}">None yet. The Satori Network's arrive with the first poll; find more below.</p>
    <div class="yrows">
      ${() => {
        const names = new Map(state.streams.map((r) => [r.uuid, r.name]));
        return state.streams.map((r) => networkRow(r, names, a).key(r.uuid));
      }}
      ${() => subs().map((s) => relayRow(s, a).key(`${s.uuid} ${s.observation?.seq} ${s.prediction?.seq} ${s.predict} ${saleText(saleOf(s))}`))}
    </div>
    <p class="error small" role="alert" data-test="market-error" hidden="${() => !state.marketError}">${() => state.marketError}</p>
  </section>`;
}

const FILTERS = [['all', 'All'], ['free', 'Free'], ['sale', 'For sale'], ['predictors', 'Predictors']];

/** A stream on the relays: what it is, its price or Free, its track record when watched; Subscribe, or Buy in place. */
function findRow(s, a) {
  const key = `${s.pubkey}:${s.stream_name}`;
  const l = listingOf(s);
  const r = recordOf(s);
  const gated = !l && (s.price_per_obs > 0 || s.encrypted || s.approval_required);
  const price = l ? html`<span class="badge on" data-test="catalog-price">${`${formatEther(l.price)} SATORI each`}</span>` : html`<span class="badge">${gated ? 'Gated (later)' : 'Free'}</span>`;
  const act = l ? buyPart(s, l, a)
    : html`<button class="${s.subscribed ? 'small-btn' : 'small-btn primary'}" data-test="catalog-action" disabled="${() => gated || !!state.subscribing}" @click="${() => a.subscribe(s.pubkey, s.stream_name, !s.subscribed)}">${() => (state.subscribing === key ? '…' : s.subscribed ? 'Unsubscribe' : 'Subscribe')}</button>`;
  return html`<div class="crow" data-test="catalog-row"><div class="cmain"><span class="sname">${s.name || s.stream_name}</span> ${price}<div class="muted small">${s.stream_name} · every ${fmtCadence(s.cadence_seconds)} · <span class="nowrap" title="${s.pubkey}">${shortKey(s.pubkey)}</span>${r?.markText ? ` · track record ${r.markText}` : ''}</div><div class="muted small desc">${s.description}</div></div>${act}</div>`;
}

function find(a) {
  const f = () => state.findFilter;
  const pool = () => state.catalog.filter((s) => listed(s) && (f() === 'all' || (f() === 'sale') === !!listingOf(s)));
  const shown = () => pool().filter((s) => catalogMatch(s, state.catalogQuery));
  const n = (k) => state.catalog.filter((s) => listed(s) && (k === 'all' || (k === 'sale') === !!listingOf(s))).length;
  const summary = () => {
    if (!state.catalog.length) return state.discovering ? 'Asking the relays…' : 'Search to see what the relays offer.';
    const hits = shown().length;
    return `${hits} match${hits === 1 ? '' : 'es'}${hits > CATALOG_SHOWN ? `, the first ${CATALOG_SHOWN} shown` : ''}`;
  };
  const groups = () => recordGroups(state.records);
  const rshown = () => (state.recordsAll ? groups() : firstRows(groups(), SHOWN));
  return html`
  <section class="card" data-test="find-streams">
    <h2>Find streams</h2>
    <form class="search" @submit="${(e) => { e.preventDefault(); a.discover(); }}">
      <input name="q" type="search" aria-label="Search streams" placeholder="Search: bitcoin, weather, …" autocomplete="off" value="${() => state.catalogQuery}"
        @input="${(e) => (state.catalogQuery = e.target.value)}">
      <button type="submit" disabled="${() => state.discovering}">${() => (state.discovering ? 'Looking…' : 'Refresh')}</button>
    </form>
    <div class="segmented ffilters" role="group" aria-label="Show">${FILTERS.map(([k, word]) => html`<button class="small-btn" data-test="${`find-${k}`}" aria-pressed="${() => String(f() === k)}" @click="${() => { state.findFilter = k; }}">${word} <span class="n">${() => (k === 'predictors' ? state.records.length : n(k))}</span></button>`)}</div>
    <p class="error small" role="alert" data-test="network-error" hidden="${() => !state.networkError}">${() => state.networkError}</p>
    <div hidden="${() => f() === 'predictors'}">
      <p class="muted small" data-test="catalog-summary">${() => state.networkLine || summary()}</p>
      ${unlockPrompt(a, 'buy', 'buy')}
      <div class="crows">${() => shown().slice(0, CATALOG_SHOWN).map((s) => findRow(s, a).key(`${s.pubkey}:${s.stream_name}:${s.subscribed}:${recordOf(s)?.markText ?? ''}`))}</div>
    </div>
    <div data-test="records" hidden="${() => f() !== 'predictors'}">
      <p class="muted small">Who predicts which stream, and how well: each prediction stream against no change.</p>
      <p class="muted small rstatus" data-test="records-status"><i class="spin" aria-hidden="true" hidden="${() => !state.watchLine}"></i><span>${() => state.watchLine || watchText(state.nostr.watching, state.records)}</span></p>
      <div class="rrows" hidden="${() => !state.records.length}">
        <div class="rrow head" aria-hidden="true"><span>Source, then its predictors</span><span>Against no change</span><span class="rfrom">Scored</span><span>Cadence</span></div>
        <div>${() => rshown().map((g) => recordGroup(g, a).key(groupKey(g)))}</div>
      </div>
      <button class="small-btn" data-test="records-all" hidden="${() => state.recordsAll || state.records.length <= SHOWN}" @click="${() => { state.recordsAll = true; }}">${() => `Show all ${state.records.length}`}</button>
    </div>
  </section>`;
}

export function streamsTabNew(a) {
  return html`
  <section class="tab-page" data-test="streams-tab" hidden="${() => state.tab !== 'streams'}">
    ${layoutSwitch()}
    ${yours(a)}
    ${find(a)}
  </section>`;
}
