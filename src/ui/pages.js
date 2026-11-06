// The Satori Service and Satori contract pages (the owner, 2026-11-05): everything that is one kind of scoring only,
// gathered from Settings, Streams and Wallet. Satori Service: off-chain scoring (predictions sent to the Service, its
// streams, the reward address, the pool, its alias, its address). Satori contract: on-chain scoring (who sends the daily
// batch, the batch itself, the alias that sends it, the referral, the Game). Home keeps its chips; Settings keeps the
// keys, backup, appearance, this device and Advanced (relays, Base).
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { aliasForm, centralForm, poolCard, predictions, rewardCard, servicePredictions, workerPoolCard } from './settings.js';
import { streamsCard } from './streams.js';
import { batchCard, contractAliasRow, referralCard } from './wallet.js';
import { contractChecks, networkChecks } from './contractflow.js';
import { MARK } from './contract.js';
import { idRow } from './parts.js';

const nowS = () => Date.now() / 1000;

/** How it is going, as Home's chip says it (src/ui/contractflow.js), in words only: the fixes are on Home. */
const status = (test, title, list) => html`
  <section class="card settings-section" data-test="${test}">
    <h2>${title}</h2>
    <ul class="checks plain">${() => list().map((c) => html`<li class="check" data-test="page-check" data-state="${c.state}"><span class="cmark">${(MARK[c.state] ?? MARK.wait)()}</span><div><p>${c.text}</p></div></li>`.key(`${c.id}:${c.state}:${c.text}`))}</ul>
  </section>`;

export function serviceTab(a) {
  return html`
  <section class="tab-page" data-test="service-tab" hidden="${() => state.tab !== 'service'}">
    ${status('service-status', 'Satori Service', () => networkChecks(state.central, nowS()))}
    ${servicePredictions(a)}
    ${streamsCard(a)}
    ${rewardCard(a)}
    ${poolCard(a)}
    ${workerPoolCard(a)}
    <section class="card settings-section" id="service-alias" data-test="service-alias-card">
      <h2>Alias</h2>
      <div class="alias">
        ${idRow('Alias', 'service-alias', () => state.serviceAlias, a)}
        <p class="muted small">${() => (state.serviceAlias && state.serviceAlias !== state.alias ? 'An alias you gave this job (below), not this app\'s own. Its private key: Settings › Backup.'
          : "This app's own alias. Its private key: Settings › Backup.")}</p>
      </div>
      ${aliasForm(a, 'offchain', '', 'Signs in and sends the predictions the Satori Service scores. Another one, such as your Docker install\'s, can do this instead of this app\'s own.', { address: false })}
    </section>
    ${centralForm(a)}
  </section>`;
}

export function contractTab(a) {
  return html`
  <section class="tab-page" data-test="contract-tab" hidden="${() => state.tab !== 'contract'}">
    ${status('contract-status', 'Satori contract', () => contractChecks(state.base))}
    ${predictions(a)}
    <section class="card settings-section" id="contract-game" data-test="contract-game-card">
      <h2>Game</h2>
      <p class="muted small">Play the Satori contract's games yourself in the Game tab (choose By hand above first).</p>
      <div class="actions"><button type="button" data-test="contract-go-game" @click="${() => a.go('game')}">Open the Game</button></div>
    </section>
    ${batchCard()}
    <section class="card settings-section" id="contract-alias" data-test="contract-alias-card">
      <h2>Alias</h2>
      ${contractAliasRow(a)}
      ${aliasForm(a, 'onchain', '', 'Your wallet stakes with it and it sends the daily batch, paying its gas. Another one can do this instead of this app\'s own; after a change, stake with it again.', { address: false })}
    </section>
    ${referralCard(a)}
  </section>`;
}
