// The new Market tab (src/ui/layout.js): the money. What it is and the totals; Selling: each stream we sell, its price,
// its buyers, Make free; Buying: each stream we buy, the deposit left, Stop, Take back once stopped. A channel's
// settings (grace period, where a buyer's payments go) are folded under Channel details. Finding and pricing a stream
// is the Streams tab's (src/ui/streams-new.js): For sale opens its search there.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { form, unlockPrompt } from './parts.js';
import { shortKey, saleText, boughtText, buyerText, graceText } from './format.js';
import { layoutSwitch } from './layout.js';

const m = () => state.nostr.market ?? { selling: [], bought: [], error: null };
const sum = (xs) => xs.reduce((n, x) => n + Number(x || 0), 0);
const fmt = (n) => (Math.round(n * 1e8) / 1e8).toString();
const earned = () => sum(m().selling.flatMap((s) => s.buyers.map((b) => b.paid)));
const settled = () => sum(m().selling.flatMap((s) => s.buyers.map((b) => b.settled)));
const busy = (k) => state.marketBusy === k;

/** A channel's settings in place: its grace period (either wallet), and for a buyer of ours where its payments go. */
function channelDetails(channel, grace, a, { payout = false } = {}) {
  return html`<details class="mchange" data-test="channel-details"><summary>Channel details</summary>${payout ? html`<form @submit="${(e) => a.setPayout(channel, form(e))}"><label class="muted small">Paid into</label><input name="payout" autocomplete="off" required placeholder="0x…" aria-label="Address its payments go to" data-test="payout-address"><button class="small-btn" type="submit" data-test="payout-set" disabled="${() => !!state.marketBusy}">${() => (busy(`payout:${channel}`) ? '…' : 'Set')}</button></form>` : ''}<form @submit="${(e) => a.setGrace(channel, form(e))}"><label class="muted small">${`Grace period ${graceText(grace)}`}</label><input name="days" inputmode="decimal" autocomplete="off" required value="${String(Math.round((grace / 86_400) * 100) / 100)}" aria-label="Grace period, in days" data-test="grace-days"><button class="small-btn" type="submit" data-test="grace-set" disabled="${() => !!state.marketBusy}">${() => (busy(`grace:${channel}`) ? '…' : 'Set days')}</button></form><p class="muted small">How long a stopped buyer waits before taking back what is left. Longer by the buyer, or shorter by the seller, applies at once; otherwise the other side is asked.</p></details>`;
}

/** One of our `_pred`s by the name people know: the stream it predicts. */
const nameOf = (stream) => {
  const sub = state.nostr.subscriptions.find((x) => `${x.stream}_pred` === stream);
  return sub ? `Predictions for ${sub.name || sub.stream}` : stream;
};

function sellingRow(s, a) {
  // One root node, no whitespace around it (src/ui/streams.js streamRow).
  const buyers = s.buyers.filter((x) => !x.closing);
  return html`<div class="crow" data-test="sell-row" data-stream="${s.stream}"><div class="cmain"><span class="sname" title="${s.stream}">${nameOf(s.stream)}</span> <span class="badge on" data-test="sell-state">${saleText(s)}</span>${buyers.length ? buyers.map((x) => html`<div class="small buyer" data-test="buyer" data-channel="${x.channel}"><span class="nowrap" title="${x.pubkey}">${shortKey(x.pubkey)}</span> · <span data-test="buyer-text">${buyerText(x)}</span>${channelDetails(x.channel, x.grace, a, { payout: true })}</div>`) : html`<div class="muted small">No buyers yet</div>`}</div><button class="small-btn" data-test="unsell" disabled="${() => !!state.marketBusy}" @click="${() => a.unsell(s.stream)}">${() => (busy(`sell:${s.stream}`) ? '…' : 'Make free')}</button></div>`;
}

function buyingRow(b, a) {
  // One root node, no whitespace around it.
  const key = `${b.pubkey}:${b.stream}`;
  const take = b.status === 'stopped' && Number(b.refundable) > 0
    ? html`<form class="takeback" @submit="${(e) => a.takeBack(b.channel, form(e))}"><input name="amount" inputmode="decimal" autocomplete="off" required value="${b.refundable}" aria-label="${`SATORI to take back from ${b.stream}`}" data-test="takeback-amount"><input name="to" autocomplete="off" placeholder="To: the wallet" aria-label="Address to send it to (the wallet if empty)" data-test="takeback-to"><button class="small-btn" type="submit" data-test="takeback" disabled="${() => !!state.marketBusy}">${() => (busy(`take:${b.channel}`) ? '…' : 'Take back')}</button></form>` : '';
  return html`<div class="crow" data-test="bought-row" data-key="${key}"><div class="cmain"><span class="sname">${b.name || b.stream}</span> <span class="muted small"><span class="nowrap" title="${b.pubkey}">${shortKey(b.pubkey)}</span> · ${b.price} SATORI each</span><div class="small" data-test="bought-left">${boughtText(b)}</div>${take}${channelDetails(b.channel, b.grace, a)}</div>${b.status === 'open' ? html`<button class="small-btn" data-test="stop" disabled="${() => !!state.marketBusy}" @click="${() => a.stop(b.pubkey, b.stream)}">${() => (busy(`stop:${key}`) ? '…' : 'Stop')}</button>` : ''}</div>`;
}

export function marketTabNew(a) {
  const findSale = () => { state.findFilter = 'sale'; a.go('streams'); };
  return html`
  <section class="tab-page" data-test="market-tab" hidden="${() => state.tab !== 'market'}">
    ${layoutSwitch()}
    <section class="card">
      <div class="card-head"><h2>Market</h2><button class="small-btn primary" data-test="market-find" @click="${findSale}">Find streams for sale</button></div>
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
      <div class="mempty" hidden="${() => m().selling.length > 0}"><p class="muted small">Nothing for sale yet. Predict a stream on the Streams tab, then Sell it from its row.</p><button class="small-btn" @click="${() => a.go('streams')}">Your streams</button></div>
      <div class="crows">${() => m().selling.map((s) => sellingRow(s, a).key(`${s.stream}:${s.price}:${s.buyers.map((x) => `${x.channel},${x.paid},${x.payout},${x.grace},${x.closing}`).join(';')}`))}</div>
    </section>

    <section class="card" data-test="market-bought">
      <h2>Buying</h2>
      <div class="mempty" hidden="${() => m().bought.length > 0}"><p class="muted small">Nothing bought yet.</p><button class="small-btn" @click="${findSale}">Find streams for sale</button></div>
      <div class="crows">${() => m().bought.map((b) => buyingRow(b, a).key(`${b.channel}:${b.status}:${b.left}:${b.refundable}:${b.closeAt}:${b.grace}`))}</div>
    </section>
    ${unlockPrompt(a, 'market', 'change the channel')}
  </section>`;
}
