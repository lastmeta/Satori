// Wallet: Base (docs/design/base.md), a card each (the owner, 2026-10-28): the wallet's balances and Send; Receive (the
// address and its QR code); Claimable with Claim; Staking (Stake with this app or Unstake, who plays: this app, or
// Satori Daily by hand); Preload gas; then Details, folded: the round, referral, transfers, the gas for the daily batch,
// the last batch and check, the RPC, the alias (the only place it shows) and the invite link; then the Wallets. The
// wallet's actions ask for the passphrase in place (the inline Unlock), in their card, when it is locked.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { fact, form, idRow, preloadNow, unlockPrompt } from './parts.js';
import {
  amountText, figure, claimParts, delegationText, lockText, gasText, batchText, checkText, shortHash, rpcText, rpcTitle, playNote, ethFeeText,
  referralText, referralNote, REFERRAL_PCT,
} from './format.js';
import { SATORI_DAILY_URL } from '../chain/config.js';
import { qrDataUrl } from './contract.js';
import { workText } from '../neuron/work.js';
import { OUT_OF_SYNC } from '../neuron/base.js';

// Claimable, one line each (rewards, from the Satori Service, airdrop); Claim beside them when any is above 0
const CLAIM_LINES = [0, 1, 2];
const claimLine = (c, i) => { const [what, x] = claimParts(c)[i]; return `${amountText(x, 'SATORI')} ${what}`; };
/** How long the preloaded ETH lasts, in daily batches. */
const daysText = (n) => (!n ? '' : `about ${n >= 1000 ? '1,000+' : n} day${n === 1 ? '' : 's'}`);
const BUSY = { stake: 'Staking…', unstake: 'Unstaking…', claim: 'Claiming…', send: 'Sending…' };

/**
 * A tx hash, linked to the explorer unless the RPC is a local fork; `title` (the call) in its hover. One root
 * node (see streamRow), used as a list item itself: ArrowJS 1.0.6 reuses a rendered chunk for any template of
 * the same text, so a `<li>${…}</li>` wrapping it would take the word list's text slot and print the template.
 */
export const txLink = (hash, label = '', title = '') => {
  const ex = state.base.explorer;
  const text = `${label ? `${label} ` : ''}${shortHash(hash)}`;
  const hover = `${title ? `${title} · ` : ''}${hash}`;
  return ex ? html`<a href="${`${ex}/tx/${hash}`}" target="_blank" rel="noopener" title="${hover}">${text}</a>`
    : html`<code title="${hover}">${text}</code>`;
};

export function walletTab(a) {
  const b = () => state.base;
  const staked = () => b().wallet.staked === 'alias';
  const notStaked = () => b().wallet.staked === 'none';
  const lowEth = () => b().alias.lowEth && staked(); // gas matters once the alias has a batch to send
  const busy = () => !!state.baseBusy;
  const play = () => playNote(b().wallet.staked);
  const q = () => state.sendReview;
  const receiving = () => !!state.wallet && state.contractQr === state.wallet; // Receive: the wallet's address and its QR code
  // An action's outcome in the card it was done in (Claim, Stake and Unstake; Send and the rest in the first): its
  // data-test only where it shows, so each has one.
  const resultIn = () => ({ claim: 'claim', stake: 'stake', unstake: 'stake' })[state.baseDid] ?? 'base';
  const outcome = (card) => html`<div>
    <p class="small" role="status" data-test="${() => (resultIn() === card ? 'base-result' : false)}" hidden="${() => resultIn() !== card || !(state.actionLine || state.baseResult)}">${() => state.actionLine || state.baseResult}</p>
    <div class="txs" data-test="${() => (resultIn() === card ? 'base-txs' : false)}" hidden="${() => resultIn() !== card || !state.baseTxs.length}">${() => (resultIn() === card ? state.baseTxs.map((t) => txLink(t.hash, t.label, t.title).key(t.hash)) : '')}</div>
    <p class="error small" role="alert" data-test="${() => (resultIn() === card ? 'base-action-error' : false)}" hidden="${() => resultIn() !== card || !state.baseError}">${() => state.baseError}</p>
    ${card === 'stake' ? preloadNow(a) : ''}
  </div>`;
  return html`
  <section class="tab-page" data-test="wallet-tab" hidden="${() => state.tab !== 'wallet'}">
  <details class="card" id="wallet-receive" data-test="wallet-receive-card" open="${receiving}" @toggle="${(e) => { if (e.target.open !== receiving()) a.toggleContractQr(state.wallet); }}">
    <summary data-test="base-receive">Show address and QR code</summary>
    <div class="fund receive" data-test="base-receive-panel">
      <p class="muted small">Add Base ETH or SATORI: send it on Base to your wallet's address.</p>
      <img class="qr" data-test="base-qr" alt="QR code of your wallet's address" src="${() => (receiving() ? qrDataUrl(state.wallet) : '')}">
      <code class="block" data-test="base-receive-address">${() => state.wallet ?? ''}</code>
      <div class="actions"><button class="small-btn" @click="${() => a.copy('base-receive', state.wallet)}">${() => (state.copied === 'base-receive' ? 'Copied' : 'Copy')}</button></div>
    </div>
  </details>

  <section class="card base">
    <header class="card-head">
      <h2>Base</h2>
      <button class="small-btn" data-test="base-refresh" @click="${a.baseRefresh}" disabled="${busy}">${() => (state.baseBusy === 'refresh' ? 'Reading…' : 'Refresh')}</button>
    </header>
    <p class="error small" role="status" data-test="base-error" hidden="${() => !b().error}">${() => (b().error ? `The chain did not answer: ${b().error}` : '')}</p>
    <p class="error small" role="alert" data-test="base-sync" hidden="${() => b().wallet.inSync !== false}">Staking is out of sync. ${OUT_OF_SYNC}</p>
    <div class="balance" data-test="base-balance">
      <div><div class="sub">SATORI</div><div class="big" data-test="base-wallet-satori">${() => figure(b().wallet.satori)}</div></div>
      <div><div class="sub">ETH</div><div class="big" data-test="base-wallet-eth">${() => figure(b().wallet.eth)}</div></div>
      <div title="Base ETH this app holds to send predictions for you (its alias pays their gas)"><div class="sub">Preloaded</div><div class="big" data-test="base-preloaded">${() => figure(b().alias.eth)}</div><div class="muted small" data-test="base-preloaded-days" hidden="${() => !daysText(b().alias.batchesLeft)}">${() => daysText(b().alias.batchesLeft)}</div></div>
    </div>
    <form class="send" hidden="${() => !!state.sendReview}" @submit="${(e) => a.reviewSend(form(e), e.target)}">
      <select name="asset" aria-label="Asset"><option>SATORI</option><option>ETH</option></select>
      <input name="amount" aria-label="Amount" placeholder="Amount" inputmode="decimal" autocomplete="off" required>
      <input name="to" aria-label="To (0x address)" placeholder="To: 0x…" autocomplete="off" spellcheck="false" required>
      <button type="submit" disabled="${() => busy() || state.sendQuoting}">${() => (state.sendQuoting ? 'Reading the fee…' : 'Send')}</button>
    </form>
    <div class="review" data-test="send-review" hidden="${() => !state.sendReview}">
      <h3>Check before sending</h3>
      <dl class="facts">
        ${fact('Send', 'review-amount', () => (q() ? `${q().amount} ${q().asset}${q().lessFee ? ' (all of it, less the fee)' : ''}` : ''))}
        ${fact('To', 'review-to', html`<code class="block">${() => q()?.to ?? ''}</code>`)}
        ${fact('Fee', 'review-fee', () => (q() ? `about ${ethFeeText(q().fee.about)}, at most ${ethFeeText(q().fee.max)} (Base ETH, from the wallet)` : ''))}
      </dl>
      <form class="unlock" @submit="${(e) => a.confirmSend(form(e), e.target)}"><input name="pass" type="password" aria-label="Wallet passphrase to send" placeholder="Wallet passphrase" autocomplete="current-password" required hidden="${() => !!state.connected}" disabled="${() => !!state.connected}"><button class="primary" type="submit" disabled="${busy}">${() => (state.baseBusy === 'send' ? BUSY.send : state.connected ? `Send in ${state.connected.name}` : 'Send')}</button><button type="button" disabled="${busy}" @click="${a.backSend}">Back</button></form>
    </div>
    <p class="muted small" hidden="${() => !state.unlocked}">Send asks for the wallet's passphrase each time.</p>
    <p class="muted small" data-test="base-connected" hidden="${() => !state.connected}">${() => (state.connected ? `Stake, Claim and Send ask ${state.connected.name} to approve. The alias sends the daily batch to the Satori contract on its own; it uses gas (Base ETH).` : '')}</p>
    ${outcome('base')}
  </section>

  <section class="card" id="wallet-preload" data-test="wallet-preload-card">
    <p class="error small" role="alert" data-test="base-low-gas" hidden="${() => !lowEth()}">The alias is low on Base ETH for the daily batch: ${() => gasText(b().alias)}. Preload gas, below.</p>
    <div class="side-row">
      <p class="muted small">Preload gas so this app can make predictions on your behalf: it sends Base ETH from your wallet to this app.</p>
      <button data-test="base-preload" disabled="${busy}" @click="${a.preloadForm}">Preload gas</button>
    </div>
  </section>

  <section class="card" data-test="wallet-stake-card">
    <dl class="facts">${fact('Staking', 'base-staking', () => (notStaked() ? 'Not staked: Stake with this app, below' : delegationText(b())))}</dl>
    <div class="side-row">
      <p class="muted small" data-test="base-stake-note">Staking lets this app predict with your wallet's SATORI every round. The SATORI stays in the wallet and earns; it can't be sent while staked, or through the round after you unstake.</p>
      <button class="primary" data-test="base-stake" hidden="${staked}" disabled="${busy}" @click="${() => a.walletAction('wallet-stake', 'baseDelegate')}">${() => (state.baseBusy === 'stake' ? BUSY.stake : 'Stake with this app')}</button>
      <button data-test="base-unstake" hidden="${() => !staked()}" disabled="${busy}" @click="${() => a.walletAction('wallet-stake', 'baseUndelegate')}">${() => (state.baseBusy === 'unstake' ? BUSY.unstake : 'Unstake')}</button>
    </div>
    <p class="muted small" data-test="base-play" hidden="${() => !play()}">${() => play()?.[0] ?? ''}<a class="ext-btn" data-test="base-daily" href="${SATORI_DAILY_URL}" target="_blank" rel="noopener">Satori Daily<span aria-hidden="true">↗</span></a>${() => play()?.[1] ?? ''}</p>
    <p class="muted small" data-test="base-referral-note" hidden="${() => !b().pendingReferrer || !!b().wallet.referral || staked()}">${() => referralNote(shortHash(b().pendingReferrer))}</p>
    ${unlockPrompt(a, 'wallet-stake', () => (staked() ? 'unstake' : 'stake from the Staking card'))}
    ${outcome('stake')}
  </section>

  <section class="card" data-test="wallet-claim-card">
    <dl class="facts"><div class="fact"><dt>Claimable</dt><dd class="claim-dd"><span data-test="base-claimable">${CLAIM_LINES.map((i) => html`<span class="line">${() => claimLine(b().claimable, i)}</span>`)}</span>
      <button class="primary" data-test="base-claim" hidden="${() => !(Number(b().claimable?.total) > 0)}" disabled="${busy}" @click="${() => a.walletAction('wallet-claim', 'baseClaim')}">${() => (state.baseBusy === 'claim' ? BUSY.claim : 'Claim')}</button></dd></div></dl>
    ${unlockPrompt(a, 'wallet-claim', 'claim from the Claimable card')}
    ${outcome('claim')}
  </section>

  <details class="card" data-test="base-details">
      <summary>Details</summary>
      <div class="muted small" title="${() => (b().config === 'central' ? 'The app\'s own Satori contract addresses (the Satori Service\'s are checked against them, never used)' : 'The app\'s own Satori contract addresses (the Satori Service serves none)')}">${() => (b().config ? `Base Sepolia · round ${b().round ?? '–'}` : 'Reading the chain…')}</div>
      <dl class="facts">
        ${fact('Referral', 'base-referral', () => referralText(b()))}
        ${fact('Transfers', 'base-lock', () => lockText(b().wallet.lock))}
        ${fact('Daily batch gas', 'base-alias', html`<span class="${() => (lowEth() ? 'error' : '')}">${() => gasText(b().alias) + (lowEth() ? ': low, send it a little Base ETH for the Satori contract\'s daily batch' : '')}</span>`)}
        ${fact('Last contract batch', 'base-last-batch', html`<span>${() => batchText(b().lastBatch)}</span> <span>${() => (b().lastBatch ? txLink(b().lastBatch.hash) : '')}</span>`)}
        ${fact('Contract batch check', 'base-check', () => (b().checking ? workText(state.work.base) || 'Checking…'
      : notStaked() ? `Waits until you stake · ${checkText(null, b().nextCheck)}` : checkText(b().lastCheck, b().nextCheck)))}
        ${fact('RPC', 'base-rpc', html`<span title="${() => rpcTitle(b())}">${() => rpcText(b())}</span>`)}
      </dl>
      <div class="alias">
        ${idRow('Alias', 'alias', () => state.alias, a)}
        <p class="muted small">The app's own signing address; the daily batch's gas is paid from it.</p>
        <p class="muted small">Its private key: Settings › Backup.</p>
      </div>
      <div hidden="${() => !b().inviteLink}">
        ${idRow('Invite link', 'base-invite', () => b().inviteLink, a)}
        <p class="muted small">Whoever opens it and stakes with their own app becomes your referral: you earn a residual ${REFERRAL_PCT}% bonus.</p>
      </div>
  </details>
  ${nameCard(a)}
  ${walletsCard(a)}
  </section>`;
}

/** A wallet as the app bar and the Wallets list name it: its name, else its short address. */
export const walletLabel = (w) => w?.name || (w?.address ? shortHash(w.address) : '');
const inUse = () => state.wallets.wallets.find((w) => w.active);

/** The Name card (docs/design/wallets.md#names): the wallet in use named, shown in the app bar and the Wallets list. */
function nameCard(a) {
  return html`<section class="card" data-test="wallet-name-card">
    <h2>Name</h2>
    <p class="muted small">A name for this wallet, shown at the top of the app and in the Wallets list. Only on this device.</p>
    <form class="devfee-form" @submit="${(e) => a.saveWalletName(form(e).name ?? '')}">
      <input name="name" data-test="wallet-name" aria-label="This wallet's name" placeholder="This wallet's name" maxlength="40" autocomplete="off" value="${() => inUse()?.name ?? ''}">
      <button type="submit" data-test="wallet-name-save">Save</button>
    </form>
    <p class="muted small" data-test="wallet-name-auto" hidden="${() => !inUse()?.nameAuto}">Named for the special key it holds. A name you save takes its place.</p>
    <p class="small" role="status" data-test="wallet-name-said" hidden="${() => !state.walletNameSaid}">${() => state.walletNameSaid}</p>
    <p class="error small" role="alert" hidden="${() => !state.walletNameError}">${() => state.walletNameError}</p>
  </section>`;
}

/**
 * The Wallets card (docs/design/wallets.md#several-wallets): this app's wallets, the one in use marked; Switch and
 * Remove on the others (Remove asks first); Add a wallet. Tapping an address copies it. One row template, its parts shown or hidden by its values:
 * ArrowJS 1.0.6 reuses a rendered chunk for any template of the same text (see txLink).
 */
function walletsCard(a) {
  const removing = () => state.wallets.wallets.find((w) => w.id === state.walletRemove);
  const row = (w) => html`<li class="wallet-row" data-test="wallet-row" data-id="${w.id}"><span class="wallet-id"><b data-test="wallet-row-name" hidden="${!w.name}">${w.name ?? ''}</b><code title="${w.address ?? ''}" data-test="wallet-address" role="${w.address ? 'button' : false}" tabindex="${w.address ? '0' : false}" @click="${() => w.address && a.copy(`wallet-${w.id}`, w.address)}">${!w.address ? 'Not set up yet' : state.copied === `wallet-${w.id}` ? 'Copied' : shortHash(w.address)}</code></span><span class="badge on" hidden="${!w.active}">In use</span><button class="small-btn" data-test="wallet-switch" hidden="${w.active}" @click="${() => a.switchWallet(w.id)}">Switch</button><button class="small-btn" data-test="wallet-remove" hidden="${w.active}" @click="${() => a.askRemoveWallet(w.id)}">Remove</button></li>`
    .key(`${w.id}:${w.address}:${w.name}:${w.active}:${state.copied === `wallet-${w.id}`}`); // tap the address: copied
  return html`<section class="card" data-test="wallets">
    <h2>Wallets</h2>
    <p class="muted small">Each wallet keeps its own data in this app. One runs at a time.</p>
    <ul class="wallet-list">${() => state.wallets.wallets.map(row)}</ul>
    <div class="confirm" data-test="wallet-remove-confirm" hidden="${() => !removing()}">
      <p class="small">${() => (removing() ? `Remove ${removing().address ? shortHash(removing().address) : 'this wallet'}? It leaves this list, and its 24 words are the way back: back them up first (switch to it, then Settings › Backup). Its file stays set aside in this browser, never deleted.${state.walletRemoveNeeds === 'passphrase' ? " Enter that wallet's passphrase to remove it." : ''}` : '')}</p>
      <form class="unlock" @submit="${(e) => a.removeWallet(form(e), e.target)}"><input name="pass" type="password" data-test="wallet-remove-pass" aria-label="That wallet's passphrase to remove it" placeholder="Its wallet passphrase" autocomplete="off" required hidden="${() => state.walletRemoveNeeds !== 'passphrase'}" disabled="${() => state.walletRemoveNeeds !== 'passphrase'}"><button class="primary" type="submit" data-test="wallet-remove-yes" disabled="${() => !state.walletRemoveNeeds}">Remove it</button><button type="button" @click="${a.cancelRemoveWallet}">Cancel</button></form>
    </div>
    <div class="actions"><button data-test="add-wallet" @click="${a.addWallet}">Add a wallet</button></div>
    <p class="error small" role="alert" data-test="wallets-error" hidden="${() => !state.walletsError}">${() => state.walletsError}</p>
  </section>`;
}
