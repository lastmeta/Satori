// Wallet: Base (docs/design/base.md). Up top what people use: the wallet's balances, claimable, staking, who plays (this
// app, or Satori Daily by hand), Stake with this app or Unstake, Claim, Send. Under Details the rest: the round,
// referral, transfers, the gas for the daily batch, the last batch and check, the RPC, the alias (the only place it
// shows) and the invite link. The wallet's actions ask for the passphrase in place (the inline Unlock) when it is locked.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { backupPanel, fact, form, idRow, unlockPrompt } from './parts.js';
import {
  amountText, figure, claimParts, delegationText, lockText, gasText, batchText, checkText, shortHash, rpcText, rpcTitle, playNote, ethFeeText,
  referralText, referralNote, REFERRAL_PCT,
} from './format.js';
import { SATORI_DAILY_URL } from '../chain/config.js';
import { workText } from '../neuron/work.js';
import { OUT_OF_SYNC } from '../neuron/base.js';

// Claimable, one line each (rewards, from the Satori Network, airdrop); Claim beside them when any is above 0
const CLAIM_LINES = [0, 1, 2];
const claimLine = (c, i) => { const [what, x] = claimParts(c)[i]; return `${amountText(x, 'SATORI')} ${what}`; };
const BUSY = { stake: 'Staking…', unstake: 'Unstaking…', claim: 'Claiming…', send: 'Sending…' };

/**
 * A tx hash, linked to the explorer unless the RPC is a local fork; `title` (the call) in its hover. One root
 * node (see streamRow), used as a list item itself: ArrowJS 1.0.6 reuses a rendered chunk for any template of
 * the same text, so a `<li>${…}</li>` wrapping it would take the word list's text slot and print the template.
 */
const txLink = (hash, label = '', title = '') => {
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
  return html`
  <section class="tab-page" data-test="wallet-tab" hidden="${() => state.tab !== 'wallet'}">
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
    </div>
    <dl class="facts">
      <div class="fact"><dt>Claimable</dt><dd class="claim-dd"><span data-test="base-claimable">${CLAIM_LINES.map((i) => html`<span class="line">${() => claimLine(b().claimable, i)}</span>`)}</span>
        <button data-test="base-claim" hidden="${() => !(Number(b().claimable?.total) > 0)}" disabled="${busy}" @click="${() => a.walletAction('wallet', 'baseClaim')}">${() => (state.baseBusy === 'claim' ? BUSY.claim : 'Claim')}</button></dd></div>
      ${fact('Staking', 'base-staking', () => (notStaked() ? 'Not staked: Stake with this app, below' : delegationText(b())))}
    </dl>
    <p class="error small" role="alert" data-test="base-low-gas" hidden="${() => !lowEth()}">The alias is low on Base ETH for the daily batch: ${() => gasText(b().alias)}. Send it a little (Details › Alias).</p>
    <p class="muted small" data-test="base-play" hidden="${() => !play()}">${() => play()?.[0] ?? ''}<a href="${SATORI_DAILY_URL}" target="_blank" rel="noopener">Satori Daily</a>${() => play()?.[1] ?? ''}</p>
    <div class="actions">
      <button class="primary" data-test="base-stake" hidden="${staked}" disabled="${busy}" @click="${() => a.walletAction('wallet', 'baseDelegate')}">${() => (state.baseBusy === 'stake' ? BUSY.stake : 'Stake with this app')}</button>
      <button data-test="base-unstake" hidden="${() => !staked()}" disabled="${busy}" @click="${() => a.walletAction('wallet', 'baseUndelegate')}">${() => (state.baseBusy === 'unstake' ? BUSY.unstake : 'Unstake')}</button>
    </div>
    <p class="muted small" data-test="base-referral-note" hidden="${() => !b().pendingReferrer || !!b().wallet.referral || staked()}">${() => referralNote(shortHash(b().pendingReferrer))}</p>
    <p class="muted small" data-test="base-stake-note">Staking lets this app predict with your wallet's SATORI every round. The SATORI stays in the wallet and earns; it can't be sent while staked, or through the round after you unstake.</p>
    <form class="send" hidden="${() => !!state.sendReview}" @submit="${(e) => a.reviewSend(form(e), e.target)}">
      <select name="asset" aria-label="Asset"><option>SATORI</option><option>ETH</option></select>
      <input name="amount" aria-label="Amount" placeholder="Amount" inputmode="decimal" autocomplete="off" required>
      <input name="to" aria-label="To (0x address)" placeholder="To: 0x…" autocomplete="off" spellcheck="false" required>
      <button type="submit" disabled="${() => busy() || state.sendQuoting}">${() => (state.sendQuoting ? 'Reading the fee…' : 'Send from the wallet')}</button>
    </form>
    <div class="review" data-test="send-review" hidden="${() => !state.sendReview}">
      <h3>Check before sending</h3>
      <dl class="facts">
        ${fact('Send', 'review-amount', () => (q() ? `${q().amount} ${q().asset}` : ''))}
        ${fact('To', 'review-to', html`<code class="block">${() => q()?.to ?? ''}</code>`)}
        ${fact('Fee', 'review-fee', () => (q() ? `about ${ethFeeText(q().fee.about)}, at most ${ethFeeText(q().fee.max)} (Base ETH, from the wallet)` : ''))}
      </dl>
      <form class="unlock" @submit="${(e) => a.confirmSend(form(e), e.target)}"><input name="pass" type="password" aria-label="Wallet passphrase to send" placeholder="Wallet passphrase" autocomplete="current-password" required hidden="${() => !!state.connected}" disabled="${() => !!state.connected}"><button class="primary" type="submit" disabled="${busy}">${() => (state.baseBusy === 'send' ? BUSY.send : state.connected ? `Send in ${state.connected.name}` : 'Send')}</button><button type="button" disabled="${busy}" @click="${a.backSend}">Back</button></form>
    </div>
    ${unlockPrompt(a, 'wallet', 'use the wallet')}
    <p class="muted small" hidden="${() => state.unlocked || !!state.connected}">Stake, Claim and Send ask for the wallet's passphrase. The alias sends the daily batch to the Satori contract on its own; it uses gas (Base ETH).</p>
    <p class="muted small" hidden="${() => !state.unlocked}">Send asks for the wallet's passphrase each time.</p>
    <p class="muted small" data-test="base-connected" hidden="${() => !state.connected}">${() => (state.connected ? `Stake, Claim and Send ask ${state.connected.name} to approve. The alias sends the daily batch to the Satori contract on its own; it uses gas (Base ETH).` : '')}</p>
    <p class="small" role="status" data-test="base-result" hidden="${() => !(state.actionLine || state.baseResult)}">${() => state.actionLine || state.baseResult}</p>
    <div class="txs" data-test="base-txs" hidden="${() => !state.baseTxs.length}">${() => state.baseTxs.map((t) => txLink(t.hash, t.label, t.title).key(t.hash))}</div>
    <p class="error small" role="alert" data-test="base-action-error" hidden="${() => !state.baseError}">${() => state.baseError}</p>
    <details class="mdetails" data-test="base-details">
      <summary>Details</summary>
      <div class="muted small" title="${() => (b().config === 'central' ? 'The app\'s own Satori contract addresses (the Satori Network\'s are checked against them, never used)' : 'The app\'s own Satori contract addresses (the Satori Network serves none)')}">${() => (b().config ? `Base Sepolia · round ${b().round ?? '–'}` : 'Reading the chain…')}</div>
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
        <p class="muted small" data-test="keys-note">${() => (state.keysFrom === 'random' ? "The alias and the Nostr key are random: they're backed up in Settings › Backup."
          : "The alias and the Nostr key are derived from your wallet: no need to back them up, but you can see them here.")}</p>
        <div class="actions"><button class="small-btn" data-test="alias-key" @click="${() => a.askBackup('alias-here')}">Alias private key</button><button class="small-btn" data-test="nostr-key" @click="${() => a.askBackup('nostr-here')}">Nostr key</button></div>
        <p class="muted small" data-test="retired-alias" hidden="${() => !state.retiredAlias}">${() => (state.retiredAlias ? `Your earlier alias, ${shortHash(state.retiredAlias)}: any Base ETH left there is yours.` : '')}
          <button class="small-btn" data-test="retired-key" @click="${() => a.askBackup('retired')}">Its private key</button></p>
        ${backupPanel(a, ['alias-here', 'nostr-here', 'retired'], 'alias-backup', 'Wallet passphrase to show the key')}
      </div>
      <div hidden="${() => !b().inviteLink}">
        ${idRow('Invite link', 'base-invite', () => b().inviteLink, a)}
        <p class="muted small">Whoever opens it and stakes with their own app becomes your referral: you get ${REFERRAL_PCT}% of the rewards they earn, forever, in Claimable.</p>
      </div>
    </details>
  </section>
  ${walletsCard(a)}
  </section>`;
}

/**
 * The Wallets card (docs/design/wallets.md#several-wallets): this app's wallets, the one in use marked; Switch and
 * Remove on the others (Remove asks first); Add a wallet. Tapping an address copies it. One row template, its parts shown or hidden by its values:
 * ArrowJS 1.0.6 reuses a rendered chunk for any template of the same text (see txLink).
 */
function walletsCard(a) {
  const removing = () => state.wallets.wallets.find((w) => w.id === state.walletRemove);
  const row = (w) => html`<li class="wallet-row" data-test="wallet-row" data-id="${w.id}"><code title="${w.address ?? ''}" data-test="wallet-address" role="${w.address ? 'button' : false}" tabindex="${w.address ? '0' : false}" @click="${() => w.address && a.copy(`wallet-${w.id}`, w.address)}">${!w.address ? 'Not set up yet' : state.copied === `wallet-${w.id}` ? 'Copied' : shortHash(w.address)}</code><span class="badge on" hidden="${!w.active}">In use</span><button class="small-btn" data-test="wallet-switch" hidden="${w.active}" @click="${() => a.switchWallet(w.id)}">Switch</button><button class="small-btn" data-test="wallet-remove" hidden="${w.active}" @click="${() => a.askRemoveWallet(w.id)}">Remove</button></li>`
    .key(`${w.id}:${w.address}:${w.active}:${state.copied === `wallet-${w.id}`}`); // tap the address: copied
  return html`<section class="card" data-test="wallets">
    <h2>Wallets</h2>
    <p class="muted small">Each wallet keeps its own data in this app. One runs at a time.</p>
    <ul class="wallet-list">${() => state.wallets.wallets.map(row)}</ul>
    <div class="confirm" data-test="wallet-remove-confirm" hidden="${() => !removing()}">
      <p class="small">${() => (removing() ? `Remove ${removing().address ? shortHash(removing().address) : 'this wallet'}? Its keys and data are deleted from this browser, and its 24 words are the only way back. Back them up first: switch to it, then Settings › Backup.` : '')}</p>
      <div class="actions"><button class="primary" data-test="wallet-remove-yes" @click="${() => a.removeWallet(state.walletRemove)}">Remove it</button><button @click="${a.cancelRemoveWallet}">Cancel</button></div>
    </div>
    <div class="actions"><button data-test="add-wallet" @click="${a.addWallet}">Add a wallet</button></div>
    <p class="error small" role="alert" data-test="wallets-error" hidden="${() => !state.walletsError}">${() => state.walletsError}</p>
  </section>`;
}
