// Home's Satori contract card (docs/design/health.md#the-contract-card): the Contract chip opens it under the chips.
// What the contract is for (a phone, an arrow, the contract: green once a prediction went to it this round), the mode
// (Automatic, By hand: Settings' switch), and what has to be in place, each a check with its fix: Stake, Base ETH to
// an address (Copy, a QR code), Play. Its checks: src/ui/contractflow.js.
import { html } from '@arrow-js/core';
import qrcode from 'qrcode-generator';
import { state } from './state.js';
import { unlockPrompt } from './parts.js';
import { contractChecks, predictedToday } from './contractflow.js';

const b = () => state.base;
const today = () => predictedToday(b());

const PHONE = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"></rect><path d="M11 18.5h2"></path></svg>`;
// the contract: a block on the chain
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

const fixOf = (a, c) => (c.fix === 'stake' ? html`<button class="primary small-btn" data-test="contract-stake" disabled="${() => !!state.baseBusy}" @click="${() => a.walletAction('contract', 'baseDelegate')}">${() => (state.baseBusy === 'stake' ? 'Staking…' : 'Stake with this app')}</button>`
  : c.fix === 'game' ? html`<button class="small-btn" data-test="contract-play" @click="${() => a.go('game')}">Play today's game</button>`
    : c.fix === 'fund' ? fundRow(a, c) : '');

// plain values in each row, redrawn by key (src/ui/home.js cell: ArrowJS and live values in a redrawn list)
const check = (a, c) => html`<li class="check" data-test="contract-check" data-id="${c.id}" data-state="${c.state}"><span class="cmark">${MARK[c.state]()}</span><div><p>${c.text}</p>${fixOf(a, c)}</div></li>`;

export function contractCard(a) {
  return html`
  <section class="contract-panel" data-test="contract-card" data-open="${() => String(!!state.contractOpen)}" inert="${() => !state.contractOpen}"><div class="contract-inner"><div class="card contract-card">
    <div class="cflow" aria-label="${() => (today() ? 'This app predicted on the Satori contract today' : 'No prediction on the Satori contract yet today')}">
      <span class="cnode">${PHONE()}<small>${() => (b().play === 'manual' ? 'You, by hand' : 'This app')}</small></span>
      <span class="carrow" data-test="contract-arrow" data-on="${() => String(today())}"><i></i><small>${() => (today() ? 'Predicted today' : 'Not yet today')}</small></span>
      <span class="cnode">${BLOCK()}<small>Satori contract</small></span>
    </div>
    <p class="muted small">Each day, predictions are sent directly to the Satori smart contract on Base. They are automatically scored on-chain and earn SATORI.</p>
    <div class="segmented" role="group" aria-label="Who predicts">${[['auto', 'Automatic'], ['manual', 'By hand']].map(([mode, word]) => html`<button class="small-btn" data-test="${`contract-play-${mode}`}" aria-pressed="${() => String(b().play === mode)}" disabled="${() => !b().play}" @click="${() => a.setPlay(mode)}">${word}</button>`)}</div>
    <ul class="checks" data-test="contract-checks">${() => contractChecks(b()).map((c) => check(a, c).key(`${c.id}:${c.state}:${c.text}:${c.address ?? ''}`))}</ul>
    ${unlockPrompt(a, 'contract', 'stake from the contract card')}
    <p class="error small" role="alert" hidden="${() => !(state.baseDid === 'stake' && state.baseError)}">${() => state.baseError}</p>
  </div></div></section>`;
}
