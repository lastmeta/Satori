// The screens: Setup, Unlock, Home, "open in another tab". ArrowJS.
// Every screen is built once and shown or hidden, so typing is never lost to a
// re-render. Secrets typed into forms are read on submit, not kept in state.
import { html, reactive } from '@arrow-js/core';
import { fmtNum, fmtTime, sparkPoints } from './format.js';

export const state = reactive({
  screen: 'loading', // loading | elsewhere | fatal | setup | unlock | home
  fatal: '',
  busy: false,
  error: '',
  // setup
  step: 'choose', // choose | words | confirm | import | passphrase
  words: [],
  confirmAt: [],
  // home
  address: '',
  rows: [],
  spark: {},
  backupWords: '',
  formError: '',
  copied: false,
});

const show = (screen) => () => state.screen !== screen;
const showStep = (step) => () => state.step !== step;
const form = (e) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.target));
};
const errorLine = () => html`<p class="error" role="alert" hidden="${() => !state.error}">${() => state.error}</p>`;

function setup(a) {
  return html`
  <section class="card" hidden="${show('setup')}">
    <div hidden="${showStep('choose')}">
      <h2>Set up this neuron</h2>
      <p class="muted">Your key is 24 words. They stay in this browser, sealed with a passphrase.</p>
      <div class="actions">
        <button class="primary" @click="${a.newWords}">Create a new key</button>
        <button @click="${() => a.goStep('import')}">I have 24 words</button>
      </div>
    </div>

    <div hidden="${showStep('words')}">
      <h2>Your 24 words</h2>
      <p class="muted">Write them down in order and keep them safe. They are the only way to recover this key.</p>
      <ol class="words">${() => state.words.map((w) => html`<li>${w}</li>`)}</ol>
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

    <form hidden="${showStep('import')}" @submit="${(e) => a.importWords(form(e), e.target)}">
      <h2>Import your 24 words</h2>
      <label>Words
        <textarea name="words" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea>
      </label>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit">Continue</button>
        <button type="button" @click="${() => a.goStep('choose')}">Back</button>
      </div>
    </form>

    <form hidden="${showStep('passphrase')}" @submit="${(e) => a.createVault(form(e), e.target)}">
      <h2>Choose a passphrase</h2>
      <p class="muted">It unlocks the key in this browser. At least 8 characters.</p>
      <label>Passphrase <input name="pass1" type="password" autocomplete="new-password" minlength="8" required></label>
      <label>Repeat passphrase <input name="pass2" type="password" autocomplete="new-password" minlength="8" required></label>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit" disabled="${() => state.busy}">${() => (state.busy ? 'Sealing…' : 'Save and unlock')}</button>
      </div>
    </form>
  </section>`;
}

function unlockScreen(a) {
  return html`
  <section class="card narrow" hidden="${show('unlock')}">
    <form @submit="${(e) => a.unlock(form(e), e.target)}">
      <h2>Unlock</h2>
      <label>Passphrase <input name="pass" type="password" autocomplete="current-password" required></label>
      ${errorLine()}
      <div class="actions">
        <button class="primary" type="submit" disabled="${() => state.busy}">${() => (state.busy ? 'Unlocking…' : 'Unlock')}</button>
      </div>
    </form>
  </section>`;
}

function streamCard(r, a) {
  const spark = sparkPoints(state.spark[r.name] ?? []);
  // One root node, no whitespace around it: ArrowJS 1.0.6 breaks a keyed list
  // of multi-node items once it goes empty and back (Lock → Unlock).
  return html`<article class="stream">
    <header>
      <h3>${r.name}</h3>
      <span class="muted small">every ${r.interval_s}s · ${r.observations} obs · ${r.predictions} predictions</span>
    </header>
    <div class="figures">
      <div>
        <div class="label">Latest</div>
        <div class="value" data-test="obs">${fmtNum(r.obs_value)}</div>
        <div class="muted small">${fmtTime(r.obs_ts)}</div>
      </div>
      <div>
        <div class="label">Predicted</div>
        <div class="value accent" data-test="pred">${fmtNum(r.pred_value)}</div>
        <div class="muted small">for ${fmtTime(r.pred_target_ts)}${r.pred_published_at ? ' · published' : ''}</div>
      </div>
      <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="${spark}"></polyline></svg>
    </div>
    <p class="error small" role="status" hidden="${!r.last_error}">Last error (${fmtTime(r.last_error_at)}): ${r.last_error ?? ''}</p>
    <details hidden="${!r.pred_signature}">
      <summary>Signed prediction</summary>
      <code class="block" data-test="message">${r.pred_message ?? ''}</code>
      <code class="block" data-test="signature">${r.pred_signature ?? ''}</code>
    </details>
    <div class="row-actions"><button class="link" @click="${() => a.removeStream(r.name)}">Remove</button></div>
  </article>`;
}

function home(a) {
  return html`
  <section hidden="${show('home')}">
    <div class="card identity">
      <div>
        <div class="label">Address</div>
        <code data-test="address">${() => state.address}</code>
      </div>
      <button class="small-btn" @click="${a.copyAddress}">${() => (state.copied ? 'Copied' : 'Copy')}</button>
    </div>

    <div class="streams">${() => state.rows.map((r) => streamCard(r, a).key(r.name))}</div>
    <p class="muted" hidden="${() => state.rows.length > 0}">No streams yet. Add one below.</p>

    <details class="card">
      <summary>Add a stream</summary>
      <form class="fields" @submit="${(e) => a.addStream(form(e), e.target)}">
        <label>Name <input name="name" placeholder="ETH-USD" required maxlength="64"></label>
        <label>Source URL (https, returns JSON)
          <input name="url" type="url" placeholder="https://api.coinbase.com/v2/prices/ETH-USD/spot" required></label>
        <label>Path to the number <input name="path" placeholder="data.amount" required></label>
        <label>Every (seconds) <input name="interval" type="number" min="10" max="86400" step="1" value="60" required></label>
        <p class="error" role="alert" hidden="${() => !state.formError}">${() => state.formError}</p>
        <div class="actions"><button class="primary" type="submit">Add stream</button></div>
      </form>
    </details>

    <details class="card">
      <summary>Backup words</summary>
      <form hidden="${() => !!state.backupWords}" @submit="${(e) => a.showWords(form(e), e.target)}">
        <p class="muted">Enter your passphrase to show your 24 words.</p>
        <label>Passphrase <input name="pass" type="password" autocomplete="current-password" required></label>
        ${errorLine()}
        <div class="actions"><button type="submit">Show words</button></div>
      </form>
      <div hidden="${() => !state.backupWords}">
        <ol class="words">${() => state.backupWords.split(' ').filter(Boolean).map((w) => html`<li>${w}</li>`)}</ol>
        <div class="actions"><button @click="${a.hideWords}">Hide</button></div>
      </div>
    </details>
  </section>`;
}

export function render(root, a) {
  html`
  <header class="top">
    <h1>Satori <span class="muted">neuron</span></h1>
    <button hidden="${show('home')}" @click="${a.lock}">Lock</button>
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
    ${unlockScreen(a)}
    ${home(a)}
  </main>`(root);
}
