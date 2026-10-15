// App wiring: one tab → open the database → Setup, or Home with the neuron
// running on the identity key from page load. Unlock/Lock open and wipe the
// vault; ticks never need it. window.satori is the same surface for agents
// (public/llms.txt).
import { state, render } from './ui/view.js';
import { pickIndexes } from './ui/format.js';
import { openOpfsDb } from './db/opfs.js';
import {
  generateEntropy, entropyFromWords, deriveKeys, verifyMessage,
  writeKeys, importDocker, loadIdentity, vaultInfo, unlockVault,
} from './keys/index.js';
import { tick, createScheduler, localPublisher, claimTab, streamError, DEFAULT_STREAM } from './neuron/index.js';

const SPARK = 40;
let db;
let files = null; // { walletYaml, vaultYaml } as stored
let identity = null;
let vault = null; // only while unlocked
let lockCount = 0; // a Lock during an Unlock in flight wins
let pending = null; // setup only: { vault, identity? } entropy

async function refresh() {
  const rows = await db.summary();
  const spark = {};
  for (const r of rows) spark[r.name] = (await db.recent(r.name, SPARK)).map((o) => o.value);
  state.spark = spark;
  state.rows = rows;
}

const scheduler = createScheduler(async (stream, signal) => {
  await tick(stream, { db, identity, publish: localPublisher(db), signal });
  if (!signal.aborted) await refresh();
});

// ── core: used by the UI and by window.satori ───────────────────────────────

async function startNeuron() {
  files = { walletYaml: await db.get('wallet_yaml'), vaultYaml: await db.get('vault_yaml') };
  identity = await loadIdentity(files.walletYaml);
  state.identity = identity.address;
  state.vault = vaultInfo(files.vaultYaml).address ?? '';
  state.screen = 'home';
  await refresh();
  for (const s of await db.streams()) scheduler.start(s);
}

async function saveKeys({ walletYaml, vaultYaml }) {
  await db.set('vault_yaml', vaultYaml); // vault first: boot needs both
  await db.set('wallet_yaml', walletYaml);
  if (state.legacyKey) await db.set('vault', null); // the step-1 prototype's sealed key
  if (!(await db.streams()).length) await db.addStream(DEFAULT_STREAM);
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
  if (!vault) throw new Error('Unlock the vault first');
  return (which === 'vault' ? vault : identity).backup();
}

function fileText(name) {
  if (!vault) throw new Error('Unlock the vault first');
  return name === 'vault.yaml' ? files.vaultYaml : files.walletYaml;
}

async function addStream(s) {
  const bad = streamError(s);
  if (bad) throw new Error(bad);
  if ((await db.streams()).some((x) => x.name === s.name)) throw new Error(`A stream named ${s.name} exists.`);
  await db.addStream(s);
  await refresh();
  scheduler.start(s);
}

async function removeStream(name) {
  await scheduler.stop(name); // waits for a tick in flight, so it can't write after the delete
  await db.removeStream(name);
  await refresh();
}

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

const busy = (what, fn) => async (...args) => {
  if (state.busy) return;
  state.busy = what;
  state.error = '';
  try {
    await fn(...args);
  } catch (err) {
    state.error = err?.message ?? String(err);
  } finally {
    state.busy = '';
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
  createKeys: busy('setup', async (f, el) => {
    if (f.pass1 !== f.pass2) throw new Error('The passphrases differ.');
    const out = await writeKeys(pending, f.pass1);
    wipePending();
    el.reset();
    await saveKeys(out);
  }),
  importDocker: busy('setup', async (el) => {
    const f = new FormData(el);
    const out = await importDocker({
      walletText: await f.get('wallet').text(), vaultText: await f.get('vault').text(), passphrase: f.get('pass'),
    });
    el.reset();
    await saveKeys(out);
  }),
  unlock: busy('unlock', async (f, el) => {
    state.vaultError = '';
    try {
      await unlock(f.pass);
      el.reset();
    } catch (err) {
      state.vaultError = err?.message ?? String(err);
    }
  }),
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
  async addStream(f, el) {
    state.formError = '';
    try {
      await addStream({ name: f.name.trim(), url: f.url.trim(), path: f.path.trim(), interval_s: Math.round(Number(f.interval)) });
      el.reset();
    } catch (err) {
      state.formError = err?.message ?? String(err);
    }
  },
  async removeStream(name) {
    if (confirm(`Remove ${name} and its data?`)) await removeStream(name);
  },
};

// ── window.satori: the same app for agents (see /llms.txt) ──────────────────

const ready = () => {
  if (state.screen !== 'home') throw new Error(`Not running (screen: ${state.screen}). Set up first.`);
};

window.satori = {
  help: 'Read /llms.txt',
  async status() {
    return {
      screen: state.screen,
      identity: state.identity || null,
      vault: state.vault || null,
      unlocked: state.unlocked,
      streams: state.screen === 'home' ? await db.summary() : [],
    };
  },
  /** Create a neuron (random keys unless words are given). The vault stays locked. */
  async setup({ passphrase, vaultWords, identityWords } = {}) {
    if (state.screen !== 'setup') throw new Error(`Already set up (screen: ${state.screen}).`);
    const keys = { vault: vaultWords ? entropyFromWords(vaultWords) : generateEntropy() };
    if (identityWords) keys.identity = entropyFromWords(identityWords);
    await saveKeys(await writeKeys(keys, passphrase));
    return this.status();
  },
  async predictions(stream, limit = 20) {
    ready();
    return db.rows('SELECT * FROM predictions WHERE stream = ? ORDER BY id DESC LIMIT ?', stream, limit);
  },
  async addStream({ name, url, path, interval_s = 60 }) { ready(); await addStream({ name, url, path, interval_s }); },
  async removeStream(name) { ready(); await removeStream(name); },
  async unlock(passphrase) { ready(); await unlock(passphrase); return true; },
  lock() { lock(); return true; },
  /** { words, wif } of 'identity' or 'vault'; needs Unlock, as Docker's dashboard needs login. */
  backup(which) { ready(); return backupOf(which); },
  /** wallet.yaml or vault.yaml text, as Docker reads it; needs Unlock. */
  file(name) { ready(); return fileText(name); },
  verify: (message, signature, address) => verifyMessage(message, signature, { address }),
};

async function boot() {
  render(document.getElementById('app'), actions);
  if (!(await claimTab())) return void (state.screen = 'elsewhere');
  try {
    db = await openOpfsDb();
    if ((await db.get('wallet_yaml')) && (await db.get('vault_yaml'))) return void (await startNeuron());
    state.legacyKey = !!(await db.get('vault'));
    state.screen = 'setup';
  } catch (err) {
    state.fatal = `The neuron did not start: ${err?.message ?? err}`;
    state.screen = 'fatal';
  }
}

boot();
