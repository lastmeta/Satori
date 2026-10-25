// The Market tab (docs/design/market.md#the-market-tab): data streams sold per value in SATORI through payment channels
// on Base. What it is and the totals (earned, settled, buying, selling); For sale: every priced stream the relays
// announce, its price, provider, cadence and track record, with a deposit and Buy; Your sales: the streams this app
// predicts, a price on each, their buyers; Bought: the deposit left, Stop. Its pieces: src/ui/streams.js.
import { html } from '@arrow-js/core';
import { formatEther } from 'viem';
import { state } from './state.js';
import { unlockPrompt } from './parts.js';
import { listingOf } from '../neuron/market.js';
import { sellRow, boughtRow, buyPart } from './streams.js';

const m = () => state.nostr.market ?? { selling: [], bought: [], error: null };
const forSale = () => state.catalog.filter((s) => listingOf(s));
const predicted = () => state.nostr.subscriptions.filter((s) => s.predict);
const sum = (xs) => xs.reduce((n, x) => n + Number(x || 0), 0);
const fmt = (n) => (Math.round(n * 1e8) / 1e8).toString();
const earned = () => sum(m().selling.flatMap((s) => s.buyers.map((b) => b.paid)));
const settled = () => sum(m().selling.flatMap((s) => s.buyers.map((b) => b.settled)));
const shortKey = (k) => `${k.slice(0, 8)}…`;
const cadence = (s) => (!s ? '' : s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);
/** A stream's track record, when the app watches it (src/neuron/records.js): how its predictions did against no change. */
const recordOf = (s) => state.records.find((r) => r.pubkey === s.pubkey && r.stream === s.stream_name);

// plain values in each row, redrawn by key (src/ui/home.js cell)
const saleRow = (s, a) => {
  const l = listingOf(s);
  const r = recordOf(s);
  return html`<div class="crow" data-test="market-item" data-key="${`${s.pubkey}:${s.stream_name}`}"><div class="cmain"><span class="sname">${s.name || s.stream_name}</span> <b class="small" data-test="market-price">${`${formatEther(l.price)} SATORI each`}</b><div class="muted small">${s.stream_name}${s.cadence_seconds ? ` · every ${cadence(s.cadence_seconds)}` : ''} · <span class="nowrap" title="${s.pubkey}">${shortKey(s.pubkey)}</span></div><div class="small" data-test="market-record">${r?.markText ? `Track record: ${r.markText}` : 'No track record yet'}</div><div class="muted small desc">${s.description}</div></div>${buyPart(s, l, a)}</div>`;
};

export function marketTab(a) {
  return html`
  <section class="tab-page" data-test="market-tab" hidden="${() => state.tab !== 'market'}">
    <section class="card">
      <h2>Market</h2>
      <p class="muted small">The Satori marketplace allows agents to make instantaneous microtransactions in order to buy and sell data streams.</p>
      <div class="mtotals" data-test="market-totals">
        <span><b data-test="market-earned">${() => fmt(earned())}</b> SATORI earned</span>
        <span><b>${() => fmt(settled())}</b> collected</span>
        <span><b data-test="market-selling">${() => m().selling.length}</b> selling</span>
        <span><b data-test="market-buying">${() => m().bought.filter((b) => b.status === 'open').length}</b> buying</span>
      </div>
      <p class="error small" role="alert" data-test="market-error" hidden="${() => !(state.marketError || m().error)}">${() => state.marketError || m().error}</p>
    </section>

    <section class="card" data-test="market-for-sale">
      <div class="card-head"><h2>For sale</h2><button class="small-btn" data-test="market-refresh" disabled="${() => state.discovering}" @click="${a.discover}">${() => (state.discovering ? 'Looking…' : 'Refresh')}</button></div>
      <p class="muted small" hidden="${() => forSale().length > 0}">${() => (state.discovering ? 'Asking the relays…' : state.catalog.length ? 'Nothing is for sale on the relays right now.' : 'Refresh to see what the relays offer.')}</p>
      ${unlockPrompt(a, 'buy', 'buy')}
      <div class="crows">${() => forSale().map((s) => saleRow(s, a).key(`${s.pubkey}:${s.stream_name}:${recordOf(s)?.markText ?? ''}`))}</div>
    </section>

    <section class="card" data-test="market-sales">
      <h2>Your sales</h2>
      <p class="muted small" hidden="${() => predicted().length > 0}">Predict a stream on the Streams tab, then set a price on its predictions here.</p>
      <div class="crows">${() => predicted().map((sub) => sellRow(sub, a).key(sub.uuid))}</div>
    </section>

    <section class="card" data-test="market-bought">
      <h2>Bought</h2>
      <p class="muted small" hidden="${() => m().bought.length > 0}">Nothing bought yet.</p>
      <div class="crows">${() => m().bought.map((b) => boughtRow(b, a).key(`${b.channel}:${b.status}:${b.left}:${b.refundable}:${b.closeAt}:${b.grace}`))}</div>
    </section>
    ${unlockPrompt(a, 'market', 'change the channel')}
  </section>`;
}
