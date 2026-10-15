// The screens: Setup, Home, "open in another tab". ArrowJS.
// Every screen is built once and shown or hidden, so typing is never lost to a
// re-render. Secrets typed into forms are read on submit, not kept in state.
import { html, reactive, watch } from '@arrow-js/core';
import {
  fmtNum, fmtWhen, registrationText, mismatchText, pollText, submitText, modelTitle,
  fmtCadence, shortKey, relayText, obsText, rawText, catalogMatch, predText,
  amountText, delegationText, lockText, gasText, batchText, checkText, claimLine, shortHash, rpcText, rpcTitle,
} from './format.js';
import { MIN_PASSPHRASE } from '../keys/index.js';

export const state = reactive({
  screen: 'loading', // loading | elsewhere | fatal | setup | home
  fatal: '',
  busy: '', // what is running: '' | 'setup' | 'unlock'
  error: '',
  // setup
  step: 'choose', // choose | words | confirm | restore | docker | passphrase
  words: [],
  confirmAt: [],
  // home
  identity: '', // address
  vault: '', // address
  unlocked: false,
  vaultError: '',
  backup: '', // '' | 'identity' | 'vault': which key's words are shown
  backupWords: '',
  backupWif: '',
  copied: '',
  central: { url: '', registration: null, lastPoll: null, nextPoll: null, polling: false, lastSubmit: null, pending: 0 },
  centralDefault: '',
  streams: [],
  settingsError: '',
  // Nostr (docs/design/nostr.md): the flow's status, the last catalog
  nostr: { pubkey: '', npub: '', maxStreams: 0, centralWrite: false, userRelays: [], relays: [], subscriptions: [] },
  catalog: [],
  catalogQuery: '',
  discovering: false,
  subscribing: '', // `${pubkey}:${stream}` in flight
  networkError: '',
  relaysError: '',
  // Base (docs/design/base.md): the status (window.satori.base()'s shape), what runs, the last action's result
  base: {
    rpc: [], rpcSetting: '', maxFeeSetting: null, maxFeeGwei: null, localFork: false, explorer: null, config: null, error: '', round: null,
    identity: { address: '', eth: null, power: null, batchesLeft: null, lowEth: false },
    vault: { address: '', eth: null, satori: null, delegate: null, delegated: null, lock: null },
    claimable: { rewards: null, airdrop: null }, lastBatch: null, lastCheck: null, nextCheck: null, checking: false,
  },
  baseBusy: '', // '' | 'refresh' | 'delegate' | 'undelegate' | 'claim' | 'send'
  baseError: '',
  baseResult: '',
  baseTxs: [], // the last action's transactions: [{ label, hash }]
  baseRpcError: '',
});

export const CATALOG_SHOWN = 50;

const show = (screen) => () => state.screen !== screen;
const showStep = (step) => () => state.step !== step;
const form = (e) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.target));
};
const fact = (label, test, text) => html`<div class="fact"><dt>${label}</dt><dd data-test="${test}">${text}</dd></div>`;
const errorLine = () => html`<p class="error" role="alert" hidden="${() => !state.error}">${() => state.error}</p>`;
const wordList = (words) => html`<ol class="words">${() => words().map((w) => html`<li>${w}</li>`)}</ol>`;

function setup(a) {
  return html`
  <section class="card" hidden="${show('setup')}">
    <div hidden="${showStep('choose')}">
      <h2>Set up this neuron</h2>
      <p class="muted">A neuron has two keys. The <strong>identity</strong> runs the neuron on its own,
        so it stays unencrypted in this browser. The <strong>vault</strong> holds your funds and is
        encrypted with your passphrase.</p>
      <div class="actions">
        <button class="primary" @click="${a.newWords}">Create a new neuron</button>
        <button @click="${() => a.goStep('restore')}">Restore from words</button>
        <button @click="${() => a.goStep('docker')}">Import Docker files</button>
      </div>
    </div>

    <div hidden="${showStep('words')}">
      <h2>Your vault’s 24 words</h2>
      <p class="muted">Write them down in order and keep them safe. They are the only way to recover
        your vault if this browser loses its data.</p>
      ${wordList(() => state.words)}
      <div class="actions">
        <button class="primary" @click="${a.toConfirm}">I wrote them down</button>
        <button @click="${() => a.goStep('choose')}">Back</button>
      </div>
    </div>

    <form hidden="${showStep('confirm')}" @submit="${(e) => a.confirmWords(form(e), e.target)}">
      <h2>Check your words</h2>
      <p class="muted">Enter these words from your list.</p>
      <div class="fields">${() => state.confirmAt.map((i) => html`
        <label>Word #${i + 1}
          <input name="${`w${i}`}" autocomplete="off" autocapitalize="off" spellcheck="false" required>
        </label>`)}
      </div>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit">Continue</button>
        <button type="button" @click="${() => a.goStep('words')}">Show the words again</button>
      </div>
    </form>

    <form hidden="${showStep('restore')}" @submit="${(e) => a.restoreWords(form(e), e.target)}">
      <h2>Restore from words</h2>
      <label>Vault words (24)
        <textarea name="vault" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea>
      </label>
      <label>Identity words (24, optional: a new identity is made if empty)
        <textarea name="identity" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      </label>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit">Continue</button>
        <button type="button" @click="${() => a.goStep('choose')}">Back</button>
      </div>
    </form>

    <form hidden="${showStep('docker')}" @submit="${(e) => { e.preventDefault(); a.importDocker(e.target); }}">
      <h2>Import Docker files</h2>
      <p class="muted">The two files from a Docker neuron’s wallet folder (unzip “Download Wallet” first).</p>
      <label>wallet.yaml (identity) <input name="wallet" type="file" accept=".yaml,.yml" required></label>
      <label>vault.yaml <input name="vault" type="file" accept=".yaml,.yml" required></label>
      <label>nostr.yaml (optional: a new Nostr key is made if empty) <input name="nostr" type="file" accept=".yaml,.yml"></label>
      <label>Vault password <input name="pass" type="password" autocomplete="current-password" required></label>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit" disabled="${() => !!state.busy}">${() => (state.busy ? 'Importing…' : 'Import')}</button>
        <button type="button" @click="${() => a.goStep('choose')}">Back</button>
      </div>
    </form>

    <form hidden="${showStep('passphrase')}" @submit="${(e) => a.createKeys(form(e), e.target)}">
      <h2>Choose a passphrase</h2>
      <p class="muted">It encrypts the vault in this browser. At least ${MIN_PASSPHRASE} characters,
        Latin-1 only (no emoji or €), as Docker needs.</p>
      <label>Passphrase <input name="pass1" type="password" autocomplete="new-password" required></label>
      <label>Repeat passphrase <input name="pass2" type="password" autocomplete="new-password" required></label>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit" disabled="${() => !!state.busy}">${() => (state.busy ? 'Encrypting…' : 'Create')}</button>
      </div>
    </form>
  </section>`;
}

/** One of a key's identifiers (`value` a function), with Copy. */
function idRow(kind, test, value, a, title = () => '') {
  return html`<div class="id"><span class="label">${kind}</span><code data-test="${test}" title="${title}">${value}</code><button class="small-btn" @click="${() => a.copy(test, value())}">${() => (state.copied === test ? 'Copied' : 'Copy')}</button></div>`;
}

/** The three keys, each with its identifiers: Evrmore and Base addresses, the Nostr pubkey. */
function keys(a) {
  return html`
  <div class="card keys">
    <div class="key">
      <h3>Identity</h3>
      ${idRow('Evrmore', 'identity', () => state.identity, a)}
      ${idRow('Base', 'identity-base', () => state.base.identity.address, a)}
      <p class="muted small">Runs the neuron on its own: signs in to central and sends the daily Base batch. Unencrypted.</p>
    </div>
    <div class="key">
      <h3>Vault <span class="${() => (state.unlocked ? 'badge on' : 'badge')}" data-test="vault-state">${() => (state.unlocked ? 'Unlocked' : 'Locked')}</span></h3>
      ${idRow('Evrmore', 'vault', () => state.vault, a)}
      ${idRow('Base', 'vault-base', () => state.base.vault.address, a)}
      <p class="muted small">Holds your funds. Encrypted with your passphrase.</p>
      <form class="unlock" hidden="${() => state.unlocked}" @submit="${(e) => a.unlock(form(e), e.target)}">
        <input name="pass" type="password" aria-label="Vault passphrase" placeholder="Vault passphrase" autocomplete="current-password" required>
        <button class="primary" type="submit" data-test="unlock" disabled="${() => !!state.busy}">${() => (state.busy === 'unlock' ? 'Unlocking…' : 'Unlock')}</button>
      </form>
      <p class="error small" role="alert" hidden="${() => !state.vaultError}">${() => state.vaultError}</p>
    </div>
    <div class="key">
      <h3>Nostr</h3>
      ${idRow('Pubkey', 'nostr-pubkey', () => state.nostr.pubkey, a, () => state.nostr.npub)}
      <p class="muted small">Signs the neuron's Nostr events on its own. Unencrypted, as the identity.</p>
    </div>
  </div>`;
}

function centralCard(a) {
  const c = () => state.central;
  return html`
  <section class="card central">
    <header class="card-head">
      <h2>Central</h2>
      <button class="small-btn" data-test="poll-now" @click="${a.pollNow}" disabled="${() => state.central.polling}">${() => (state.central.polling ? 'Polling…' : 'Poll now')}</button>
    </header>
    <code data-test="central-url">${() => c().url}</code>
    <dl class="facts">
      ${fact('Registered', 'registered', () => registrationText(c().registration))}
      ${fact('Last poll', 'last-poll', () => pollText(c().lastPoll))}
      ${fact('Next poll', 'next-poll', () => fmtWhen(c().nextPoll))}
      ${fact('Last submission', 'last-submit', () => submitText(c().lastSubmit))}
      ${fact('Pending', 'pending', () => String(c().pending))}
    </dl>
    <p class="error small" role="status" data-test="mismatch" hidden="${() => !mismatchText(c().registration, state.vault)}">${() => mismatchText(c().registration, state.vault)}</p>
    ${streams()}
  </section>`;
}

function streamRow(r) {
  // One root node, no whitespace around it: ArrowJS 1.0.6 breaks a keyed list
  // of multi-node items once it goes empty and back.
  const sent = r.status === 'sent';
  return html`<div class="row srow" data-test="stream"><span class="sname" title="${r.uuid}">${r.name}</span><span class="num" data-label="Latest" data-test="obs">${fmtNum(r.obs_value)}</span><span class="muted small" data-label="Observed">${fmtWhen(r.obs_ts)}</span><span class="num" data-label="t1" data-test="t1">${fmtNum(r.t1)}</span><span class="num accent" data-label="t2" data-test="t2">${fmtNum(r.t2)}</span><span class="model" data-label="Model" data-test="model" title="${modelTitle(r)}">${r.model ?? '–'}</span><span class="${r.status ? (sent ? 'badge on' : 'badge') : 'muted'}" data-test="status">${r.status ? (sent ? 'Sent' : 'Pending') : '–'}</span></div>`;
}

/** Central's streams with our t1 and t2: collapsed in the Central card (central2 has ~80). */
function streams() {
  return html`
    <p class="muted small streams-none" hidden="${() => state.streams.length > 0}">Streams: none yet. They arrive with the first poll.</p>
    <details class="streams" data-test="streams" hidden="${() => !state.streams.length}">
      <summary>${() => `Streams: ${state.streams.length} from central, with our forecasts`}</summary>
      <div class="srows">
        <div class="row srow head" aria-hidden="true"><span>Stream</span><span class="num">Latest</span><span>Observed</span><span class="num">t1</span><span class="num">t2</span><span>Model</span><span></span></div>
        <div>${() => state.streams.map((r) => streamRow(r).key(r.uuid))}</div>
      </div>
    </details>`;
}

function relayRow(r) {
  return html`<li class="relay" data-test="relay"><code>${r.url}</code><span class="${r.state === 'open' ? 'badge on' : 'badge'}" data-test="relay-state">${relayText(r)}</span></li>`;
}

function subRow(s, a) {
  // One root node, no whitespace around it (see streamRow).
  const p = s.prediction;
  return html`<div class="row nrow" data-test="sub"><span class="sname" title="${`${s.stream} from ${s.provider}`}">${s.name || s.stream}</span><span class="num" data-label="Latest" data-test="sub-obs" title="${s.observation ? `sent as ${rawText(s.observation)}` : ''}">${obsText(s.observation)}</span><span class="muted small" data-label="Observed">${fmtWhen(s.observation?.ts)}</span><span class="num accent" data-label="Our _pred" data-test="sub-pred" title="${p ? `${p.stream} · ${p.model} · sent as "${p.value}"` : ''}">${predText(p?.value)}</span><span class="num muted" data-label="Seq" data-test="sub-seq">${p?.seq ?? '–'}</span><span class="muted small" data-label="Relays" data-test="sub-relays">${p ? `${p.relays} relay${p.relays === 1 ? '' : 's'}` : '–'}</span><button class="link" data-test="unsubscribe" @click="${() => a.subscribe(s.provider, s.stream, false)}" disabled="${() => !!state.subscribing}">Unsubscribe</button></div>`;
}

function nostrCard(a) {
  const n = () => state.nostr;
  return html`
  <section class="card nostr">
    <header class="card-head">
      <h2>Nostr</h2>
      <span class="muted small">${() => `${n().subscriptions.length} of ${n().maxStreams} streams`}</span>
    </header>
    <ul class="relays">${() => n().relays.map((r) => relayRow(r).key(`${r.url} ${r.state} ${r.write}`))}</ul>
    <p class="muted" hidden="${() => n().subscriptions.length > 0}">No streams yet: subscribe under Network streams. Each new observation is forecast and published as <code>&lt;stream&gt;_pred</code>.</p>
    <div class="srows" hidden="${() => !n().subscriptions.length}">
      <div class="row nrow head" aria-hidden="true"><span>Stream</span><span class="num">Latest</span><span>Observed</span><span class="num">Our _pred</span><span class="num">Seq</span><span>Relays</span><span></span></div>
      <div>${() => n().subscriptions.map((s) => subRow(s, a).key(`${s.uuid} ${s.observation?.seq} ${s.prediction?.seq}`))}</div>
    </div>
  </section>`;
}

const BUSY = { delegate: 'Delegating…', undelegate: 'Stopping…', claim: 'Claiming…', send: 'Sending…' };

/** A tx hash, linked to the explorer unless the RPC is a local fork; `title` (the call) in its hover. One root node (see streamRow). */
const txLink = (hash, label = '', title = '') => {
  const ex = state.base.explorer;
  const text = `${label ? `${label} ` : ''}${shortHash(hash)}`;
  const hover = `${title ? `${title} · ` : ''}${hash}`;
  return ex ? html`<a href="${`${ex}/tx/${hash}`}" target="_blank" rel="noopener" title="${hover}">${text}</a>`
    : html`<code title="${hover}">${text}</code>`;
};

function baseCard(a) {
  const b = () => state.base;
  const delegated = () => b().vault.delegated === 'identity';
  const notDelegated = () => b().vault.delegated === 'none';
  const lowEth = () => b().identity.lowEth && delegated(); // gas matters once the identity has a batch to send
  const busy = () => !!state.baseBusy;
  return html`
  <section class="card base">
    <header class="card-head">
      <h2>Base</h2>
      <button class="small-btn" @click="${a.baseRefresh}" disabled="${busy}">${() => (state.baseBusy === 'refresh' ? 'Reading…' : 'Refresh')}</button>
    </header>
    <div class="muted small" title="${() => (b().config === 'central' ? 'Contract addresses from central' : 'Built-in contract addresses (central serves none)')}">${() => (b().config ? `Base Sepolia · round ${b().round ?? '–'}` : 'Reading the chain…')}</div>
    <p class="error small" role="status" data-test="base-error" hidden="${() => !b().error}">${() => (b().error ? `The chain did not answer: ${b().error}` : '')}</p>
    <dl class="facts">
      ${fact('RPC', 'base-rpc', html`<span title="${() => rpcTitle(b())}">${() => rpcText(b())}</span>`)}
      ${fact('Identity', 'base-identity', html`<span class="${() => (lowEth() ? 'error' : '')}">${() => gasText(b().identity) + (lowEth() ? ': low, send it a little Base ETH for the daily batch' : '')}</span>`)}
      ${fact('Vault', 'base-vault', () => `${amountText(b().vault.satori, 'SATORI')} · ${amountText(b().vault.eth, 'ETH')}`)}
      ${fact('Delegation', 'base-delegation', () => (notDelegated()
    ? `Not delegated: ${state.unlocked ? 'Delegate prediction power, below' : 'Unlock, then Delegate prediction power'}` : delegationText(b())))}
      ${fact('Transfers', 'base-lock', () => lockText(b().vault.lock))}
      ${fact('Claimable', 'base-claimable', () => `${amountText(b().claimable.rewards, 'SATORI')} rewards · ${amountText(b().claimable.airdrop, 'SATORI')} airdrop`)}
      ${fact('Last batch', 'base-last-batch', html`<span>${() => batchText(b().lastBatch)}</span> <span>${() => (b().lastBatch ? txLink(b().lastBatch.hash) : '')}</span>`)}
      ${fact('Batch check', 'base-check', () => (b().checking ? 'Checking…'
    : notDelegated() ? `Waits for delegation · ${checkText(null, b().nextCheck)}` : checkText(b().lastCheck, b().nextCheck)))}
    </dl>
    <p class="muted small" hidden="${() => state.unlocked}">Unlock the vault to delegate, claim or send. The identity sends the daily batch on its own.</p>
    <div hidden="${() => !state.unlocked}">
      <div class="actions">
        <button class="primary" data-test="base-delegate" hidden="${delegated}" disabled="${busy}" @click="${a.baseDelegate}">${() => (state.baseBusy === 'delegate' ? BUSY.delegate : 'Delegate prediction power')}</button>
        <button data-test="base-undelegate" hidden="${() => !delegated()}" disabled="${busy}" @click="${a.baseUndelegate}">${() => (state.baseBusy === 'undelegate' ? BUSY.undelegate : 'Stop delegating')}</button>
        <button data-test="base-claim" disabled="${busy}" @click="${a.baseClaim}">${() => (state.baseBusy === 'claim' ? BUSY.claim : 'Claim')}</button>
      </div>
      <p class="muted small">Delegating lets the identity predict with the vault's SATORI; the SATORI stays in the vault, transfer-locked while delegated and through the round after you stop.</p>
      <form class="send" @submit="${(e) => a.baseSend(form(e), e.target)}">
        <select name="asset" aria-label="Asset"><option>SATORI</option><option>ETH</option></select>
        <input name="amount" aria-label="Amount" placeholder="Amount" inputmode="decimal" autocomplete="off" required>
        <input name="to" aria-label="To (0x address)" placeholder="To: 0x…" autocomplete="off" spellcheck="false" required>
        <button type="submit" disabled="${busy}">${() => (state.baseBusy === 'send' ? BUSY.send : 'Send from the vault')}</button>
      </form>
    </div>
    <p class="small" role="status" data-test="base-result" hidden="${() => !state.baseResult}">${() => state.baseResult}</p>
    <ul class="txs" data-test="base-txs" hidden="${() => !state.baseTxs.length}">${() => state.baseTxs.map((t) => html`<li>${txLink(t.hash, t.label, t.title)}</li>`.key(t.hash))}</ul>
    <p class="error small" role="alert" data-test="base-action-error" hidden="${() => !state.baseError}">${() => state.baseError}</p>
  </section>`;
}

function catRow(s, a) {
  const key = `${s.pubkey}:${s.stream_name}`;
  const paid = s.price_per_obs > 0 || s.encrypted || s.approval_required;
  return html`<div class="crow" data-test="catalog-row"><div class="cmain"><span class="sname">${s.name || s.stream_name}</span> <span class="muted small">${s.stream_name} · ${fmtCadence(s.cadence_seconds)} · <span class="nowrap" title="${s.pubkey}">${shortKey(s.pubkey)}</span>${paid ? ' · paid or gated (later)' : ''}</span><div class="muted small desc">${s.description}</div></div><button class="${s.subscribed ? 'small-btn' : 'small-btn primary'}" data-test="catalog-action" disabled="${() => paid || !!state.subscribing}" @click="${() => a.subscribe(s.pubkey, s.stream_name, !s.subscribed)}">${() => (state.subscribing === key ? '…' : s.subscribed ? 'Unsubscribe' : 'Subscribe')}</button></div>`;
}

const shownCatalog = () => state.catalog.filter((s) => !s.pred && catalogMatch(s, state.catalogQuery));

function network(a) {
  const total = () => state.catalog.filter((s) => !s.pred).length;
  const summary = () => {
    if (!state.catalog.length) return state.discovering ? 'Asking the relays…' : 'Discover the streams the relays announce.';
    const hits = shownCatalog().length;
    return `${total()} streams (${state.catalog.length - total()} prediction streams hidden) · ${hits} match`
      + (hits > CATALOG_SHOWN ? `, the first ${CATALOG_SHOWN} shown` : '');
  };
  return html`
  <details class="card" data-test="network" @toggle="${(e) => e.target.open && !state.catalog.length && !state.discovering && a.discover()}">
    <summary>Network streams</summary>
    <form class="search" @submit="${(e) => { e.preventDefault(); a.discover(); }}">
      <input name="q" type="search" aria-label="Search streams" placeholder="Search: bitcoin, weather, …" autocomplete="off"
        @input="${(e) => (state.catalogQuery = e.target.value)}">
      <button type="submit" disabled="${() => state.discovering}">${() => (state.discovering ? 'Discovering…' : state.catalog.length ? 'Refresh' : 'Discover')}</button>
    </form>
    <p class="muted small" data-test="catalog-summary">${summary}</p>
    <p class="error small" role="alert" hidden="${() => !state.networkError}">${() => state.networkError}</p>
    <div class="crows">${() => shownCatalog().slice(0, CATALOG_SHOWN).map((s) => catRow(s, a).key(`${s.pubkey}:${s.stream_name}:${s.subscribed}`))}</div>
  </details>`;
}

function settings(a) {
  return html`
  <details class="card settings" @toggle="${(e) => { if (e.target.open) { a.fillRelays(e.target.querySelector('form.relays-form')); a.fillBase(e.target.querySelector('form.base-rpc-form')); } }}">
    <summary>Settings</summary>
    <form class="fields" @submit="${(e) => a.saveCentral(form(e), e.target)}">
      <h3>Central</h3>
      <label>Central URL
        <input name="url" type="url" inputmode="url" autocomplete="off" placeholder="${() => state.centralDefault}">
      </label>
      <p class="muted small">Now: ${() => state.central.url}. Empty: the default, ${() => state.centralDefault}.
        Saving registers there at once.</p>
      <p class="error" role="alert" hidden="${() => !state.settingsError}">${() => state.settingsError}</p>
      <div class="actions"><button class="primary" type="submit">Save</button></div>
    </form>
    <form class="fields relays-form" @submit="${(e) => a.saveRelays(form(e), e.target)}">
      <h3>Nostr</h3>
      <label>Nostr relays (one per line, ws:// or wss://)
        <textarea name="relays" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      </label>
      <label class="check"><input name="centralWrite" type="checkbox"> Publish to central's relays</label>
      <p class="muted small">Central's relays are always read. Unticked, they are read only: the dev server's default,
        so a checkout never writes to the production relay. The relays above are always written to.</p>
      <p class="error" role="alert" hidden="${() => !state.relaysError}">${() => state.relaysError}</p>
      <div class="actions"><button class="primary" type="submit">Save relays</button></div>
    </form>
    <form class="fields base-rpc-form" @submit="${(e) => a.saveBase(form(e), e.target)}">
      <h3>Base</h3>
      <label>Base RPC
        <input name="rpc" autocomplete="off" spellcheck="false" placeholder="the default">
      </label>
      <p class="muted small" title="The default: in a build, central's RPC (sepolia.base.org), then publicnode; on the dev server, /rpc, a local fork of Base Sepolia on 127.0.0.1:8545 (node scripts/fork.mjs start).">
        An https:// URL, or a path on this site. Empty: the default (on the dev server, the local test chain). A saved one replaces it.</p>
      <label>Daily batch: max fee (gwei)
        <input name="maxFee" inputmode="decimal" autocomplete="off" placeholder="2">
      </label>
      <p class="muted small">The identity sends the batch on its own; above this max fee per gas it waits for the next check.
        Base's fees are about 0.01 gwei. Empty: 2 gwei.</p>
      <p class="error" role="alert" hidden="${() => !state.baseRpcError}">${() => state.baseRpcError}</p>
      <div class="actions"><button class="primary" type="submit">Save Base settings</button></div>
    </form>
  </details>`;
}

function backup(a) {
  return html`
  <details class="card">
    <summary>Backup</summary>
    <p class="muted" hidden="${() => state.unlocked}">Unlock the vault to back up your keys.</p>
    <div hidden="${() => !state.unlocked}">
      <p class="muted">Each key is 24 words (or its private key). The files load in a Docker neuron (nostr.yaml is the Nostr key).</p>
      <div class="backup-row">
        <span class="label">Show</span>
        <button class="small-btn" @click="${() => a.showBackup('identity')}">Identity words</button>
        <button class="small-btn" @click="${() => a.showBackup('vault')}">Vault words</button>
      </div>
      <div class="backup-row">
        <span class="label">Docker files</span>
        <button class="small-btn" data-test="download-wallet" @click="${() => a.download('wallet.yaml')}">Download wallet.yaml</button>
        <button class="small-btn" data-test="download-vault" @click="${() => a.download('vault.yaml')}">Download vault.yaml</button>
        <button class="small-btn" data-test="download-nostr" @click="${() => a.download('nostr.yaml')}">Download nostr.yaml</button>
      </div>
      <div class="backup" hidden="${() => !state.backupWords}">
        <h3>${() => (state.backup === 'vault' ? 'Vault' : 'Identity')} words</h3>
        ${wordList(() => state.backupWords.split(' ').filter(Boolean))}
        <div class="label">Private key (WIF)</div>
        <code class="block" data-test="wif">${() => state.backupWif}</code>
        <div class="actions"><button @click="${a.hideBackup}">Hide</button></div>
      </div>
    </div>
  </details>`;
}

function home(a) {
  return html`
  <section hidden="${show('home')}">
    ${keys(a)}
    ${centralCard(a)}
    ${nostrCard(a)}
    ${network(a)}
    ${baseCard(a)}
    ${settings(a)}
    ${backup(a)}
  </section>`;
}

export function render(root, a) {
  watch(() => { document.body.dataset.screen = state.screen; }); // agents: a synchronous readiness signal
  html`
  <header class="top">
    <h1>Satori <span class="muted">neuron</span></h1>
    <button class="small-btn" data-test="lock" hidden="${() => state.screen !== 'home' || !state.unlocked}" @click="${a.lock}">Lock</button>
  </header>
  <main>
    <p class="muted center" hidden="${show('loading')}">Opening…</p>
    <section class="card narrow" hidden="${show('elsewhere')}">
      <h2>Satori is open in another tab</h2>
      <p class="muted">Only one tab can run the neuron. Switch to that tab, or close it and reload this one.</p>
    </section>
    <section class="card narrow" hidden="${show('fatal')}">
      <h2>Satori could not start</h2>
      <p class="error">${() => state.fatal}</p>
    </section>
    ${setup(a)}
    ${home(a)}
  </main>`(root);
}
