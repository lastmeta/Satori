// App wiring: one tab → open the database → Setup, or Home with the neuron
// running on the identity key from page load: register with central, then
// poll on Satori Lite's schedule (docs/design/central.md), and follow the
// subscribed Nostr streams, publishing `<stream>_pred` (docs/design/nostr.md).
// Unlock/Lock open and wipe the vault; the neuron never needs it.
// window.satori is the same surface for agents (public/llms.txt).
import { version } from '../package.json';
import { state, render } from './ui/view.js';
import { pickIndexes } from './ui/format.js';
import { openOpfsDb } from './db/opfs.js';
import {
  generateEntropy, entropyFromWords, deriveKeys, writeKeys, importDocker, loadIdentity, vaultInfo, unlockVault,
  loadNostr, newNostrYaml,
} from './keys/index.js';
import { createCentral } from './central/index.js';
import { cycle, register, createPoller, claimTab } from './neuron/index.js';
import { createNostr } from './neuron/nostr.js';
import { relayUuid } from './nostr/satori.js';

// The dev server talks to the dev central, so nobody writes to prod from a dev checkout.
export const DEFAULT_CENTRAL = import.meta.env.DEV ? 'https://central2.satorinet.io' : 'https://network.satorinet.io';
// The same rule for Nostr: on the dev server central's relays (satorian, production)
// are read only, and the user's relays default to the test relay (scripts/test-relay.mjs).
export const DEV_RELAY = 'ws://localhost:7778';
export const NOSTR_DEFAULTS = import.meta.env.DEV ? { relays: [DEV_RELAY], centralWrite: false } : { relays: [], centralWrite: true };

let db;
let files = null; // { walletYaml, vaultYaml, nostrYaml } as stored
let identity = null;
let nostrKey = null; // { secret, pubkey }: plaintext, as the identity
let nostr = null; // the Nostr flow
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

/**
 * The Nostr card. One status read at a time: changes during a read ask for
 * one more read after it, however many there were.
 */
let nostrRefresh = null;
let nostrStale = false;
function refreshNostr() {
  nostrStale = true;
  nostrRefresh ??= (async () => {
    while (nostrStale) {
      nostrStale = false;
      if (nostr) state.nostr = await nostr.status();
    }
  })().catch((err) => console.error('[satori] nostr status', err)).finally(() => { nostrRefresh = null; });
  return nostrRefresh;
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
  const r = await register({ central: c, vaultPubkey: vaultPublic.pubkey, vaultAddress: vaultPublic.address,
    nostrPubkey: nostrKey.pubkey });
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

/** The stored Nostr key; an install from before step 5 gets one now (start.py:120-149). */
async function nostrYamlOf() {
  let text = await db.get('nostr_yaml');
  if (!text) {
    text = newNostrYaml();
    await db.set('nostr_yaml', text);
    await db.checkpoint();
  }
  return text;
}

async function startNeuron() {
  files = { walletYaml: await db.get('wallet_yaml'), vaultYaml: await db.get('vault_yaml'), nostrYaml: await nostrYamlOf() };
  identity = await loadIdentity(files.walletYaml);
  vaultPublic = vaultInfo(files.vaultYaml);
  nostrKey = loadNostr(files.nostrYaml);
  state.identity = identity.address;
  state.vault = vaultPublic.address ?? '';
  state.centralDefault = DEFAULT_CENTRAL;
  const c = await connect();
  poller = createPoller(runCycle, { db, onChange: ({ next, running }) => {
    state.central = { ...state.central, nextPoll: next, polling: running };
  } });
  await poller.start();
  await refresh();
  nostr?.stop();
  nostr = createNostr({ db, key: nostrKey, walletPubkey: identity.pubkey, central: () => central, defaults: NOSTR_DEFAULTS,
    onChange: refreshNostr });
  await refreshNostr();
  state.screen = 'home';
  registerWith(c).catch((err) => console.error('[satori] register', err));
  nostr.start().catch((err) => console.error('[satori] nostr start', err));
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
  await nostr.reconcile(); // this central's relays
}

async function saveKeys({ walletYaml, vaultYaml, nostrYaml }) {
  await db.set('nostr_yaml', nostrYaml);
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

const FILES = { 'wallet.yaml': 'walletYaml', 'vault.yaml': 'vaultYaml', 'nostr.yaml': 'nostrYaml' };

function fileText(name) {
  if (!Object.hasOwn(FILES, name)) throw new Error("Name the file: 'wallet.yaml', 'vault.yaml' or 'nostr.yaml'.");
  if (!vault) throw new Error('Unlock the vault first');
  return files[FILES[name]];
}

/** Subscribe or unsubscribe, then the catalog's mark follows. */
async function setSubscribed(pubkey, stream, on) {
  const r = on ? await nostr.subscribe(pubkey, stream) : await nostr.unsubscribe(pubkey, stream);
  state.catalog = state.catalog.map((s) => (s.pubkey === pubkey && s.stream_name === stream ? { ...s, subscribed: on } : s));
  await refreshNostr();
  return r;
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
      const n = f.get('nostr');
      const out = await importDocker({
        walletText: await f.get('wallet').text(), vaultText: await f.get('vault').text(), passphrase: f.get('pass'),
        nostrText: n?.size ? await n.text() : undefined,
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
  async discover() {
    state.networkError = '';
    state.discovering = true;
    try {
      state.catalog = await nostr.discover();
    } catch (err) {
      state.networkError = err?.message ?? String(err);
    } finally {
      state.discovering = false;
    }
  },
  async subscribe(pubkey, stream, on) {
    state.networkError = '';
    state.subscribing = `${pubkey}:${stream}`;
    try {
      await setSubscribed(pubkey, stream, on);
    } catch (err) {
      state.networkError = err?.message ?? String(err);
    } finally {
      state.subscribing = '';
    }
  },
  fillRelays(el) {
    el.elements.relays.value = state.nostr.userRelays.join('\n');
    el.elements.centralWrite.checked = state.nostr.centralWrite;
  },
  async saveRelays(f, el) {
    state.relaysError = '';
    try {
      await nostr.setRelays({ relays: String(f.relays ?? '').split(/\s+/).filter(Boolean), centralWrite: f.centralWrite === 'on' });
      await refreshNostr();
      actions.fillRelays(el);
    } catch (err) {
      state.relaysError = err?.message ?? String(err);
    }
  },
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

/** The Nostr flow's status, the same as the Nostr card. */
const nostrStatus = () => nostr.status();

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
      nostr: home ? await nostrStatus() : null,
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
  /** wallet.yaml, vault.yaml or nostr.yaml text, as Docker reads it; needs Unlock. */
  file(name) { ready(); return fileText(name); },
  /** Nostr: the key, the relays and their state, the subscribed streams with the latest observation and our `_pred`. */
  async nostr() { ready(); return nostrStatus(); },
  /** The relays' stream catalog (newest per provider and stream, no tombstones); `pred` and `subscribed` marked. */
  async discover() { ready(); const list = await nostr.discover(); state.catalog = list; return list; },
  /** Subscribe to a free stream and predict it: `<stream>_pred` is published on each new observation. */
  async subscribe(pubkey, stream) { ready(); return setSubscribed(String(pubkey ?? '').trim().toLowerCase(), stream, true); },
  async unsubscribe(pubkey, stream) { ready(); return setSubscribed(String(pubkey ?? '').trim().toLowerCase(), stream, false); },
  /** Our `<stream>_pred` history for a relay stream, newest first: { seq, value, model, obs_seq, made_at, event_id, relays }. */
  async relayPredictions(pubkey, stream, limit = 20) {
    ready();
    return (await db.relayPredictions(relayUuid(String(pubkey ?? '').trim().toLowerCase(), String(stream ?? '')), limit))
      .map(({ stream_uuid, ...p }) => p);
  },
  /** Settings: { relays: ['wss://…'], centralWrite: boolean }, either or both. → nostr() */
  async setRelays(settings) { ready(); const s = await nostr.setRelays(settings); await refreshNostr(); return s; },
};

async function boot() {
  const root = document.getElementById('app');
  root.replaceChildren(); // index.html's "Opening…", painted before any module loads
  render(root, actions);
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
