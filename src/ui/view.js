// The shell: the header, the tabs (Home · Models · Streams · Wallet · Settings: a tab bar on a phone, a top nav on a
// computer; hash routes #home … #settings, #models/<id>), and the screens before Home: Setup, "Unlock to finish the update",
// "open in another tab", "could not start", "the database can't be opened". ArrowJS. Every screen and tab is built once and shown or hidden, so
// typing is never lost to a re-render. Secrets typed into forms are read on submit, not kept in state.
import { html, watch } from '@arrow-js/core';
import { MIN_PASSPHRASE } from '../keys/index.js';
import { state } from './state.js';
import { form, wordList } from './parts.js';
import { lockInText, engineText, openingText } from './format.js';
import { home } from './home.js';
import { streamsTab } from './streams.js';
import { modelsTab, watchModelWidth } from './models.js';
import { walletTab } from './wallet.js';
import { settingsTab, install, RUNS_WHILE_OPEN } from './settings.js';

export { state };
export { CATALOG_SHOWN } from './streams.js';
export const TABS = ['home', 'models', 'streams', 'wallet', 'settings'];
const LABEL = { home: 'Home', models: 'Models', streams: 'Streams', wallet: 'Wallet', settings: 'Settings' };
const ICON = {
  home: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"></path></svg>`,
  // streams in, one model, a forecast out: the pipeline
  models: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 6h4.5l4 4.5M2 18h4.5l4-4.5M2 12h7.5"></path><rect x="10.5" y="8" width="6" height="8" rx="1.5"></rect><path d="M16.5 12H22M19.5 9l2.5 3-2.5 3"></path></svg>`,
  streams: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17l5-6 4 4 8-9"></path></svg>`,
  wallet: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"></rect><path d="M16 12h2"></path></svg>`,
  settings: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"></path></svg>`,
};

export const RECOVERED_NOTICE = 'Recovered the database: unsaved changes from the last session were set aside.';

const show = (screen) => () => state.screen !== screen;
const showStep = (step) => () => state.step !== step;
const errorLine = () => html`<p class="error" role="alert" hidden="${() => !state.error}">${() => state.error}</p>`;
const current = (t) => () => (state.tab === t ? 'page' : false);
const goTo = (a, t) => (e) => {
  e.preventDefault();
  a.go(t);
};
const navLink = (a, t) => html`<a href="${`#${t}`}" data-test="${`nav-${t}`}" aria-current="${current(t)}" @click="${goTo(a, t)}">${LABEL[t]}</a>`;
const barLink = (a, t) => html`<a href="${`#${t}`}" data-test="${`tab-${t}`}" aria-current="${current(t)}" @click="${goTo(a, t)}">${ICON[t]()}<span>${LABEL[t]}</span></a>`;

function setup(a) {
  return html`
  <section class="card narrow setup" hidden="${show('setup')}">
    <div hidden="${showStep('choose')}">
      <h2>Set up Satori</h2>
      <p class="muted">Satori has two keys. The <strong>identity</strong> runs the app on its own,
        so it stays unencrypted in this browser. The <strong>vault</strong> holds your funds and is
        encrypted with your passphrase.</p>
      <p class="muted" data-test="runs-while-open">${RUNS_WHILE_OPEN}</p>
      <div class="actions">
        <button class="primary" @click="${a.newWords}">Create a wallet</button>
        <button @click="${() => a.goStep('restore')}">Restore from words</button>
        <button @click="${() => a.goStep('docker')}">Import Docker files</button>
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
      <h2>Import Docker files</h2>
      <p class="muted">The files from a Docker install’s wallet folder (unzip “Download Wallet” first). Their keys
        are read here and stored in this app’s own way; the files themselves are not kept.</p>
      <label>wallet.yaml (identity) <input name="wallet" type="file" accept=".yaml,.yml" required></label>
      <label>vault.yaml <input name="vault" type="file" accept=".yaml,.yml" required></label>
      <label>nostr.yaml (optional: a new Nostr key is made if empty) <input name="nostr" type="file" accept=".yaml,.yml"></label>
      <label>Vault password (the Docker install’s) <input name="pass" type="password" autocomplete="current-password" required></label>
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
    <p class="small setup-wait" role="status" data-test="setup-wait" hidden="${() => !state.setupWaiting}"><progress max="${() => (state.engine?.step === 'download' && state.engine.total) || false}" value="${() => (state.engine?.step === 'download' && state.engine.total ? state.engine.loaded : false)}"></progress><span>${() => `Finishing setup… ${state.engine?.step === 'ready' ? 'saving your keys…' : engineText(state.engine) || 'downloading the engine…'}`}</span></p>
  </section>`;
}

export function render(root, a) {
  watch(() => { document.body.dataset.screen = state.screen; }); // agents: a synchronous readiness signal
  watch(() => { document.body.dataset.tab = state.tab; });
  const running = () => state.screen !== 'home';
  html`
  <header class="top">
    <h1>Satori <span class="muted">app</span></h1>
    <nav class="topnav" aria-label="Sections" hidden="${running}">${TABS.map((t) => navLink(a, t))}</nav>
    <div class="top-actions">
      <button class="small-btn" data-test="update" hidden="${() => !state.app.update}" @click="${a.update}">Update ready, reload</button>
      <span class="muted small lock-in" data-test="lock-in" hidden="${() => state.screen !== 'home' || !state.unlocked}">${() => lockInText(state.lockAt, state.lockNow)}</span>
      <button class="small-btn" data-test="lock" hidden="${() => state.screen !== 'home' || !state.unlocked}" @click="${a.lock}">Lock</button>
      <button class="small-btn" data-test="share" hidden="${() => state.screen !== 'home' || !state.base.inviteLink}" @click="${a.share}">${() => (state.copied === 'share' ? 'Link copied' : 'Share')}</button>
    </div>
  </header>
  <main>
    <div class="notice small" role="status" data-test="notice" hidden="${() => !state.recovered || state.noticeDismissed}">
      <span title="${() => `Kept in this site's storage as ${state.recovered}`}">${RECOVERED_NOTICE}</span>
      <button class="small-btn" @click="${a.dismissNotice}">Dismiss</button>
    </div>
    <div class="notice small" role="status" data-test="set-aside-notice" hidden="${() => !state.setAside || state.screen !== 'setup'}">
      <span>${() => `The old database was set aside as ${state.setAside}, in this site's storage. Restore from your words, or import its files.`}</span>
    </div>
    <p class="muted center" data-test="opening" hidden="${() => state.screen !== 'loading' || !!state.cached}">${() => openingText(state.engine)}</p>
    <section class="card narrow" hidden="${show('elsewhere')}">
      <h2>Satori is open in another tab</h2>
      <p class="muted">Only one tab can run the app. Switch to that tab, or close it.</p>
      <p class="muted">This tab takes over when that one closes.</p>
    </section>
    <section class="card narrow" hidden="${show('fatal')}">
      <h2>Satori could not start</h2>
      <p class="error" data-test="fatal">${() => state.fatal}</p>
      <p class="muted small">Nothing was deleted: your keys and data stay in this browser’s storage for this site.
        Reload to try again. If it keeps failing, report this message at
        <a href="https://github.com/lastmeta/Satori/issues" target="_blank" rel="noopener">github.com/lastmeta/Satori/issues</a>.
        Meanwhile your 24 words (or the Docker files) can set the app up in another browser.</p>
      <div class="actions"><button class="primary" @click="${() => location.reload()}">Reload</button></div>
    </section>
    <section class="card narrow" hidden="${show('damaged')}">
      <h2>Satori's database can't be opened</h2>
      <p class="error" data-test="damaged-error">${() => state.fatal}</p>
      <p class="muted small">It may be damaged. You can set it aside and start again: the file is kept in this browser's
        storage for this site under another name, never deleted. Your keys are in it too, so you then restore
        from your vault's 24 words (and the identity's, and the Nostr key from Backup), or import the Docker files.
        Reload first if you want to try again.</p>
      <div class="actions">
        <button class="primary" data-test="set-aside" disabled="${() => state.busy === 'setAside'}" @click="${a.setAside}">${() => (state.busy === 'setAside' ? 'Setting aside…' : 'Set aside and start again')}</button>
        <button @click="${() => location.reload()}">Reload</button>
      </div>
      <p class="error small" role="alert" hidden="${() => !state.setAsideError}">${() => state.setAsideError}</p>
    </section>
    <section class="card narrow" hidden="${show('finish')}">
      <h2>Unlock to finish the update</h2>
      <p class="muted">An earlier version stored this vault with its public key encrypted, so its address can’t
        be shown until it is opened once. Enter its passphrase: the vault is then stored in this app’s own format,
        and the app starts.</p>
      <form class="unlock" @submit="${(e) => a.finishUpdate(form(e), e.target)}">
        <input name="pass" type="password" aria-label="Vault passphrase to finish the update" placeholder="Vault passphrase" autocomplete="current-password" required>
        <button class="primary" type="submit" data-test="finish" disabled="${() => !!state.busy}">${() => (state.busy === 'unlock' ? 'Unlocking…' : 'Unlock')}</button>
      </form>
      <p class="error small" role="alert" hidden="${() => !state.vaultError}">${() => state.vaultError}</p>
    </section>
    ${setup(a)}
    <div hidden="${() => state.screen !== 'home' && !(state.screen === 'loading' && state.cached)}">
      ${home(a)}
      ${modelsTab(a)}
      ${streamsTab(a)}
      ${walletTab(a)}
      ${settingsTab(a)}
    </div>
  </main>
  <nav class="tabbar" aria-label="Sections" hidden="${running}">${TABS.map((t) => barLink(a, t))}</nav>`(root);
  watchModelWidth(root);
  // The activity feed is open on a computer, a tap away on a phone.
  const wide = matchMedia('(min-width: 1024px)');
  const feed = root.querySelector('[data-test=activity]');
  feed.open = wide.matches;
  wide.addEventListener('change', (e) => { if (e.matches) feed.open = true; });
}
