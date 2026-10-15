// App wiring: one tab → open the database → Setup, or Home with the neuron
// running on the identity key from page load: register with central, then
// poll on Satori Lite's schedule (docs/design/central.md). Unlock/Lock open
// and wipe the vault; the neuron never needs it. window.satori is the same
// surface for agents (public/llms.txt).
import { version } from '../package.json';
import { state, render } from './ui/view.js';
import { pickIndexes } from './ui/format.js';
import { openOpfsDb } from './db/opfs.js';
import {
  generateEntropy, entropyFromWords, deriveKeys, writeKeys, importDocker, loadIdentity, vaultInfo, unlockVault,
} from './keys/index.js';
import { createCentral } from './central/index.js';
import { cycle, register, createPoller, claimTab } from './neuron/index.js';

// The dev server talks to the dev central, so nobody writes to prod from a dev checkout.
export const DEFAULT_CENTRAL = import.meta.env.DEV ? 'https://central2.satorinet.io' : 'https://network.satorinet.io';

let db;
let files = null; // { walletYaml, vaultYaml } as stored
let identity = null;
let vaultPublic = { address: null, pubkey: null }; // read from vault.yaml while locked
let vault = null; // only while unlocked
let lockCount = 0; // a Lock during an Unlock in flight wins
let pending = null; // setup only: { vault, identity? } entropy
let central = null;
let registration = null; // this page load's register result
let poller = null;

/** Central's state for the UI and agents: plain values. */
async function centralStatus() {
  return {
    url: central?.url ?? null,
    registration,
    lastPoll: (await db.get('central_last_poll')) ?? null,
    nextPoll: poller?.next ?? null,
    polling: !!poller?.running,
    lastSubmit: (await db.get('central_last_submit')) ?? null,
    pending: await db.pendingCount(),
  };
}

async function refresh() {
  state.central = await centralStatus();
  state.streams = await db.streams();
}

// ── core: used by the UI and by window.satori ───────────────────────────────

/** The stored (or default) central; a new client means a new register result. */
async function connect() {
  const url = (await db.get('central_url')) || DEFAULT_CENTRAL;
  central = createCentral({ url, identity, version });
  registration = null;
  return central;
}

/** Register, as Lite does on every start; the result is shown, never thrown. */
async function registerWith(c) {
  const r = await register({ central: c, vaultPubkey: vaultPublic.pubkey, vaultAddress: vaultPublic.address });
  if (c !== central) return; // the URL changed meanwhile
  registration = r;
  console[r.ok && !r.vaultMismatch ? 'info' : 'warn']('[satori] central register', c.url, r);
  await refresh();
}

async function runCycle() {
  const r = await cycle({ db, central }); // never throws: errors are in r and in the status
  console[r.poll.error || r.submit?.error ? 'warn' : 'info']('[satori] central cycle', r);
  await refresh();
  return r;
}

async function startNeuron() {
  files = { walletYaml: await db.get('wallet_yaml'), vaultYaml: await db.get('vault_yaml') };
  identity = await loadIdentity(files.walletYaml);
  vaultPublic = vaultInfo(files.vaultYaml);
  state.identity = identity.address;
  state.vault = vaultPublic.address ?? '';
  state.centralDefault = DEFAULT_CENTRAL;
  const c = await connect();
  poller = createPoller(runCycle, { db, onChange: ({ next, running }) => {
    state.central = { ...state.central, nextPoll: next, polling: running };
  } });
  await poller.start();
  await refresh();
  state.screen = 'home';
  registerWith(c).catch((err) => console.error('[satori] register', err));
}

/** A cycle now (the UI's Poll now, agents' poll()); one at a time. */
const pollNow = () => poller.poll();

/**
 * Save the central URL ('' = the default) and register there at once. Another
 * central has other stream uuids, so its pending predictions and stream list
 * are dropped; the list refills with the next poll.
 */
async function setCentral(raw) {
  const url = String(raw ?? '').trim().replace(/\/+$/, '');
  if (url) {
    let ok = false;
    try { ok = new URL(url).protocol === 'https:'; } catch { /* not a URL */ }
    if (!ok) throw new Error('The central URL must be an https:// address.');
  }
  if ((url || DEFAULT_CENTRAL) !== central.url) await db.resetCentral();
  await db.set('central_url', url);
  await db.checkpoint();
  const c = await connect();
  await refresh();
  await registerWith(c);
}

async function saveKeys({ walletYaml, vaultYaml }) {
  await db.set('vault_yaml', vaultYaml); // vault first: boot needs both
  await db.set('wallet_yaml', walletYaml);
  await db.checkpoint();
  await startNeuron();
}

async function unlock(passphrase) {
  const count = lockCount;
  const v = await unlockVault(files.vaultYaml, passphrase);
  if (count !== lockCount) return void v.lock();
  vault?.lock();
  vault = v;
  state.unlocked = true;
}

function lock() {
  lockCount++;
  vault?.lock();
  vault = null;
  Object.assign(state, { unlocked: false, backup: '', backupWords: '', backupWif: '' });
}

function backupOf(which) {
  if (which !== 'identity' && which !== 'vault') throw new Error("Name the key: 'identity' or 'vault'.");
  if (!vault) throw new Error('Unlock the vault first');
  return (which === 'vault' ? vault : identity).backup();
}

function fileText(name) {
  if (name !== 'wallet.yaml' && name !== 'vault.yaml') throw new Error("Name the file: 'wallet.yaml' or 'vault.yaml'.");
  if (!vault) throw new Error('Unlock the vault first');
  return name === 'vault.yaml' ? files.vaultYaml : files.walletYaml;
}

/** One action at a time, for the UI and agents alike; state.busy says which. */
async function exclusive(what, fn) {
  if (state.busy) throw new Error(`Busy (${state.busy}). Try again when it is done.`);
  state.busy = what;
  try {
    return await fn();
  } finally {
    state.busy = '';
  }
}

/** Setup, from the UI or an agent: one at a time, and only on the Setup screen. */
const setup = (makeFiles) => exclusive('setup', async () => {
  if (state.screen !== 'setup') throw new Error(`Already set up (screen: ${state.screen}).`);
  await saveKeys(await makeFiles());
});

// ── UI actions ──────────────────────────────────────────────────────────────

function wipePending() {
  pending?.vault?.fill(0);
  pending?.identity?.fill(0);
  pending = null;
  state.words = [];
}

function goStep(step) {
  state.error = '';
  state.step = step;
}

/** A UI action whose error is shown on the screen. */
const shown = (fn) => async (...args) => {
  state.error = '';
  try {
    await fn(...args);
  } catch (err) {
    state.error = err?.message ?? String(err);
  }
};

const actions = {
  goStep,
  newWords() {
    wipePending();
    pending = { vault: generateEntropy() };
    state.words = deriveKeys(pending.vault).words.split(' ');
    goStep('words');
  },
  toConfirm() {
    state.confirmAt = pickIndexes(3, 24);
    goStep('confirm');
  },
  confirmWords(f, el) {
    const ok = state.confirmAt.every((i) => (f[`w${i}`] ?? '').trim().toLowerCase() === state.words[i]);
    if (!ok) return void (state.error = 'Those words do not match. Check your list.');
    el.reset();
    goStep('passphrase');
  },
  restoreWords(f, el) {
    wipePending();
    const words = (text, which) => {
      try { return entropyFromWords(text); } catch { throw new Error(`The ${which} words are not 24 valid backup words.`); }
    };
    try {
      pending = { vault: words(f.vault, 'vault') };
      if (f.identity.trim()) pending.identity = words(f.identity, 'identity');
    } catch (err) {
      wipePending();
      return void (state.error = err.message);
    }
    el.reset();
    goStep('passphrase');
  },
  createKeys: shown(async (f, el) => {
    if (f.pass1 !== f.pass2) throw new Error('The passphrases differ.');
    await setup(async () => {
      const out = await writeKeys(pending, f.pass1);
      wipePending();
      el.reset();
      return out;
    });
  }),
  importDocker: shown(async (el) => {
    const f = new FormData(el);
    await setup(async () => {
      const out = await importDocker({
        walletText: await f.get('wallet').text(), vaultText: await f.get('vault').text(), passphrase: f.get('pass'),
      });
      el.reset();
      return out;
    });
  }),
  async unlock(f, el) {
    state.vaultError = '';
    try {
      await exclusive('unlock', () => unlock(f.pass));
      el.reset();
    } catch (err) {
      state.vaultError = err?.message ?? String(err);
    }
  },
  lock,
  showBackup(which) {
    const { words, wif } = backupOf(which);
    Object.assign(state, { backup: which, backupWords: words, backupWif: wif });
  },
  hideBackup() {
    Object.assign(state, { backup: '', backupWords: '', backupWif: '' });
  },
  download(name) {
    const url = URL.createObjectURL(new Blob([fileText(name)], { type: 'application/x-yaml' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  async copyAddress(which) {
    try {
      await navigator.clipboard.writeText(state[which]);
      state.copied = which;
      setTimeout(() => (state.copied = ''), 1500);
    } catch { /* clipboard not allowed */ }
  },
  pollNow: () => pollNow().catch((err) => console.error('[satori] poll', err)),
  async saveCentral(f, el) {
    state.settingsError = '';
    try {
      await setCentral(f.url);
      el.reset();
    } catch (err) {
      state.settingsError = err?.message ?? String(err);
    }
  },
};

// ── window.satori: the same app for agents (see /llms.txt) ──────────────────

/** Central's stream meta: the object its JSON text holds, the text if it is not JSON, or null. */
function parseMeta(meta) {
  try { return meta == null ? null : JSON.parse(meta); } catch { return meta; }
}

const ready = () => {
  if (state.screen !== 'home') throw new Error(`Not running (screen: ${state.screen}). Set up first.`);
};

window.satori = {
  help: 'Read /llms.txt',
  async status() {
    const home = state.screen === 'home';
    return {
      screen: state.screen,
      identity: state.identity || null,
      vault: state.vault || null,
      unlocked: state.unlocked,
      central: home ? await centralStatus() : null,
    };
  },
  /** Create a neuron (random keys unless words are given). The vault stays locked. */
  async setup({ passphrase, vaultWords, identityWords } = {}) {
    await setup(async () => {
      const keys = {};
      try {
        keys.vault = vaultWords ? entropyFromWords(vaultWords) : generateEntropy();
        if (identityWords) keys.identity = entropyFromWords(identityWords);
        return await writeKeys(keys, passphrase);
      } finally {
        keys.vault?.fill(0);
        keys.identity?.fill(0);
      }
    });
    return this.status();
  },
  /** Poll central now: store, forecast new rows, send what is pending. → { poll, submit } */
  async poll() { ready(); return pollNow(); },
  /** Central's streams with the latest observation and our latest prediction. */
  async streams() { ready(); return (await db.streams()).map((r) => ({ ...r, meta: parseMeta(r.meta) })); },
  /** One stream's predictions (uuid or name), newest first. */
  async predictions(stream, limit = 20) { ready(); return db.predictions(stream, limit); },
  /** Set the central URL ('' = the default) and register there. → status().central */
  async setCentral(url) { ready(); await setCentral(url); return centralStatus(); },
  async unlock(passphrase) { ready(); await unlock(passphrase); return true; },
  lock() { lock(); return true; },
  /** { words, wif } of 'identity' or 'vault'; needs Unlock, as Docker's dashboard needs login. */
  backup(which) { ready(); return backupOf(which); },
  /** wallet.yaml or vault.yaml text, as Docker reads it; needs Unlock. */
  file(name) { ready(); return fileText(name); },
};

async function boot() {
  render(document.getElementById('app'), actions);
  if (!(await claimTab())) return void (state.screen = 'elsewhere');
  try {
    db = await openOpfsDb();
    if ((await db.get('wallet_yaml')) && (await db.get('vault_yaml'))) return void (await startNeuron());
    state.screen = 'setup';
  } catch (err) {
    state.fatal = `The neuron did not start: ${err?.message ?? err}`;
    state.screen = 'fatal';
  }
}

boot();
