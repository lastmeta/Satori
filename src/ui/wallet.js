// Wallet: Base (docs/design/base.md): the vault's and the identity's balances, Stake with this neuron or Unstake, claims,
// send, the gas for the daily batch, the last batch, and who plays (this neuron, or Satori Daily by hand). The vault's
// actions ask for the passphrase in place (the inline Unlock) when it is locked.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { fact, form, unlockPrompt } from './parts.js';
import {
  amountText, delegationText, lockText, gasText, batchText, checkText, shortHash, rpcText, rpcTitle, playNote,
} from './format.js';
import { SATORI_DAILY_URL } from '../chain/config.js';
import { workText } from '../neuron/work.js';
import { OUT_OF_SYNC } from '../neuron/base.js';

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
  const staked = () => b().vault.staked === 'identity';
  const notStaked = () => b().vault.staked === 'none';
  const lowEth = () => b().identity.lowEth && staked(); // gas matters once the identity has a batch to send
  const busy = () => !!state.baseBusy;
  const play = () => playNote(b().vault.staked);
  return html`
  <section class="tab-page" data-test="wallet-tab" hidden="${() => state.tab !== 'wallet'}">
  <section class="card base">
    <header class="card-head">
      <h2>Base</h2>
      <button class="small-btn" data-test="base-refresh" @click="${a.baseRefresh}" disabled="${busy}">${() => (state.baseBusy === 'refresh' ? 'Reading…' : 'Refresh')}</button>
    </header>
    <div class="muted small" title="${() => (b().config === 'central' ? 'The Satori contract\'s addresses from the Satori Network' : 'Built-in Satori contract addresses (the Satori Network serves none)')}">${() => (b().config ? `Base Sepolia · round ${b().round ?? '–'}` : 'Reading the chain…')}</div>
    <p class="error small" role="status" data-test="base-error" hidden="${() => !b().error}">${() => (b().error ? `The chain did not answer: ${b().error}` : '')}</p>
    <p class="error small" role="alert" data-test="base-sync" hidden="${() => b().vault.inSync !== false}">Staking is out of sync. ${OUT_OF_SYNC}</p>
    <dl class="facts">
      ${fact('Vault', 'base-vault', () => `${amountText(b().vault.satori, 'SATORI')} · ${amountText(b().vault.eth, 'ETH')}`)}
      ${fact('Claimable', 'base-claimable', () => `${amountText(b().claimable.rewards, 'SATORI')} rewards · ${amountText(b().claimable.airdrop, 'SATORI')} airdrop`)}
      ${fact('Staking', 'base-staking', () => (notStaked() ? 'Not staked: Stake with this neuron, below' : delegationText(b())))}
      ${fact('Transfers', 'base-lock', () => lockText(b().vault.lock))}
      ${fact('Identity', 'base-identity', html`<span class="${() => (lowEth() ? 'error' : '')}">${() => gasText(b().identity) + (lowEth() ? ': low, send it a little Base ETH for the Satori contract\'s daily batch' : '')}</span>`)}
      ${fact('Last contract batch', 'base-last-batch', html`<span>${() => batchText(b().lastBatch)}</span> <span>${() => (b().lastBatch ? txLink(b().lastBatch.hash) : '')}</span>`)}
      ${fact('Contract batch check', 'base-check', () => (b().checking ? workText(state.work.base) || 'Checking…'
    : notStaked() ? `Waits until you stake · ${checkText(null, b().nextCheck)}` : checkText(b().lastCheck, b().nextCheck)))}
      ${fact('RPC', 'base-rpc', html`<span title="${() => rpcTitle(b())}">${() => rpcText(b())}</span>`)}
    </dl>
    <p class="muted small" data-test="base-play" hidden="${() => !play()}">${() => play()?.[0] ?? ''}<a href="${SATORI_DAILY_URL}" target="_blank" rel="noopener">Satori Daily</a>${() => play()?.[1] ?? ''}</p>
    <div class="actions">
      <button class="primary" data-test="base-stake" hidden="${staked}" disabled="${busy}" @click="${() => a.vaultAction('wallet', 'baseDelegate')}">${() => (state.baseBusy === 'stake' ? BUSY.stake : 'Stake with this neuron')}</button>
      <button data-test="base-unstake" hidden="${() => !staked()}" disabled="${busy}" @click="${() => a.vaultAction('wallet', 'baseUndelegate')}">${() => (state.baseBusy === 'unstake' ? BUSY.unstake : 'Unstake')}</button>
      <button data-test="base-claim" disabled="${busy}" @click="${() => a.vaultAction('wallet', 'baseClaim')}">${() => (state.baseBusy === 'claim' ? BUSY.claim : 'Claim')}</button>
    </div>
    <p class="muted small" data-test="base-stake-note">Staking lets this neuron predict with your vault's SATORI every round. The SATORI stays in the vault and earns; it can't be sent while staked, or through the round after you unstake. A known contract issue can block unstaking; a fix is coming in the next contract release.</p>
    <form class="send" @submit="${(e) => a.baseSend(form(e), e.target)}">
      <select name="asset" aria-label="Asset"><option>SATORI</option><option>ETH</option></select>
      <input name="amount" aria-label="Amount" placeholder="Amount" inputmode="decimal" autocomplete="off" required>
      <input name="to" aria-label="To (0x address)" placeholder="To: 0x…" autocomplete="off" spellcheck="false" required>
      <button type="submit" disabled="${busy}">${() => (state.baseBusy === 'send' ? BUSY.send : 'Send from the vault')}</button>
    </form>
    ${unlockPrompt(a, 'wallet', 'use the vault')}
    <p class="muted small" hidden="${() => state.unlocked}">Stake, Claim and Send ask for the vault's passphrase. The identity sends the daily batch to the Satori contract on its own; it uses gas (Base ETH).</p>
    <p class="small" role="status" data-test="base-result" hidden="${() => !(state.actionLine || state.baseResult)}">${() => state.actionLine || state.baseResult}</p>
    <div class="txs" data-test="base-txs" hidden="${() => !state.baseTxs.length}">${() => state.baseTxs.map((t) => txLink(t.hash, t.label, t.title).key(t.hash))}</div>
    <p class="error small" role="alert" data-test="base-action-error" hidden="${() => !state.baseError}">${() => state.baseError}</p>
  </section>
  </section>`;
}
