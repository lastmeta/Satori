// Wallet: Base (docs/design/base.md): the vault's and the identity's balances, Delegate or Stop delegating, claims,
// send, the gas for the daily batch, the last batch, and who plays (this neuron, or Satori Daily by hand). The vault's
// actions ask for the passphrase in place (the inline Unlock) when it is locked.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { fact, form, unlockPrompt } from './parts.js';
import {
  amountText, delegationText, lockText, gasText, batchText, checkText, shortHash, rpcText, rpcTitle, playNote,
} from './format.js';
import { SATORI_DAILY_URL } from '../chain/config.js';

const BUSY = { delegate: 'Delegating…', undelegate: 'Stopping…', claim: 'Claiming…', send: 'Sending…' };

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
  const delegated = () => b().vault.delegated === 'identity';
  const notDelegated = () => b().vault.delegated === 'none';
  const lowEth = () => b().identity.lowEth && delegated(); // gas matters once the identity has a batch to send
  const busy = () => !!state.baseBusy;
  const play = () => playNote(b().vault.delegated);
  return html`
  <section class="tab-page" data-test="wallet-tab" hidden="${() => state.tab !== 'wallet'}">
  <section class="card base">
    <header class="card-head">
      <h2>Base</h2>
      <button class="small-btn" data-test="base-refresh" @click="${a.baseRefresh}" disabled="${busy}">${() => (state.baseBusy === 'refresh' ? 'Reading…' : 'Refresh')}</button>
    </header>
    <div class="muted small" title="${() => (b().config === 'central' ? 'Contract addresses from central' : 'Built-in contract addresses (central serves none)')}">${() => (b().config ? `Base Sepolia · round ${b().round ?? '–'}` : 'Reading the chain…')}</div>
    <p class="error small" role="status" data-test="base-error" hidden="${() => !b().error}">${() => (b().error ? `The chain did not answer: ${b().error}` : '')}</p>
    <dl class="facts">
      ${fact('Vault', 'base-vault', () => `${amountText(b().vault.satori, 'SATORI')} · ${amountText(b().vault.eth, 'ETH')}`)}
      ${fact('Claimable', 'base-claimable', () => `${amountText(b().claimable.rewards, 'SATORI')} rewards · ${amountText(b().claimable.airdrop, 'SATORI')} airdrop`)}
      ${fact('Delegation', 'base-delegation', () => (notDelegated() ? 'Not delegated: Delegate prediction power, below' : delegationText(b())))}
      ${fact('Transfers', 'base-lock', () => lockText(b().vault.lock))}
      ${fact('Identity', 'base-identity', html`<span class="${() => (lowEth() ? 'error' : '')}">${() => gasText(b().identity) + (lowEth() ? ': low, send it a little Base ETH for the daily batch' : '')}</span>`)}
      ${fact('Last batch', 'base-last-batch', html`<span>${() => batchText(b().lastBatch)}</span> <span>${() => (b().lastBatch ? txLink(b().lastBatch.hash) : '')}</span>`)}
      ${fact('Batch check', 'base-check', () => (b().checking ? 'Checking…'
    : notDelegated() ? `Waits for delegation · ${checkText(null, b().nextCheck)}` : checkText(b().lastCheck, b().nextCheck)))}
      ${fact('RPC', 'base-rpc', html`<span title="${() => rpcTitle(b())}">${() => rpcText(b())}</span>`)}
    </dl>
    <p class="muted small" data-test="base-play" hidden="${() => !play()}">${() => play()?.[0] ?? ''}<a href="${SATORI_DAILY_URL}" target="_blank" rel="noopener">Satori Daily</a>${() => play()?.[1] ?? ''}</p>
    <div class="actions">
      <button class="primary" data-test="base-delegate" hidden="${delegated}" disabled="${busy}" @click="${() => a.vaultAction('wallet', 'baseDelegate')}">${() => (state.baseBusy === 'delegate' ? BUSY.delegate : 'Delegate prediction power')}</button>
      <button data-test="base-undelegate" hidden="${() => !delegated()}" disabled="${busy}" @click="${() => a.vaultAction('wallet', 'baseUndelegate')}">${() => (state.baseBusy === 'undelegate' ? BUSY.undelegate : 'Stop delegating')}</button>
      <button data-test="base-claim" disabled="${busy}" @click="${() => a.vaultAction('wallet', 'baseClaim')}">${() => (state.baseBusy === 'claim' ? BUSY.claim : 'Claim')}</button>
    </div>
    <p class="muted small">Delegating lets the identity predict with the vault's SATORI; the SATORI stays in the vault, transfer-locked while delegated and through the round after you stop.</p>
    <form class="send" @submit="${(e) => a.baseSend(form(e), e.target)}">
      <select name="asset" aria-label="Asset"><option>SATORI</option><option>ETH</option></select>
      <input name="amount" aria-label="Amount" placeholder="Amount" inputmode="decimal" autocomplete="off" required>
      <input name="to" aria-label="To (0x address)" placeholder="To: 0x…" autocomplete="off" spellcheck="false" required>
      <button type="submit" disabled="${busy}">${() => (state.baseBusy === 'send' ? BUSY.send : 'Send from the vault')}</button>
    </form>
    ${unlockPrompt(a, 'wallet', 'use the vault')}
    <p class="muted small" hidden="${() => state.unlocked}">Delegate, Claim and Send ask for the vault's passphrase. The identity sends the daily batch on its own.</p>
    <p class="small" role="status" data-test="base-result" hidden="${() => !state.baseResult}">${() => state.baseResult}</p>
    <div class="txs" data-test="base-txs" hidden="${() => !state.baseTxs.length}">${() => state.baseTxs.map((t) => txLink(t.hash, t.label, t.title).key(t.hash))}</div>
    <p class="error small" role="alert" data-test="base-action-error" hidden="${() => !state.baseError}">${() => state.baseError}</p>
  </section>
  </section>`;
}
