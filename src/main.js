// App wiring: one tab → open the database → Setup or Unlock → Home, where the
// scheduler runs one tick per stream interval. Lock stops it and wipes the key.
import { state, render } from './ui/view.js';
import { pickIndexes } from './ui/format.js';
import { openOpfsDb } from './db/opfs.js';
import { generateEntropy, entropyFromWords, deriveKeys, createVault, unlock } from './keys/index.js';
import { tick, createScheduler, localPublisher, claimTab, streamError, DEFAULT_STREAM } from './neuron/index.js';

const SPARK = 40;
let db;
let identity = null;
let pending = null; // entropy during setup only

async function refresh() {
  const rows = await db.summary();
  const spark = {};
  for (const r of rows) spark[r.name] = (await db.recent(r.name, SPARK)).map((o) => o.value);
  state.spark = spark;
  state.rows = rows;
}

const scheduler = createScheduler(async (stream, signal) => {
  const id = identity;
  if (!id || id.locked) return;
  await tick(stream, { db, identity: id, publish: localPublisher(db), signal });
  if (!signal.aborted && !id.locked) await refresh();
});

function wipePending() {
  pending?.fill(0);
  pending = null;
  state.words = [];
}

async function startSession(vault, pass) {
  identity = await unlock(vault, pass);
  state.address = identity.address;
  state.backupWords = '';
  state.screen = 'home';
  await refresh();
  for (const s of await db.streams()) scheduler.start(s);
}

function goStep(step) {
  state.error = '';
  state.step = step;
}

const busy = (fn) => async (...args) => {
  if (state.busy) return;
  state.busy = true;
  state.error = '';
  try {
    await fn(...args);
  } catch (err) {
    state.error = err?.message ?? String(err);
  } finally {
    state.busy = false;
  }
};

const actions = {
  goStep,
  newWords() {
    wipePending();
    pending = generateEntropy();
    state.words = deriveKeys(pending).words.split(' ');
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
  importWords(f, el) {
    try {
      wipePending();
      pending = entropyFromWords(f.words);
    } catch {
      return void (state.error = 'These are not 24 valid backup words.');
    }
    el.reset();
    goStep('passphrase');
  },
  createVault: busy(async (f, el) => {
    if (f.pass1 !== f.pass2) throw new Error('The passphrases differ.');
    if (f.pass1.length < 8) throw new Error('Use at least 8 characters.');
    const vault = await createVault(pending, f.pass1);
    await db.set('vault', vault);
    if (!(await db.streams()).length) await db.addStream(DEFAULT_STREAM);
    wipePending();
    el.reset();
    await startSession(vault, f.pass1);
  }),
  unlock: busy(async (f, el) => {
    await startSession(await db.get('vault'), f.pass);
    el.reset();
  }),
  lock() {
    scheduler.stopAll();
    identity?.lock();
    identity = null;
    Object.assign(state, { address: '', rows: [], spark: {}, backupWords: '', error: '', screen: 'unlock' });
  },
  showWords: busy(async (f, el) => {
    const id = identity;
    // words() throws 'Locked' if Lock is pressed during the unseal; then stay quiet.
    const words = await id.words(f.pass).catch((err) => { if (identity === id) throw err; });
    if (identity !== id || id.locked) return;
    state.backupWords = words;
    el.reset();
  }),
  hideWords() {
    state.backupWords = '';
  },
  async copyAddress() {
    try {
      await navigator.clipboard.writeText(state.address);
      state.copied = true;
      setTimeout(() => (state.copied = false), 1500);
    } catch { /* clipboard not allowed */ }
  },
  async addStream(f, el) {
    state.formError = '';
    const s = { name: f.name.trim(), url: f.url.trim(), path: f.path.trim(), interval_s: Math.round(Number(f.interval)) };
    const bad = streamError(s);
    if (bad) return void (state.formError = bad);
    if ((await db.streams()).some((x) => x.name === s.name)) return void (state.formError = `A stream named ${s.name} exists.`);
    try {
      await db.addStream(s);
    } catch (err) {
      return void (state.formError = err?.message ?? String(err));
    }
    el.reset();
    await refresh();
    scheduler.start(s);
  },
  async removeStream(name) {
    if (!confirm(`Remove ${name} and its data?`)) return;
    await scheduler.stop(name); // waits for a tick in flight, so it can't write after the delete
    await db.removeStream(name);
    await refresh();
  },
};

async function boot() {
  render(document.getElementById('app'), actions);
  if (!(await claimTab())) return void (state.screen = 'elsewhere');
  try {
    db = await openOpfsDb();
  } catch (err) {
    state.fatal = `The database did not open: ${err?.message ?? err}`;
    state.screen = 'fatal';
    return;
  }
  state.screen = (await db.get('vault')) ? 'unlock' : 'setup';
}

boot();
