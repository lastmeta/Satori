// The shell: the header, the tabs (Game · Home · Models · Streams · Market · Wallet · Settings: on a phone a bar of Game, Home
// and Menu holding the rest; on a computer a top nav; hash routes #game … #settings, #models/<id>), and the screens before Home: Setup, "Unlock to finish the update",
// "open in another tab", "could not start", "the database can't be opened". ArrowJS. Every screen and tab is built once and shown or hidden, so
// typing is never lost to a re-render. Secrets typed into forms are read on submit, not kept in state.
import { html, watch } from '@arrow-js/core';
import { MIN_PASSPHRASE } from '../keys/index.js';
import { state } from './state.js';
import { form, wordList } from './parts.js';
import { lockInText, engineText, openingText, shortHash } from './format.js';
import { home } from './home.js';
import { gameTab } from './game.js';
import { streamsTab } from './streams.js';
import { modelsTab, watchModelWidth } from './models.js';
import { walletTab } from './wallet.js';
import { marketTab } from './market.js';
import { settingsTab, install, RUNS_WHILE_OPEN } from './settings.js';

export { state };
export { CATALOG_SHOWN } from './streams.js';
export const TABS = ['game', 'home', 'streams', 'models', 'market', 'wallet', 'settings'];
const BAR = ['game', 'home']; // the phone's bar, then Menu (☰) with the rest: Home in the middle
const MENU = TABS.filter((t) => !BAR.includes(t));
const LABEL = { game: 'Game', market: 'Market', home: 'Home', models: 'Models', streams: 'Streams', wallet: 'Wallet', settings: 'Settings' };
const ICON = {
  // a game controller's outline
  game: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10a5 5 0 0 1 4.9 6l-.6 3a2.5 2.5 0 0 1-4.3 1.2L15 15H9l-2 2.2A2.5 2.5 0 0 1 2.7 16l-.6-3A5 5 0 0 1 7 7z"></path></svg>`,
  home: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"></path></svg>`,
  // three streams in, one model, a forecast out
  models: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8h6M2 12h6M2 16h6"></path><rect x="8" y="5" width="8" height="14" rx="1.5"></rect><path d="M16 12h6"></path></svg>`,
  streams: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17l5-6 4 4 8-9"></path></svg>`,
  // a shop: its awning over a counter
  market: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9l1.5-5h13L20 9M4 9h16M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5.5 11.5V20h13v-8.5M10 20v-5h4v5"></path></svg>`,
  wallet: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"></rect><path d="M16 12h2"></path></svg>`,
  // a gear (three lines is the menu's)
  settings: () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"></path><circle cx="12" cy="12" r="6.5"></circle></svg>`,
};
const MENU_ICON = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>`;
// the header's icons: share (one dot joined to two), and the theme: the sun in dark mode (to light), the moon in light
const SHARE = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="2.6"></circle><circle cx="18" cy="5.5" r="2.6"></circle><circle cx="18" cy="18.5" r="2.6"></circle><path d="M8.3 10.8l7.4-4.1M8.3 13.2l7.4 4.1"></path></svg>`;
const SUN = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>`;
// the moon drawn to its box's right side, as the sun's rays reach: its edge lines up with the page's
const MOON = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 14.5A8 8 0 1 1 11.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path></svg>`;
const isDark = () => state.theme === 'dark' || (state.theme === 'system' && state.systemDark);

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
const menuLink = (a, t) => html`<a href="${`#${t}`}" role="menuitem" data-test="${`tab-${t}`}" aria-current="${current(t)}" @click="${(e) => { state.menuOpen = false; goTo(a, t)(e); }}">${ICON[t]()}<span>${LABEL[t]}</span></a>`;
/** The phone's menu (☰ Menu, the bar's third button): Models, Streams, Market, Wallet, Settings, listed above it. */
const tabMenu = (a) => html`<div class="tabmenu">
    <button class="menu-btn" data-test="tab-menu" aria-haspopup="menu" aria-expanded="${() => String(!!state.menuOpen)}" data-current="${() => MENU.includes(state.tab)}" @click="${() => { state.menuOpen = !state.menuOpen; }}">${MENU_ICON()}<span>Menu</span></button>
    <div class="menu-list" role="menu" data-test="tab-menu-list" hidden="${() => !state.menuOpen}">${MENU.map((t) => menuLink(a, t))}</div>
  </div>`;

/** Setup's way back (docs/design/wallets.md#several-wallets): the app's other wallets that were set up. */
const otherWallets = () => state.wallets.wallets.filter((w) => !w.active && w.address);

function setup(a) {
  return html`
  <section class="card narrow setup" hidden="${show('setup')}">
    <div hidden="${showStep('choose')}">
      <h2>Set up Satori</h2>
      <p class="muted">Your <strong>wallet</strong> holds your funds: here, encrypted with your passphrase, or in your
        own wallet app (MetaMask or another), connected. The app signs its own work with a key it keeps for itself, so it
        runs on its own.</p>
      <p class="muted" data-test="runs-while-open">${RUNS_WHILE_OPEN}</p>
      <div class="actions">
        <button class="primary" @click="${a.newWords}">Create a wallet</button>
        <button @click="${() => a.goStep('restore')}">Import</button>
        <button @click="${() => a.goStep('docker')}">Import Docker files</button>
        <button data-test="connect-wallet" @click="${a.lookForWallets}">Connect a wallet</button>
      </div>
      <div class="other-wallets" data-test="other-wallets" hidden="${() => !otherWallets().length}">
        <p class="muted small">Or go back to a wallet already in this app:</p>
        <div class="actions">${() => otherWallets().map((w) => html`<button class="small-btn" data-test="wallet-back" @click="${() => a.switchWallet(w.id)}">${shortHash(w.address)}</button>`.key(`${w.id}:${w.address}`))}</div>
      </div>
      ${install(a)}
    </div>

    <div hidden="${showStep('words')}">
      <h2>Your wallet’s 24 words</h2>
      <p class="muted">Write them down in order and keep them safe. They are the only way to recover
        your wallet if this browser loses its data.</p>
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
      <h2>Import a wallet</h2>
      <label>Wallet: its 24 words or its private key
        <textarea name="wallet" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea>
      </label>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit">Continue</button>
        <button type="button" @click="${() => a.goStep('choose')}">Back</button>
      </div>
    </form>

    <div hidden="${showStep('connect')}" data-test="connect-step">
      <h2>Connect a wallet</h2>
      <p class="muted">Your wallet stays in your wallet app. It asks you each time the wallet is needed: to stake, claim
        or send. The app predicts on its own meanwhile.</p>
      <p class="muted" hidden="${() => state.connectFound !== null}">Looking for wallets in this browser…</p>
      <div data-test="relay-choices" hidden="${() => state.connectFound?.length !== 0}">
        <p class="muted small">No wallet in this browser: connect your wallet app instead.</p>
        <div class="actions connect-choices">
          <button class="primary choice" data-test="connect-to" data-rdns="metamask-connect" disabled="${() => !!state.connecting}" @click="${() => a.connect('metamask-connect')}"><span>MetaMask</span><span class="small">Opens the app to approve</span></button>
          <button class="choice" data-test="connect-to" data-rdns="walletconnect" hidden="${() => !state.walletConnectReady}" disabled="${() => !!state.connecting}" @click="${() => a.connect('walletconnect')}"><span>Other wallet</span><span class="small">Rainbow, Trust, Coinbase, …</span></button>
        </div>
      </div>
      <div class="actions">${() => (state.connectFound ?? []).map((w) => html`<button class="primary" data-test="connect-to" data-rdns="${w.rdns}" disabled="${() => !!state.connecting}" @click="${() => a.connect(w.rdns)}">${`Connect ${w.name}`}</button>`.key(w.rdns))}</div>
      <p class="muted small" hidden="${() => !state.connecting}">${() => `Waiting for ${state.connecting}: approve the account, then three signatures (twice for this app's keys, once for the link).`}</p>
      ${errorLine()}
      <div class="actions"><button type="button" @click="${() => a.goStep('choose')}">Back</button></div>
    </div>

    <form hidden="${showStep('docker')}" @submit="${(e) => { e.preventDefault(); a.importDocker(e.target); }}">
      <h2>Import Docker files</h2>
      <p class="muted">The wallet file from a Docker install’s wallet folder (unzip “Download Wallet” first). Its key
        is read here and stored in this app’s own way; the file itself is not kept.</p>
      <label>Wallet file: wallet.yaml (vault.yaml in an older install) <input name="wallet" type="file" accept=".yaml,.yml" required></label>
      <label>Wallet password (the Docker install’s) <input name="pass" type="password" autocomplete="current-password" required></label>
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
      <p class="muted">It encrypts the wallet in this browser. At least ${MIN_PASSPHRASE} characters, in any
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
    <h1><a class="brand" href="#home" data-test="brand" @click="${(e) => { e.preventDefault(); if (state.screen === 'home') a.go('home'); }}"><span class="brand-mark" aria-hidden="true"></span>Satori <span class="muted">app</span></a></h1>
    <nav class="topnav" aria-label="Sections" hidden="${running}">${TABS.map((t) => navLink(a, t))}</nav>
    <div class="top-actions">
      <button class="small-btn" data-test="update" hidden="${() => !state.app.update}" @click="${a.update}">Update ready, reload</button>
      <span class="muted small lock-in" data-test="lock-in" hidden="${() => state.screen !== 'home' || !state.unlocked}">${() => lockInText(state.lockAt, state.lockNow)}</span>
      <button class="small-btn" data-test="lock" hidden="${() => state.screen !== 'home' || !state.unlocked}" @click="${a.lock}">Lock</button>
      <button class="small-btn icon-btn bare" data-test="share" aria-label="Share" title="Share your invite link" hidden="${() => state.screen !== 'home' || !state.base.inviteLink}" @click="${a.share}">${() => (state.copied === 'share' ? 'Link copied' : SHARE())}</button>
      <button class="small-btn icon-btn bare" data-test="theme-toggle" aria-label="${() => (isDark() ? 'Light mode' : 'Dark mode')}" title="${() => (isDark() ? 'Light mode' : 'Dark mode')}" @click="${() => a.setTheme(isDark() ? 'light' : 'dark')}">${() => (isDark() ? SUN() : MOON())}</button>
    </div>
  </header>
  <main>
    <div class="notice small" role="status" data-test="notice" hidden="${() => !state.recovered || state.noticeDismissed}">
      <span title="${() => `Kept in this site's storage as ${state.recovered}`}">${RECOVERED_NOTICE}</span>
      <button class="small-btn" @click="${a.dismissNotice}">Dismiss</button>
    </div>
    <div class="notice small" role="status" data-test="set-aside-notice" hidden="${() => !state.setAside || state.screen !== 'setup'}">
      <span>${() => `The old database was set aside as ${state.setAside}, in this site's storage. Import your wallet again, or import its Docker files.`}</span>
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
        storage for this site under another name, never deleted. Your keys are in it too, so you then import
        your wallet again from its 24 words or private key (and the Nostr key from Backup), or import the Docker files.
        Reload first if you want to try again.</p>
      <div class="actions">
        <button class="primary" data-test="set-aside" disabled="${() => state.busy === 'setAside'}" @click="${a.setAside}">${() => (state.busy === 'setAside' ? 'Setting aside…' : 'Set aside and start again')}</button>
        <button @click="${() => location.reload()}">Reload</button>
      </div>
      <p class="error small" role="alert" hidden="${() => !state.setAsideError}">${() => state.setAsideError}</p>
    </section>
    <section class="card narrow" hidden="${show('finish')}">
      <h2>Unlock to finish the update</h2>
      <p class="muted">An earlier version stored this wallet with its public key encrypted, so its address can’t
        be shown until it is opened once. Enter its passphrase: the wallet is then stored in this app’s own format,
        and the app starts.</p>
      <form class="unlock" @submit="${(e) => a.finishUpdate(form(e), e.target)}">
        <input name="pass" type="password" aria-label="Wallet passphrase to finish the update" placeholder="Wallet passphrase" autocomplete="current-password" required>
        <button class="primary" type="submit" data-test="finish" disabled="${() => !!state.busy}">${() => (state.busy === 'unlock' ? 'Unlocking…' : 'Unlock')}</button>
      </form>
      <p class="error small" role="alert" hidden="${() => !state.walletError}">${() => state.walletError}</p>
    </section>
    ${setup(a)}
    <div hidden="${() => state.screen !== 'home' && !(state.screen === 'loading' && state.cached)}">
      ${gameTab(a)}
      ${home(a)}
      ${modelsTab(a)}
      ${streamsTab(a)}
      ${marketTab(a)}
      ${walletTab(a)}
      ${settingsTab(a)}
    </div>
  </main>
  <nav class="tabbar" aria-label="Sections" hidden="${running}">${BAR.map((t) => barLink(a, t))}${tabMenu(a)}</nav>`(root);
  // the menu closes on a tap outside it, or Escape
  addEventListener('click', (e) => { if (state.menuOpen && !e.target.closest?.('.tabmenu')) state.menuOpen = false; });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') state.menuOpen = false; });
  watchModelWidth(root);
  // The activity feed is open on a computer, a tap away on a phone.
  const wide = matchMedia('(min-width: 1024px)');
  const feed = root.querySelector('[data-test=activity]');
  feed.open = wide.matches;
  wide.addEventListener('change', (e) => { if (e.matches) feed.open = true; });
}
