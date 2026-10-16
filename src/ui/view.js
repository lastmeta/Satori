// The screens: Setup, Home, "open in another tab". ArrowJS.
// Every screen is built once and shown or hidden, so typing is never lost to a
// re-render. Secrets typed into forms are read on submit, not kept in state.
import { html, reactive, watch } from '@arrow-js/core';
import {
  fmtNum, fmtWhen, registrationText, mismatchText, pollText, submitText, modelTitle, modelText, historyText,
  fmtCadence, shortKey, relayText, obsText, rawText, catalogMatch, predText,
  amountText, delegationText, lockText, gasText, batchText, checkText, claimLine, shortHash, rpcText, rpcTitle, storageText, playNote,
} from './format.js';
import { MIN_PASSPHRASE } from '../keys/index.js';
import { SATORI_DAILY_URL } from '../chain/config.js';

export const state = reactive({
  screen: 'loading', // loading | elsewhere | fatal | setup | finish (an earlier version's vault: Unlock once) | home
  fatal: '',
  busy: '', // what is running: '' | 'setup' | 'unlock'
  error: '',
  // setup
  step: 'choose', // choose | words | confirm | restore | docker | passphrase
  words: [],
  confirmAt: [],
  passNote: '', // the passphrase step's note (an import whose password can't be reused)
  // home
  identity: '', // the identity's Base address
  vault: '', // the vault's Base address (shown while locked)
  unlocked: false,
  vaultError: '',
  backup: '', // '' | 'identity' | 'vault' | 'nostr': which key's backup is shown
  backupWords: '', // identity, vault: the 24 words
  backupKey: '', // identity, vault: the private key (0x hex); nostr: the nsec
  backupHex: '', // nostr: the secret (hex)
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
  // the installed app (docs/design/pwa.md): status().app, Safari (no install prompt), status().storage
  app: { installed: false, canInstall: false, update: false },
  safari: false,
  storage: null, // { persisted, usage, quota }
  // the database (docs/design/storage.md#recovery): the name a WAL DuckDB could not replay was set aside under
  recovered: null,
  noticeDismissed: false,
});

export const RECOVERED_NOTICE = 'Recovered the database: unsaved changes from the last session were set aside.';

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
const SAFARI_ADD = 'To keep your keys, add Satori to the Dock (File › Add to Dock) or Home Screen (Share › Add to Home Screen). '
  + 'The added app starts empty: set it up there, or restore it from your 24 words.';

/** Install Satori (Chromium's prompt), or Safari's way to add it; hidden once installed (docs/design/pwa.md). */
const install = (a) => html`<div class="install" hidden="${() => state.app.installed || !(state.app.canInstall || state.safari)}">
  <button class="small-btn primary" data-test="install" hidden="${() => !state.app.canInstall}" @click="${a.install}">Install Satori</button>
  <span class="muted small" data-test="install-hint">${() => (state.app.canInstall ? 'Keeps your keys, and runs in its own window.' : state.safari ? SAFARI_ADD : '')}</span>
</div>`;

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
        <button @click="${() => a.goStep('docker')}">Import Dockerized Neuron files</button>
      </div>
      ${install(a)}
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
      <label>Nostr key (nsec or hex, optional: a new one is made if empty)
        <input name="nostr" autocomplete="off" autocapitalize="off" spellcheck="false">
      </label>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit">Continue</button>
        <button type="button" @click="${() => a.goStep('choose')}">Back</button>
      </div>
    </form>

    <form hidden="${showStep('docker')}" @submit="${(e) => { e.preventDefault(); a.importDocker(e.target); }}">
      <h2>Import Dockerized Neuron files</h2>
      <p class="muted">The files from a Dockerized Neuron’s wallet folder (unzip “Download Wallet” first). Their keys
        are read here and stored in this app’s own way; the files themselves are not kept.</p>
      <label>wallet.yaml (identity) <input name="wallet" type="file" accept=".yaml,.yml" required></label>
      <label>vault.yaml <input name="vault" type="file" accept=".yaml,.yml" required></label>
      <label>nostr.yaml (optional: a new Nostr key is made if empty) <input name="nostr" type="file" accept=".yaml,.yml"></label>
      <label>Vault password (the Dockerized Neuron’s) <input name="pass" type="password" autocomplete="current-password" required></label>
      <label class="check"><input name="reuse" type="checkbox" checked> Use it as this app’s passphrase too (if it has at least ${MIN_PASSPHRASE} characters)</label>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit" disabled="${() => !!state.busy}">${() => (state.busy ? 'Importing…' : 'Import')}</button>
        <button type="button" @click="${() => a.goStep('choose')}">Back</button>
      </div>
    </form>

    <form hidden="${showStep('passphrase')}" @submit="${(e) => a.createKeys(form(e), e.target)}">
      <h2>Choose a passphrase</h2>
      <p class="muted" data-test="pass-note" hidden="${() => !state.passNote}">${() => state.passNote}</p>
      <p class="muted">It encrypts the vault in this browser. At least ${MIN_PASSPHRASE} characters, in any
        language or script; a longer phrase is stronger.</p>
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

/** The three keys: the identity's and the vault's Base addresses, the Nostr pubkey. */
function keys(a) {
  return html`
  <div class="card keys">
    <div class="key">
      <h3>Identity</h3>
      ${idRow('Address', 'identity', () => state.identity, a)}
      <p class="muted small">Runs the neuron on its own: signs in to central and sends the daily Base batch. Unencrypted.</p>
    </div>
    <div class="key">
      <h3>Vault <span class="${() => (state.unlocked ? 'badge on' : 'badge')}" data-test="vault-state">${() => (state.unlocked ? 'Unlocked' : 'Locked')}</span></h3>
      ${idRow('Address', 'vault', () => state.vault, a)}
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
    <div class="key">
      <p class="${() => (state.storage?.persisted ? 'small muted' : 'small')}" data-test="storage">${() => storageText(state.storage)}</p>
      ${install(a)}
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
      ${fact('History', 'history', () => historyText(c().history))}
    </dl>
    <p class="error small" role="status" data-test="mismatch" hidden="${() => !mismatchText(c().registration)}">${() => mismatchText(c().registration)}</p>
    ${streams()}
  </section>`;
}

function streamRow(r, names) {
  // One root node, no whitespace around it: ArrowJS 1.0.6 breaks a keyed list
  // of multi-node items once it goes empty and back.
  const sent = r.status === 'sent';
  return html`<div class="row srow" data-test="stream"><span class="sname" title="${r.uuid}">${r.name}</span><span class="num" data-label="Latest" data-test="obs">${fmtNum(r.obs_value)}</span><span class="muted small" data-label="Observed">${fmtWhen(r.obs_ts)}</span><span class="num" data-label="t1" data-test="t1">${fmtNum(r.t1)}</span><span class="num accent" data-label="t2" data-test="t2">${fmtNum(r.t2)}</span><span class="model" data-label="Model" data-test="model" title="${modelTitle(r, names)}">${modelText(r, names)}</span><span class="${r.status ? (sent ? 'badge on' : 'badge') : 'muted'}" data-test="status">${r.status ? (sent ? 'Sent' : 'Pending') : '–'}</span></div>`;
}

/** Central's streams with our t1 and t2: collapsed in the Central card (central2 has ~80). */
function streams() {
  return html`
    <p class="muted small streams-none" hidden="${() => state.streams.length > 0}">Streams: none yet. They arrive with the first poll.</p>
    <details class="streams" data-test="streams" hidden="${() => !state.streams.length}">
      <summary>${() => `Streams: ${state.streams.length} from central, with our forecasts`}</summary>
      <div class="srows">
        <div class="row srow head" aria-hidden="true"><span>Stream</span><span class="num">Latest</span><span>Observed</span><span class="num">t1</span><span class="num">t2</span><span>Model</span><span></span></div>
        <div>${() => {
          const names = new Map(state.streams.map((r) => [r.uuid, r.name]));
          return state.streams.map((r) => streamRow(r, names).key(r.uuid));
        }}</div>
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

function baseCard(a) {
  const b = () => state.base;
  const delegated = () => b().vault.delegated === 'identity';
  const notDelegated = () => b().vault.delegated === 'none';
  const lowEth = () => b().identity.lowEth && delegated(); // gas matters once the identity has a batch to send
  const busy = () => !!state.baseBusy;
  const play = () => playNote(b().vault.delegated);
  return html`
  <section class="card base">
    <header class="card-head">
      <h2>Base</h2>
      <button class="small-btn" data-test="base-refresh" @click="${a.baseRefresh}" disabled="${busy}">${() => (state.baseBusy === 'refresh' ? 'Reading…' : 'Refresh')}</button>
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
    <p class="muted small" data-test="base-play" hidden="${() => !play()}">${() => play()?.[0] ?? ''}<a href="${SATORI_DAILY_URL}" target="_blank" rel="noopener">Satori Daily</a>${() => play()?.[1] ?? ''}</p>
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
    <div class="txs" data-test="base-txs" hidden="${() => !state.baseTxs.length}">${() => state.baseTxs.map((t) => txLink(t.hash, t.label, t.title).key(t.hash))}</div>
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
      <p class="muted">The identity and the vault are 24 words each; Restore from words brings them back. The Nostr
        key is random, not from the words, so it is backed up on its own.</p>
      <div class="backup-row">
        <span class="label">Show</span>
        <button class="small-btn" @click="${() => a.showBackup('identity')}">Identity words</button>
        <button class="small-btn" @click="${() => a.showBackup('vault')}">Vault words</button>
        <button class="small-btn" @click="${() => a.showBackup('nostr')}">Nostr key</button>
      </div>
      <div class="backup" hidden="${() => !state.backup}">
        <div hidden="${() => state.backup === 'nostr'}">
          <h3>${() => (state.backup === 'vault' ? 'Vault' : 'Identity')} words</h3>
          ${wordList(() => state.backupWords.split(' ').filter(Boolean))}
          <div class="label">Private key (imports into a Base wallet)</div>
        </div>
        <div hidden="${() => state.backup !== 'nostr'}">
          <h3>Nostr key</h3>
          <div class="label">nsec</div>
        </div>
        <code class="block" data-test="backup-key">${() => state.backupKey}</code>
        <div hidden="${() => !state.backupHex}">
          <div class="label">Secret (hex)</div>
          <code class="block" data-test="backup-hex">${() => state.backupHex}</code>
        </div>
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
    <div class="top-actions">
      <button class="small-btn" data-test="update" hidden="${() => !state.app.update}" @click="${a.update}">Update ready, reload</button>
      <button class="small-btn" data-test="lock" hidden="${() => state.screen !== 'home' || !state.unlocked}" @click="${a.lock}">Lock</button>
    </div>
  </header>
  <main>
    <div class="notice small" role="status" data-test="notice" hidden="${() => !state.recovered || state.noticeDismissed}">
      <span title="${() => `Kept in this site's storage as ${state.recovered}`}">${RECOVERED_NOTICE}</span>
      <button class="small-btn" @click="${a.dismissNotice}">Dismiss</button>
    </div>
    <p class="muted center" hidden="${show('loading')}">Opening…</p>
    <section class="card narrow" hidden="${show('elsewhere')}">
      <h2>Satori is open in another tab</h2>
      <p class="muted">Only one tab can run the neuron. Switch to that tab, or close it and reload this one.</p>
    </section>
    <section class="card narrow" hidden="${show('fatal')}">
      <h2>Satori could not start</h2>
      <p class="error" data-test="fatal">${() => state.fatal}</p>
      <p class="muted small">Nothing was deleted: your keys and data stay in this browser’s storage for this site.
        Reload to try again. If it keeps failing, report this message at
        <a href="https://github.com/lastmeta/Satori/issues" target="_blank" rel="noopener">github.com/lastmeta/Satori/issues</a>.
        Meanwhile your 24 words (or the Dockerized Neuron files) can set the neuron up in another browser.</p>
      <div class="actions"><button class="primary" @click="${() => location.reload()}">Reload</button></div>
    </section>
    <section class="card narrow" hidden="${show('finish')}">
      <h2>Unlock to finish the update</h2>
      <p class="muted">An earlier version stored this vault with its public key encrypted, so its address can’t
        be shown until it is opened once. Enter its passphrase: the vault is then stored in this app’s own format,
        and the neuron starts.</p>
      <form class="unlock" @submit="${(e) => a.finishUpdate(form(e), e.target)}">
        <input name="pass" type="password" aria-label="Vault passphrase to finish the update" placeholder="Vault passphrase" autocomplete="current-password" required>
        <button class="primary" type="submit" data-test="finish" disabled="${() => !!state.busy}">${() => (state.busy === 'unlock' ? 'Unlocking…' : 'Unlock')}</button>
      </form>
      <p class="error small" role="alert" hidden="${() => !state.vaultError}">${() => state.vaultError}</p>
    </section>
    ${setup(a)}
    ${home(a)}
  </main>`(root);
}
