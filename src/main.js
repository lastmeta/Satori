// App wiring: one tab → open the database → Setup, or Home with the neuron
// running on the identity key from page load: register with central, then
// poll on Satori Lite's schedule (docs/design/central.md), and follow the
// subscribed Nostr streams, publishing `<stream>_pred` (docs/design/nostr.md),
// and the identity's daily batch on Base (docs/design/base.md).
// Unlock/Lock open and wipe the vault; the neuron never needs it (Base's
// delegate, claims and sends do). The keys are one record of this app's own
// (meta `keys`, docs/design/keys.md); Base is the only chain shown.
// window.satori is the same surface for agents (public/llms.txt). The
// installed app (service worker, Install, persistent storage) is src/pwa/.
import { version } from '../package.json';
import { state, render } from './ui/view.js';
import { pickIndexes } from './ui/format.js';
import { openOpfsDb } from './db/opfs.js';
import {
  generateSecret, secretFromWords, wordsOf, newKeys, readDockerFiles, loadKeys, unlockVault, passphraseOk, MIN_PASSPHRASE,
} from './keys/index.js';
import { nsec, nostrSecretOf } from './nostr/event.js';
import { createCentral } from './central/index.js';
import { cycle, register, createPoller, centralStatus as statusOf, claimTab, modelsOf } from './neuron/index.js';
import { backfillHistory } from './neuron/history.js';
import { createNostr } from './neuron/nostr.js';
import { relayUuid } from './nostr/satori.js';
import { createBase } from './neuron/base.js';
import { isHttps } from './util.js';
import { defaultsFrom, DEV_DEFAULTS, BUILD_DEFAULTS } from './config.js';
import { shortHash, claimLine, stepText } from './ui/format.js';
import { startPwa, applyUpdate, install, storage, keepStorage } from './pwa/index.js';

// Settings' defaults: the dev server's (the dev central, the test relay, the local fork, so a dev
// checkout writes nothing to production) or a build's, each replaceable by a VITE_* variable.
const DEFAULTS = defaultsFrom(import.meta.env, import.meta.env.DEV ? DEV_DEFAULTS : BUILD_DEFAULTS);
const DEFAULT_CENTRAL = DEFAULTS.central;

let db;
let record = null; // the keys as stored (meta `keys`)
let identity = null;
let nostrKey = null; // { secret, pubkey }: plaintext, as the identity
let nostr = null; // the Nostr flow
let vaultPublic = { pubkey: null, evmAddress: null }; // from the record, while locked
let vault = null; // only while unlocked
let lockCount = 0; // a Lock during an Unlock in flight wins
let pending = null; // setup only: { vault, identity?, nostr? } secrets
let central = null;
let registration = null; // this page load's register result
let poller = null;
let base = null; // the Base flow

const centralStatus = () => statusOf({ db, central, registration, poller });

async function refresh() {
  state.central = await centralStatus();
  state.streams = await db.streams();
}

/**
 * `fn` one run at a time: calls during a run ask for one more run after it,
 * however many there were. Never rejects (an error is logged).
 */
function coalesce(name, fn) {
  let running = null;
  let stale = false;
  return () => {
    stale = true;
    running ??= (async () => {
      while (stale) {
        stale = false;
        await fn();
      }
    })().catch((err) => console.error(`[satori] ${name}`, err)).finally(() => { running = null; });
    return running;
  };
}

/** The Nostr and Base cards: their status, read again on each change. */
const refreshNostr = coalesce('nostr status', async () => { state.nostr = await nostr.status(); });
const refreshBase = coalesce('base status', async () => { state.base = await base.status(); });

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
  const r = await register({ central: c, vaultPubkey: vaultPublic.pubkey, nostrPubkey: nostrKey.pubkey });
  if (c !== central) return; // the URL changed meanwhile
  registration = r;
  console[r.ok && !r.vaultMismatch ? 'info' : 'warn']('[satori] central register', c.url, r);
  await refresh();
}

/**
 * Central's history for the streams that have none (src/neuron/history.js): at
 * load and in each poll, one run at a time (a call during a run gets one more
 * run after it). Never throws.
 */
const backfill = coalesce('history', async () => {
  const r = await backfillHistory({ db, central });
  if (r?.streams) console.info('[satori] central history', r);
  await refresh();
});

async function runCycle() {
  // never throws: errors are in r and in the status; seed: the identity draws each target's spec
  const r = await cycle({ db, central, seed: identity.pubkey, backfill });
  console[r.poll.error || r.submit?.error ? 'warn' : 'info']('[satori] central cycle', r);
  await refresh();
  return r;
}

async function startNeuron() {
  ({ identity, nostr: nostrKey, vault: vaultPublic } = loadKeys(record));
  state.identity = identity.evmAddress;
  state.vault = vaultPublic.evmAddress;
  state.centralDefault = DEFAULT_CENTRAL;
  const c = await connect();
  poller = createPoller(runCycle, { db, onChange: ({ next, running }) => {
    state.central = { ...state.central, nextPoll: next, polling: running };
  } });
  await poller.start();
  await refresh();
  nostr = createNostr({ db, key: nostrKey, walletPubkey: identity.pubkey, central: () => central, defaults: { relays: DEFAULTS.relays, centralWrite: DEFAULTS.centralWrite },
    onChange: refreshNostr });
  await refreshNostr();
  base = createBase({ db, identity, vaultAddress: vaultPublic.evmAddress, vault: () => vault, central: () => central, defaultRpc: DEFAULTS.rpc,
    onChange: refreshBase });
  await refreshBase();
  state.screen = 'home';
  keepStorage(); // after setup and on each load until the browser keeps it: the keys live in this storage
  registerWith(c).catch((err) => console.error('[satori] register', err));
  backfill(); // streams with no history yet (all of them after an update) get it now, not at the first poll
  nostr.start().catch((err) => console.error('[satori] nostr start', err));
  base.start();
}

/** A cycle now (the UI's Poll now, agents' poll()); one at a time. */
const pollNow = () => poller.poll();

/**
 * Save the central URL ('' = the default) and register there at once. Another
 * central has other stream uuids, so its pending predictions and stream list
 * are dropped (after a poll still running with the old one); the list refills
 * with the next poll. Its relays and its Base config follow.
 */
async function setCentral(raw) {
  const url = String(raw ?? '').trim().replace(/\/+$/, '');
  if (url && !isHttps(url)) throw new Error('The central URL must be an https:// address.');
  if ((url || DEFAULT_CENTRAL) !== central.url) {
    await poller.idle(); // its rows are the old central's
    await db.resetCentral();
  }
  await db.set('central_url', url);
  await db.checkpoint();
  const c = await connect();
  await refresh();
  await registerWith(c);
  await nostr.reconcile(); // this central's relays
  await base.refresh(); // this central's Base config
}

/** The keys record, stored in one commit (each commit is checkpointed: docs/design/storage.md). */
async function storeKeys(r) {
  await db.set('keys', r);
  await db.checkpoint();
  record = r;
}

async function saveKeys(r) {
  await storeKeys(r);
  await startNeuron();
}

async function unlock(passphrase) {
  const count = lockCount;
  const { vault: v, record: upgraded } = await unlockVault(record, passphrase);
  if (upgraded) await storeKeys(upgraded); // an earlier version's vault, now in this app's format (keys.md#migration)
  if (count !== lockCount) return void v.lock();
  vault?.lock();
  vault = v;
  state.unlocked = true;
}

function lock() {
  lockCount++;
  vault?.lock();
  vault = null;
  Object.assign(state, { unlocked: false, backup: '', backupWords: '', backupKey: '', backupHex: '' });
}

/** An earlier version's vault with no public key in clear: its first Unlock stores it in this app's format, then the neuron starts. */
async function finishUpdate(passphrase) {
  await exclusive('unlock', () => unlock(passphrase));
  await startNeuron();
}

const BACKUPS = {
  identity: () => identity.backup(),
  vault: () => vault.backup(),
  nostr: () => ({ nsec: nsec(nostrKey.secret), secret: nostrKey.secret }),
};

/** One key's backup ({ words, privateKey }, or the Nostr key's { nsec, secret }), or all three; needs Unlock. */
function backupOf(which) {
  if (which !== undefined && !Object.hasOwn(BACKUPS, which)) {
    throw new Error("Name the key: 'identity', 'vault' or 'nostr' (or nothing, for all three).");
  }
  if (!vault) throw new Error('Unlock the vault first');
  if (which !== undefined) return BACKUPS[which]();
  return Object.fromEntries(Object.entries(BACKUPS).map(([k, f]) => [k, f()]));
}

/** Subscribe or unsubscribe, then the catalog's mark follows. */
async function setSubscribed(pubkey, stream, on) {
  const r = on ? await nostr.subscribe(pubkey, stream) : await nostr.unsubscribe(pubkey, stream);
  state.catalog = state.catalog.map((s) => (s.pubkey === pubkey && s.stream_name === stream ? { ...s, subscribed: on } : s));
  await refreshNostr();
  return r;
}

/**
 * One action at a time per slot, for the UI and agents alike; state[slot]
 * says which: 'busy' (setup, unlock) or 'baseBusy' (the Base card's).
 */
async function exclusive(what, fn, slot = 'busy') {
  if (state[slot]) throw new Error(`Busy (${state[slot]}). Try again when it is done.`);
  state[slot] = what;
  try {
    return await fn();
  } finally {
    state[slot] = '';
  }
}

/** A Base action, one at a time; then the card is read again. */
const baseAction = (what, fn) => exclusive(what, fn, 'baseBusy').finally(() => void refreshBase());

/** Setup, from the UI or an agent: one at a time, and only on the Setup screen. `makeRecord` → the keys, or null (not yet). */
const setup = (makeRecord) => exclusive('setup', async () => {
  if (state.screen !== 'setup') throw new Error(`Already set up (screen: ${state.screen}).`);
  const r = await makeRecord();
  if (r) await saveKeys(r);
});

// ── UI actions ──────────────────────────────────────────────────────────────

function wipePending() {
  pending?.vault?.fill(0);
  pending?.identity?.fill(0);
  pending = null;
  state.words = [];
  state.passNote = '';
}

function goStep(step) {
  state.error = '';
  state.step = step;
}

/** A UI action whose error is shown at state[key], cleared when it starts. */
const shownAt = (key, fn) => async (...args) => {
  state[key] = '';
  try {
    await fn(...args);
  } catch (err) {
    state[key] = err?.message ?? String(err);
  }
};

/** A Base action from the card: its result (text, and its txs, linked) or error is shown there. */
const baseUi = (what, fn) => shownAt('baseError', async () => {
  Object.assign(state, { baseResult: '', baseTxs: [] });
  const { text, txs = [] } = await baseAction(what, fn);
  Object.assign(state, { baseResult: text, baseTxs: txs });
})();

const stepTxs = (steps) => steps.map((x) => ({ label: stepText(x.step), title: `${x.step} by the ${x.by}`, hash: x.hash }));
const claimTxs = (r) => [['Rewards', r.rewards], ['Merkle', r.merkle], ['Airdrop', r.airdrop]]
  .filter(([, x]) => x?.hash).map(([label, x]) => ({ label, hash: x.hash }));

const actions = {
  goStep,
  newWords() {
    wipePending();
    pending = { vault: generateSecret() };
    state.words = wordsOf(pending.vault).split(' ');
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
      try { return secretFromWords(text); } catch { throw new Error(`The ${which} words are not 24 valid backup words.`); }
    };
    try {
      pending = { vault: words(f.vault, 'vault') };
      if (f.identity.trim()) pending.identity = words(f.identity, 'identity');
      if (f.nostr.trim()) pending.nostr = nostrSecretOf(f.nostr);
    } catch (err) {
      wipePending();
      return void (state.error = err.message);
    }
    el.reset();
    goStep('passphrase');
  },
  createKeys: shownAt('error', async (f, el) => {
    if (f.pass1 !== f.pass2) throw new Error('The passphrases differ.');
    await setup(async () => {
      const out = await newKeys(pending, f.pass1);
      wipePending();
      el.reset();
      return out;
    });
  }),
  /**
   * Dockerized Neuron files: decrypted with the Docker vault password and translated into this app's
   * record. The same password becomes this app's passphrase when it meets the rule and `reuse` is ticked;
   * otherwise the passphrase step asks for one.
   */
  importDocker: shownAt('error', async (el) => {
    const f = new FormData(el);
    await setup(async () => {
      const n = f.get('nostr');
      const password = String(f.get('pass') ?? '');
      const reuse = f.get('reuse') === 'on';
      const secrets = await readDockerFiles({
        walletText: await f.get('wallet').text(), vaultText: await f.get('vault').text(), password,
        nostrText: n?.size ? await n.text() : undefined,
      });
      el.reset();
      if (reuse && passphraseOk(password)) {
        try {
          return await newKeys(secrets, password);
        } finally {
          secrets.identity.fill(0);
          secrets.vault.fill(0);
        }
      }
      wipePending();
      pending = secrets;
      state.passNote = reuse
        ? `The Dockerized Neuron's vault password is shorter than ${MIN_PASSPHRASE} characters. Choose a new passphrase for this app.`
        : 'Choose a passphrase for this app.';
      goStep('passphrase');
      return null;
    });
  }),
  unlock: shownAt('vaultError', async (f, el) => {
    await exclusive('unlock', () => unlock(f.pass));
    el.reset();
  }),
  finishUpdate: shownAt('vaultError', async (f, el) => {
    await finishUpdate(f.pass);
    el.reset();
  }),
  lock,
  showBackup(which) {
    const b = backupOf(which);
    Object.assign(state, { backup: which, backupWords: b.words ?? '', backupKey: b.privateKey ?? b.nsec, backupHex: b.secret ?? '' });
  },
  hideBackup() {
    Object.assign(state, { backup: '', backupWords: '', backupKey: '', backupHex: '' });
  },
  async copy(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      state.copied = key;
      setTimeout(() => (state.copied = ''), 1500);
    } catch { /* clipboard not allowed */ }
  },
  pollNow: () => pollNow().catch((err) => console.error('[satori] poll', err)),
  install: () => install().catch((err) => console.warn('[satori] install', err)),
  update: applyUpdate,
  dismissNotice() { state.noticeDismissed = true; },
  discover: shownAt('networkError', async () => {
    state.discovering = true;
    try {
      state.catalog = await nostr.discover();
    } finally {
      state.discovering = false;
    }
  }),
  subscribe: shownAt('networkError', async (pubkey, stream, on) => {
    state.subscribing = `${pubkey}:${stream}`;
    try {
      await setSubscribed(pubkey, stream, on);
    } finally {
      state.subscribing = '';
    }
  }),
  fillRelays(el) {
    el.elements.relays.value = state.nostr.userRelays.join('\n');
    el.elements.centralWrite.checked = state.nostr.centralWrite;
  },
  saveRelays: shownAt('relaysError', async (f, el) => {
    await nostr.setRelays({ relays: String(f.relays ?? '').split(/\s+/).filter(Boolean), centralWrite: f.centralWrite === 'on' });
    await refreshNostr();
    actions.fillRelays(el);
  }),
  baseRefresh: () => baseAction('refresh', () => base.refresh()).catch(() => {}),
  baseDelegate: () => baseUi('delegate', async () => {
    const r = await base.delegate();
    return { text: r.steps.length ? 'Delegated prediction power to the identity.' : 'Already delegated to the identity.',
      txs: stepTxs(r.steps) };
  }),
  baseUndelegate: () => baseUi('undelegate', async () => {
    const r = await base.undelegate();
    return { text: r.steps.length ? 'Stopped delegating.' : 'Not delegated.', txs: stepTxs(r.steps) };
  }),
  baseClaim: () => baseUi('claim', async () => {
    const r = await base.claim();
    return { text: [claimLine('Rewards', r.rewards), claimLine('Merkle', r.merkle), claimLine('Airdrop', r.airdrop)].join(' · '),
      txs: claimTxs(r) };
  }),
  baseSend: (f, el) => baseUi('send', async () => {
    const r = await base.send({ asset: f.asset, to: String(f.to ?? '').trim(), amount: f.amount });
    el.reset();
    return { text: `Sent ${f.amount} ${f.asset}.`, txs: [{ label: `${f.asset} to ${shortHash(String(f.to).trim())}`, hash: r.hash }] };
  }),
  /** What is stored, not the defaults (those are the placeholders). */
  fillBase(el) {
    el.elements.rpc.value = state.base.rpcSetting;
    el.elements.maxFee.value = state.base.maxFeeSetting ?? '';
  },
  saveBase: shownAt('baseRpcError', async (f, el) => {
    state.base = await base.setSettings({ rpc: f.rpc, maxFee: f.maxFee });
    actions.fillBase(el);
  }),
  saveCentral: shownAt('settingsError', async (f, el) => {
    await setCentral(f.url);
    el.reset();
  }),
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
      base: home ? await base.status() : null,
      storage: await storage(),
      app: { ...state.app },
      recovered: state.recovered,
    };
  },
  /** Chromium's install prompt, when offered (status().app.canInstall; needs a user gesture). → 'accepted' | 'dismissed' | 'unavailable' */
  install() { return install(); },
  /** When status().app.update: the new version takes over and the page reloads. → false if none is waiting */
  update() { return applyUpdate(); },
  /** Create a neuron (random keys unless words, or the Nostr key's nsec or hex, are given). The vault stays locked. */
  async setup({ passphrase, vaultWords, identityWords, nostrKey } = {}) {
    await setup(async () => {
      const keys = {};
      try {
        keys.vault = vaultWords ? secretFromWords(vaultWords) : generateSecret();
        if (identityWords) keys.identity = secretFromWords(identityWords);
        if (nostrKey) keys.nostr = nostrSecretOf(nostrKey);
        return await newKeys(keys, passphrase);
      } finally {
        keys.vault?.fill(0);
        keys.identity?.fill(0);
      }
    });
    return window.satori.status();
  },
  /** Poll central now: store, forecast new rows, send what is pending. → { poll, submit } */
  async poll() { ready(); return pollNow(); },
  /** Central's streams with the latest observation, our latest prediction and the stream's spec. */
  async streams() { ready(); return (await db.streams()).map((r) => ({ ...r, meta: parseMeta(r.meta), spec: parseMeta(r.spec) })); },
  /** Each target's champion spec (bvar): companions by uuid and name, λ1, λ2, score, generation, accepted; and its latest model. */
  async models() { ready(); return modelsOf(await db.streams()); },
  /** One stream's predictions (uuid or name), newest first. */
  async predictions(stream, limit = 20) { ready(); return db.predictions(stream, limit); },
  /** Set the central URL ('' = the default) and register there. → status().central */
  async setCentral(url) { ready(); await setCentral(url); return centralStatus(); },
  /** Unlock (on the 'finish' screen it also finishes an earlier version's update, then the neuron starts). */
  async unlock(passphrase) {
    if (state.screen === 'finish') {
      await finishUpdate(passphrase);
    } else {
      ready();
      await exclusive('unlock', () => unlock(passphrase));
    }
    return true;
  },
  lock() { lock(); return true; },
  /**
   * Needs Unlock, as Docker's dashboard needs login. 'identity' | 'vault' → { words, privateKey };
   * 'nostr' → { nsec, secret }; nothing → { identity, vault, nostr }.
   */
  backup(which) { ready(); return backupOf(which); },
  /** Nostr: the key, the relays and their state, the subscribed streams with the latest observation and our `_pred`. */
  async nostr() { ready(); return nostrStatus(); },
  /** The relays' stream catalog (newest per provider and stream, no tombstones); `pred` and `subscribed` marked. */
  async discover() { ready(); const list = await nostr.discover(); state.catalog = list; return list; },
  /** Subscribe to a free stream and predict it: `<stream>_pred` is published on each new observation. */
  async subscribe(pubkey, stream) { ready(); return setSubscribed(String(pubkey ?? '').trim().toLowerCase(), stream, true); },
  /** → nostr(), as setRelays. */
  async unsubscribe(pubkey, stream) { ready(); return setSubscribed(String(pubkey ?? '').trim().toLowerCase(), stream, false); },
  /** Our `<stream>_pred` history for a relay stream, newest first: { seq, value, model, obs_seq, made_at, event_id, relays }. */
  async relayPredictions(pubkey, stream, limit = 20) {
    ready();
    return (await db.relayPredictions(relayUuid(String(pubkey ?? '').trim().toLowerCase(), String(stream ?? '')), limit))
      .map(({ stream_uuid, ...p }) => p);
  },
  /** Settings: { relays: ['wss://…'], centralWrite: boolean }, either or both. → nostr() */
  async setRelays(settings) { ready(); const s = await nostr.setRelays(settings); await refreshNostr(); return s; },
  /** Base: a fresh read of the chain (one multicall) and the last batch. */
  async base() { ready(); await base.refresh(); return base.status(); },
  /** Delegate the vault's prediction power to the identity (needs Unlock). → { steps: [{ step, by, hash }], settled } */
  async delegate() { ready(); return baseAction('delegate', () => base.delegate()); },
  /** Stop delegating (needs Unlock): SATORI stays transfer-locked through the next round. */
  async undelegate() { ready(); return baseAction('undelegate', () => base.undelegate()); },
  /** hub.claim(), the merkle drop, the airdrop, from the vault (needs Unlock). → { rewards, merkle, airdrop } */
  async claim() { ready(); return baseAction('claim', () => base.claim()); },
  /** The identity's daily batch now, if this round has none yet. → the check's result */
  async predictBase() { ready(); const r = await base.predict(); await refreshBase(); return r; },
  /** From the vault (needs Unlock): { asset: 'ETH' | 'SATORI', to: '0x…', amount: '1.5' } → { hash } */
  async send(o) { ready(); return baseAction('send', () => base.send(o)); },
  /** The Base RPC: an https URL, a same-origin path, or '' for the default. → base() */
  async setBaseRpc(url) { ready(); return base.setSettings({ rpc: url }); },
  /** The unattended batch's ceiling on the max fee per gas, in gwei (null or '' = the default, 2). → base() */
  async setBaseMaxFee(gwei) { ready(); return base.setSettings({ maxFee: gwei }); },
};

async function boot() {
  const root = document.getElementById('app');
  root.replaceChildren(); // index.html's "Opening…", painted before any module loads
  render(root, actions);
  startPwa();
  if (!(await claimTab())) return void (state.screen = 'elsewhere');
  try {
    db = await openOpfsDb();
    state.recovered = db.recovered; // a WAL DuckDB could not replay, set aside (docs/design/storage.md#recovery)
    record = (await db.get('keys')) ?? null; // an earlier version's rows were translated by migration 7
    if (!record) return void (state.screen = 'setup');
    // an earlier version's vault whose public key was not in clear: the neuron needs it (register, the Base address)
    if (!loadKeys(record).vault.pubkey) return void (state.screen = 'finish');
    await startNeuron();
  } catch (err) {
    state.fatal = `The neuron did not start: ${err?.message ?? err}`;
    state.screen = 'fatal';
  }
}

boot();
