// The Market tab (docs/design/market.md#the-market-tab): data streams sold per value in SATORI through payment channels
// on Base. What it is and the totals (earned, collected, selling, buying); Selling: the streams this app predicts, a
// price on each (Sell), their buyers, Make free; Buying: the deposit left, Stop, Take back once stopped, and Find
// streams for sale, which opens every priced stream the relays announce (price, provider, cadence, track record,
// a deposit and Buy). A channel's settings (grace period, where a buyer's payments go) fold under Channel details.
import { html } from '@arrow-js/core';
import { formatEther } from 'viem';
import { state } from './state.js';
import { form, unlockPrompt } from './parts.js';
import { listingOf, DEPOSIT_OBS } from '../neuron/market.js';
import { watchable } from '../neuron/records.js';
import { shortKey, saleText, boughtText, buyerText, graceText } from './format.js';

/** A stream's price per value when none is typed (owner, 2026-10-25), in SATORI. */
export const DEFAULT_PRICE = '0.00001';

const m = () => state.nostr.market ?? { selling: [], bought: [], error: null };
const forSale = () => state.catalog.filter((s) => listingOf(s) && watchable(s)); // what this app can buy (nostr buy)
const predicted = () => state.nostr.subscriptions.filter((s) => s.predict);
const sum = (xs) => xs.reduce((n, x) => n + Number(x || 0), 0);
const fmt = (n) => (Math.round(n * 1e8) / 1e8).toString();
const earned = () => sum(m().selling.flatMap((s) => s.buyers.map((b) => b.paid)));
const settled = () => sum(m().selling.flatMap((s) => s.buyers.map((b) => b.settled)));
const busy = (k) => state.marketBusy === k;
const cadence = (s) => (!s ? '' : s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);
/** A stream's track record, when the app watches it (src/neuron/records.js): how its predictions did against no change. */
const recordOf = (s) => state.records.find((r) => r.pubkey === s.pubkey && r.stream === s.stream_name);

/** A stream sold on the Satori contract: its price, a deposit (100 observations) and Buy; bought, the deposit left. */
function buyPart(s, l, a) {
  const key = `${s.pubkey}:${s.stream_name}`;
  const mine = () => state.nostr.market?.bought.find((b) => b.pubkey === s.pubkey && b.stream === s.stream_name && b.status === 'open');
  const stopped = () => state.nostr.market?.bought.some((b) => b.pubkey === s.pubkey && b.stream === s.stream_name);
  return html`${() => (mine()
    ? html`<span class="muted small" data-test="catalog-bought">${`Bought · ${mine().left} SATORI left`}</span>`
    : html`<form class="buy" @submit="${(e) => a.buy(s.pubkey, s.stream_name, form(e))}"><input name="deposit" inputmode="decimal" autocomplete="off" required value="${formatEther(l.price * BigInt(DEPOSIT_OBS))}" aria-label="${`Deposit for ${s.stream_name}, in SATORI`}" data-test="buy-deposit"><button class="small-btn primary" type="submit" data-test="buy" disabled="${() => !!state.marketBusy}">${() => (state.marketBusy === `buy:${key}` ? '…' : stopped() ? 'Buy again' : 'Buy')}</button></form>`)}`;
}

// plain values in each row, redrawn by key (src/ui/home.js cell)
const saleRow = (s, a) => {
  const l = listingOf(s);
  const r = recordOf(s);
  return html`<div class="crow" data-test="market-item" data-key="${`${s.pubkey}:${s.stream_name}`}"><div class="cmain"><span class="sname">${s.name || s.stream_name}</span> <b class="small" data-test="market-price">${`${formatEther(l.price)} SATORI each`}</b><div class="muted small">${s.stream_name}${s.cadence_seconds ? ` · every ${cadence(s.cadence_seconds)}` : ''} · <span class="nowrap" title="${s.pubkey}">${shortKey(s.pubkey)}</span></div><div class="small" data-test="market-record">${r?.markText ? `Track record: ${r.markText}` : 'No track record yet'}</div><div class="muted small desc">${s.description}</div></div>${buyPart(s, l, a)}</div>`;
};

/** A channel's settings in place: its grace period (either wallet), and for a buyer of ours where its payments go. */
function channelDetails(channel, grace, a, { payout = false } = {}) {
  return html`<details class="mchange" data-test="channel-details"><summary>Channel details</summary>${payout ? html`<form @submit="${(e) => a.setPayout(channel, form(e))}"><label class="muted small">Paid into</label><input name="payout" autocomplete="off" required placeholder="0x…" aria-label="Address its payments go to" data-test="payout-address"><button class="small-btn" type="submit" data-test="payout-set" disabled="${() => !!state.marketBusy}">${() => (busy(`payout:${channel}`) ? '…' : 'Set')}</button></form>` : ''}<form @submit="${(e) => a.setGrace(channel, form(e))}"><label class="muted small">${`Grace period ${graceText(grace)}`}</label><input name="days" inputmode="decimal" autocomplete="off" required value="${String(Math.round((grace / 86_400) * 100) / 100)}" aria-label="Grace period, in days" data-test="grace-days"><button class="small-btn" type="submit" data-test="grace-set" disabled="${() => !!state.marketBusy}">${() => (busy(`grace:${channel}`) ? '…' : 'Set days')}</button></form><p class="muted small">How long a stopped buyer waits before taking back what is left. Longer by the buyer, or shorter by the seller, applies at once; otherwise the other side is asked.</p></details>`;
}

/** One of our `_pred`s: Free with a price to set (Sell; the default price when none is typed), or its price, buyers and Make free. */
function sellingRow(sub, a) {
  // One root node, no whitespace around it (src/ui/streams.js streamRow).
  const stream = `${sub.stream}_pred`;
  const sale = state.nostr.market?.selling.find((x) => x.stream === stream);
  const buyers = (sale?.buyers ?? []).filter((x) => !x.closing);
  const act = sale
    ? html`<button class="small-btn" data-test="unsell" disabled="${() => !!state.marketBusy}" @click="${() => a.unsell(stream)}">${() => (busy(`sell:${stream}`) ? '…' : 'Make free')}</button>`
    : html`<form class="sell" @submit="${(e) => a.sell(stream, form(e))}"><input name="price" inputmode="decimal" autocomplete="off" aria-label="${`Price per value of ${stream}, in SATORI (empty: ${DEFAULT_PRICE})`}" placeholder="${DEFAULT_PRICE}" data-test="sell-price"><button class="small-btn primary" type="submit" data-test="sell" disabled="${() => !!state.marketBusy}">${() => (busy(`sell:${stream}`) ? '…' : 'Sell')}</button></form>`;
  return html`<div class="crow" data-test="sell-row" data-stream="${stream}"><div class="cmain"><span class="sname" title="${stream}">${`Predictions for ${sub.name || sub.stream}`}</span> <span class="${sale ? 'badge on' : 'badge'}" data-test="sell-state">${saleText(sale)}</span>${sale ? (buyers.length ? buyers.map((x) => html`<div class="small buyer" data-test="buyer" data-channel="${x.channel}"><span class="nowrap" title="${x.pubkey}">${shortKey(x.pubkey)}</span> · <span data-test="buyer-text">${buyerText(x)}</span>${channelDetails(x.channel, x.grace, a, { payout: true })}</div>`) : html`<div class="muted small">No buyers yet</div>`) : ''}</div>${act}</div>`;
}

function buyingRow(b, a) {
  // One root node, no whitespace around it.
  const key = `${b.pubkey}:${b.stream}`;
  const take = b.status === 'stopped' && Number(b.refundable) > 0
    ? html`<form class="takeback" @submit="${(e) => a.takeBack(b.channel, form(e))}"><input name="amount" inputmode="decimal" autocomplete="off" required value="${b.refundable}" aria-label="${`SATORI to take back from ${b.stream}`}" data-test="takeback-amount"><input name="to" autocomplete="off" placeholder="To: the wallet" aria-label="Address to send it to (the wallet if empty)" data-test="takeback-to"><button class="small-btn" type="submit" data-test="takeback" disabled="${() => !!state.marketBusy}">${() => (busy(`take:${b.channel}`) ? '…' : 'Take back')}</button></form>` : '';
  return html`<div class="crow" data-test="bought-row" data-key="${key}"><div class="cmain"><span class="sname">${b.name || b.stream}</span> <span class="muted small"><span class="nowrap" title="${b.pubkey}">${shortKey(b.pubkey)}</span> · ${b.price} SATORI each</span><div class="small" data-test="bought-left">${boughtText(b)}</div>${take}${channelDetails(b.channel, b.grace, a)}</div>${b.status === 'open' ? html`<button class="small-btn" data-test="stop" disabled="${() => !!state.marketBusy}" @click="${() => a.stop(b.pubkey, b.stream)}">${() => (busy(`stop:${key}`) ? '…' : 'Stop')}</button>` : ''}</div>`;
}

/** What a selling row shows, as its key: its price and its buyers. */
const saleKey = (sub) => {
  const s = state.nostr.market?.selling.find((x) => x.stream === `${sub.stream}_pred`);
  return s ? `${s.price}|${s.buyers.map((x) => `${x.channel},${x.paid},${x.payout},${x.grace},${x.closing}`).join(';')}` : 'free';
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

    <section class="card" data-test="market-sales">
      <h2>Selling</h2>
      <p class="muted small" hidden="${() => predicted().length > 0}">Predict a stream on the Streams tab, then sell its predictions here.</p>
      <div class="crows">${() => predicted().map((sub) => sellingRow(sub, a).key(`${sub.uuid}:${saleKey(sub)}`))}</div>
    </section>

    <section class="card" data-test="market-bought">
      <h2>Buying</h2>
      <p class="muted small" hidden="${() => m().bought.length > 0}">Nothing bought yet.</p>
      <div class="crows">${() => m().bought.map((b) => buyingRow(b, a).key(`${b.channel}:${b.status}:${b.left}:${b.refundable}:${b.closeAt}:${b.grace}`))}</div>
      <div class="mfind"><button class="${() => (state.forSaleOpen ? 'small-btn' : 'small-btn primary')}" data-test="market-find" aria-expanded="${() => String(state.forSaleOpen)}" @click="${() => { state.forSaleOpen = !state.forSaleOpen; if (state.forSaleOpen && !state.catalog.length && !state.discovering) a.discover(); }}">${() => (state.forSaleOpen ? 'Hide streams for sale' : 'Find streams for sale')}</button></div>
      <div data-test="market-for-sale" hidden="${() => !state.forSaleOpen}">
        <div class="card-head"><p class="muted small">${() => (state.discovering ? 'Asking the relays…' : forSale().length ? `${forSale().length} for sale on the relays` : state.catalog.length ? 'Nothing is for sale on the relays right now.' : 'Refresh to see what the relays offer.')}</p><button class="small-btn" data-test="market-refresh" disabled="${() => state.discovering}" @click="${a.discover}">${() => (state.discovering ? 'Looking…' : 'Refresh')}</button></div>
        ${unlockPrompt(a, 'buy', 'buy')}
        <div class="crows">${() => forSale().map((s) => saleRow(s, a).key(`${s.pubkey}:${s.stream_name}:${recordOf(s)?.markText ?? ''}`))}</div>
      </div>
    </section>
    ${unlockPrompt(a, 'market', 'change the channel')}
  </section>`;
}
