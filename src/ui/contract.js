// Home's chip cards (docs/design/health.md#the-chip-cards): a chip opens its card under the chips (another chip switches
// it, the same one closes it). Each says what its channel is for, as a picture (this app, an arrow green while it
// works, where the data goes) and in words, and what has to be in place, each a check with its fix. The Satori
// contract's also has the mode (Automatic, By hand) and its fixes: Stake, Base ETH to an address (Copy, a QR code),
// Play. Their checks: src/ui/contractflow.js.
import { html } from '@arrow-js/core';
import qrcode from 'qrcode-generator';
import { state } from './state.js';
import { unlockPrompt } from './parts.js';
import { contractChecks, predictedToday, networkChecks, networkSent, relayChecks, relaysOn } from './contractflow.js';

const b = () => state.base;
const today = () => predictedToday(b());

const PHONE = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"></rect><path d="M11 18.5h2"></path></svg>`;
// the contract: a block on the chain
// the Satori Network: a server; the relays: a tower sending out
const SERVER = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3.5" width="16" height="7" rx="1.5"></rect><rect x="4" y="13.5" width="16" height="7" rx="1.5"></rect><path d="M8 7h.01M8 17h.01"></path></svg>`;
const TOWER = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 10.5v10M8.5 20.5h7"></path><circle cx="12" cy="9" r="1.5"></circle><path d="M8.5 5.5a5 5 0 0 0 0 7M15.5 5.5a5 5 0 0 1 0 7M6 3a8.5 8.5 0 0 0 0 12M18 3a8.5 8.5 0 0 1 0 12"></path></svg>`;
const BLOCK = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z"></path><path d="M3.5 7.25L12 12l8.5-4.75M12 12v9.5"></path></svg>`;
const MARK = { ok: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M7.5 12.5l3 3 6-6.5"></path></svg>`,
  bad: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"></path></svg>`,
  wait: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 7v5l3 2"></path></svg>` };

/** A QR code of `text` as an SVG data URL (a wallet app's camera reads the address). */
export function qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return `data:image/svg+xml;utf8,${encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }))}`;
}

/** An address to send Base ETH to: in full, Copy, and a QR code on a tap. */
const fundRow = (a, c) => html`<div class="fund" data-test="contract-fund">
  <p class="small">Send a little Base ETH (on Base, not Ethereum) to ${c.who === 'alias' ? "this app's address" : 'your wallet'}:</p>
  <code class="block" data-test="contract-fund-address">${c.address}</code>
  <div class="actions">
    <button class="small-btn" @click="${() => a.copy('contract-fund', c.address)}">${() => (state.copied === 'contract-fund' ? 'Copied' : 'Copy')}</button>
    <button class="small-btn" data-test="contract-qr-toggle" @click="${() => a.toggleContractQr(c.address)}">${() => (state.contractQr === c.address ? 'Hide QR code' : 'QR code')}</button>
  </div>
  <img class="qr" data-test="contract-qr" alt="${`QR code of ${c.address}`}" src="${() => (state.contractQr === c.address ? qrDataUrl(c.address) : '')}" hidden="${() => state.contractQr !== c.address}">
</div>`;

const fixOf = (a, c) => (c.fix === 'poll' ? html`<button class="small-btn" data-test="network-poll" disabled="${() => !!state.central.polling}" @click="${a.pollNow}">${() => (state.central.polling ? 'Polling…' : 'Poll now')}</button>`
  : c.fix === 'relink' ? html`<button class="small-btn" data-test="network-relink" @click="${a.baseRelink}">Link this wallet</button>`
    : c.fix === 'streams' ? html`<button class="small-btn" data-test="relays-streams" @click="${() => a.go('streams')}">Streams</button>`
      : c.fix === 'stake' ? html`<button class="primary small-btn" data-test="contract-stake" disabled="${() => !!state.baseBusy}" @click="${() => a.walletAction('contract', 'baseDelegate')}">${() => (state.baseBusy === 'stake' ? 'Staking…' : 'Stake with this app')}</button>`
  : c.fix === 'game' ? html`<button class="small-btn" data-test="contract-play" @click="${() => a.go('game')}">Play today's game</button>`
    : c.fix === 'fund' ? fundRow(a, c) : '');

// plain values in each row, redrawn by key (src/ui/home.js cell: ArrowJS and live values in a redrawn list)
const check = (a, c) => html`<li class="check" data-test="chip-check" data-id="${c.id}" data-state="${c.state}"><span class="cmark">${MARK[c.state]()}</span><div><p>${c.text}</p>${fixOf(a, c)}</div></li>`;

/** The picture: this app, an arrow (green while it works), where the data goes. */
const flow = (key, on, from, word, to, place) => html`<div class="cflow">
  <span class="cnode">${PHONE()}<small>${from}</small></span>
  <span class="carrow" data-test="${`${key}-arrow`}" data-on="${() => String(on())}"><i></i><small>${word}</small></span>
  <span class="cnode">${to()}<small>${place}</small></span>
</div>`;
const checkList = (a, list) => html`<ul class="checks" data-test="chip-checks">${() => list().map((c) => check(a, c).key(`${c.id}:${c.state}:${c.text}:${c.address ?? ''}`))}</ul>`;
const nowS = () => Date.now() / 1000;

const network = (a) => html`<div class="card contract-card" data-test="network-card">
  ${flow('network', () => networkSent(state.central, nowS()), 'This app', () => (networkSent(state.central, nowS()) ? 'Sent today' : 'Nothing sent lately'), SERVER, 'Satori Network')}
  <p class="muted small">The Satori Network is Satori's server. The app reads each data stream's latest values from it, predicts the next ones with its own models, and sends the predictions back. It's free, and it rewards good predictions.</p>
  ${checkList(a, () => networkChecks(state.central, nowS()))}
</div>`;

const relays = (a) => html`<div class="card contract-card" data-test="relays-card">
  ${flow('relays', () => relaysOn(state.nostr), 'This app', () => (relaysOn(state.nostr) ? 'Connected' : 'Not connected'), TOWER, 'Satori relays')}
  <p class="muted small">The Satori relays carry prediction streams from anyone. This app watches them and scores each one against no change, and it publishes its own predictions for the streams you subscribe to. It's free.</p>
  ${checkList(a, () => relayChecks(state.nostr))}
</div>`;

/** The chips' card, under them: the one whose chip was tapped. */
export function chipCard(a) {
  const open = (key) => () => state.chipOpen !== key;
  return html`
  <section class="contract-panel" data-test="chip-card" data-open="${() => String(!!state.chipOpen)}" data-channel="${() => state.chipOpen || false}" inert="${() => !state.chipOpen}"><div class="contract-inner">
    <div class="chip-card" hidden="${open('network')}">${network(a)}</div>
    <div class="chip-card" hidden="${open('contract')}">${contractCard(a)}</div>
    <div class="chip-card" hidden="${open('relays')}">${relays(a)}</div>
  </div></section>`;
}

function contractCard(a) {
  return html`
  <div class="card contract-card" data-test="contract-card">
    ${flow('contract', today, () => (b().play === 'manual' ? 'You, by hand' : 'This app'), () => (today() ? 'Predicted today' : 'Not yet today'), BLOCK, 'Satori contract')}
    <p class="muted small">Each day, predictions are sent directly to the Satori smart contract on Base. They are automatically scored on-chain and earn SATORI.</p>
    <div class="segmented" role="group" aria-label="Who predicts">${[['auto', 'Automatic'], ['manual', 'By hand']].map(([mode, word]) => html`<button class="small-btn" data-test="${`contract-play-${mode}`}" aria-pressed="${() => String(b().play === mode)}" disabled="${() => !b().play}" @click="${() => a.setPlay(mode)}">${word}</button>`)}</div>
    ${checkList(a, () => contractChecks(b()))}
    ${unlockPrompt(a, 'contract', 'stake from the contract card')}
    <p class="error small" role="alert" hidden="${() => !(state.baseDid === 'stake' && state.baseError)}">${() => state.baseError}</p>
  </div>`;
}
