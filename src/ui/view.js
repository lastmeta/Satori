// The screens: Setup, Home, "open in another tab". ArrowJS.
// Every screen is built once and shown or hidden, so typing is never lost to a
// re-render. Secrets typed into forms are read on submit, not kept in state.
import { html, reactive } from '@arrow-js/core';
import { fmtNum, fmtWhen, registrationText, mismatchText, pollText, submitText } from './format.js';
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
  central: { url: '', registration: null, lastPoll: null, nextPoll: null, lastSubmit: null, pending: 0 },
  centralDefault: '',
  polling: false,
  streams: [],
  settingsError: '',
});

const show = (screen) => () => state.screen !== screen;
const showStep = (step) => () => state.step !== step;
const form = (e) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.target));
};
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

function keyRow(label, note, which, a) {
  return html`<div class="key">
    <div class="key-main">
      <div class="label">${label}</div>
      <code data-test="${which}">${() => state[which]}</code>
      <div class="muted small">${note}</div>
    </div>
    <button class="small-btn" @click="${() => a.copyAddress(which)}">${() => (state.copied === which ? 'Copied' : 'Copy')}</button>
  </div>`;
}

function keys(a) {
  return html`
  <div class="card keys">
    ${keyRow('Identity', 'Runs the neuron: signs in to central on its own. Unencrypted.', 'identity', a)}
    ${keyRow('Vault', html`<span class="${() => (state.unlocked ? 'badge on' : 'badge')}" data-test="vault-state">${() => (state.unlocked ? 'Unlocked' : 'Locked')}</span> Holds your funds. Encrypted with your passphrase.`, 'vault', a)}
    <form class="unlock" hidden="${() => state.unlocked}" @submit="${(e) => a.unlock(form(e), e.target)}">
      <input name="pass" type="password" aria-label="Vault passphrase" placeholder="Vault passphrase" autocomplete="current-password" required>
      <button class="primary" type="submit" disabled="${() => !!state.busy}">${() => (state.busy === 'unlock' ? 'Unlocking…' : 'Unlock')}</button>
    </form>
    <p class="error small" role="alert" hidden="${() => !state.vaultError}">${() => state.vaultError}</p>
  </div>`;
}

function centralCard(a) {
  const c = () => state.central;
  const fact = (label, test, text) => html`<div class="fact"><dt>${label}</dt><dd data-test="${test}">${text}</dd></div>`;
  return html`
  <section class="card central">
    <header class="card-head">
      <h2>Central</h2>
      <button class="small-btn" @click="${a.pollNow}" disabled="${() => state.polling}">${() => (state.polling ? 'Polling…' : 'Poll now')}</button>
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
  </section>`;
}

function streamRow(r) {
  // One root node, no whitespace around it: ArrowJS 1.0.6 breaks a keyed list
  // of multi-node items once it goes empty and back.
  const sent = r.status === 'sent';
  return html`<div class="srow" data-test="stream"><span class="sname" title="${r.uuid}">${r.name}</span><span class="num" data-label="Latest" data-test="obs">${fmtNum(r.obs_value)}</span><span class="muted small" data-label="Observed">${fmtWhen(r.obs_ts)}</span><span class="num" data-label="t1" data-test="t1">${fmtNum(r.t1)}</span><span class="num accent" data-label="t2" data-test="t2">${fmtNum(r.t2)}</span><span class="${r.status ? (sent ? 'badge on' : 'badge') : 'muted'}" data-test="status">${r.status ? (sent ? 'Sent' : 'Pending') : '–'}</span></div>`;
}

function streams() {
  return html`
  <section class="card">
    <header class="card-head">
      <h2>Streams</h2>
      <span class="muted small">${() => `${state.streams.length} from central`}</span>
    </header>
    <p class="muted" hidden="${() => state.streams.length > 0}">None yet: they arrive with the first poll.</p>
    <div class="srows" hidden="${() => !state.streams.length}">
      <div class="srow head" aria-hidden="true"><span>Stream</span><span class="num">Latest</span><span>Observed</span><span class="num">t1</span><span class="num">t2</span><span></span></div>
      <div>${() => state.streams.map((r) => streamRow(r).key(r.uuid))}</div>
    </div>
  </section>`;
}

function settings(a) {
  return html`
  <details class="card">
    <summary>Settings</summary>
    <form class="fields" @submit="${(e) => a.saveCentral(form(e))}">
      <label>Central URL
        <input name="url" type="url" inputmode="url" autocomplete="off" placeholder="${() => state.centralDefault}" value="${() => (state.central.url === state.centralDefault ? '' : state.central.url)}">
      </label>
      <p class="muted small">Empty: the default, ${() => state.centralDefault}. Saving registers there at once.</p>
      <p class="error" role="alert" hidden="${() => !state.settingsError}">${() => state.settingsError}</p>
      <div class="actions"><button class="primary" type="submit">Save</button></div>
    </form>
  </details>`;
}

function backup(a) {
  return html`
  <details class="card">
    <summary>Backup</summary>
    <p class="muted" hidden="${() => state.unlocked}">Unlock the vault to back up your keys.</p>
    <div hidden="${() => !state.unlocked}">
      <p class="muted">Each key is 24 words (or its private key). The two files load in a Docker neuron.</p>
      <div class="backup-row">
        <span class="label">Show</span>
        <button class="small-btn" @click="${() => a.showBackup('identity')}">Identity words</button>
        <button class="small-btn" @click="${() => a.showBackup('vault')}">Vault words</button>
      </div>
      <div class="backup-row">
        <span class="label">Docker files</span>
        <button class="small-btn" @click="${() => a.download('wallet.yaml')}">Download wallet.yaml</button>
        <button class="small-btn" @click="${() => a.download('vault.yaml')}">Download vault.yaml</button>
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
    ${streams()}
    ${settings(a)}
    ${backup(a)}
  </section>`;
}

export function render(root, a) {
  html`
  <header class="top">
    <h1>Satori <span class="muted">neuron</span></h1>
    <button class="small-btn" hidden="${() => state.screen !== 'home' || !state.unlocked}" @click="${a.lock}">Lock</button>
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
