// App wiring: one tab → open the database → Setup, or Home with the neuron
// running on the identity key from page load: register with central, then
// poll on Satori Lite's schedule (docs/design/central.md), and follow the
// subscribed Nostr streams, publishing `<stream>_pred` (docs/design/nostr.md),
// and the identity's daily batch on Base (docs/design/base.md).
// Unlock/Lock open and wipe the vault; the neuron never needs it (Base's
// Stake, claims and sends do). The keys are one record of this app's own
// (meta `keys`, docs/design/keys.md); Base is the only chain shown.
// window.satori is the same surface for agents (public/llms.txt). The
// installed app (service worker, Install, persistent storage) is src/pwa/.
import { version } from '../package.json';
import { watch } from '@arrow-js/core';
import { state, render, TABS } from './ui/view.js';
import { pickIndexes } from './ui/format.js';
import { openOpfsDb, hasDatabase, setAsideOpfsDb } from './db/opfs.js';
import {
  generateSecret, secretFromWords, wordsOf, newKeys, readDockerFiles, loadKeys, unlockVault, passphraseOk, MIN_PASSPHRASE,
  withPassphrase, backupKeys, IMPORT_MAX,
} from './keys/index.js';
import { createAutoLock } from './keys/autolock.js';
import { nostrSecretOf } from './nostr/event.js';
import { createCentral } from './central/index.js';
import { cycle, register, createPoller, centralStatus as statusOf, claimTab, firstPollAt } from './neuron/index.js';
import { catchUpAll } from './neuron/schedule.js';
import { modelsOf, modelDetail, toggleDest, DESTS } from './neuron/models.js';
import { createTrainer } from './neuron/train.js';
import { createRetrain } from './neuron/retrain.js';
import { box as modelBox, modelHref } from './ui/models.js';
import { backfillHistory } from './neuron/history.js';
import { createNostr } from './neuron/nostr.js';
import { relayUuid } from './nostr/satori.js';
import { createBase, checkSend, NEED_GAS } from './neuron/base.js';
import { referrerOf } from './neuron/referral.js';
import { createReward } from './neuron/reward.js';
import { createActivity } from './neuron/activity.js';
import { healthOf, toneOf, CHIP_OF } from './neuron/health.js';
import { createWork, workText, leading, HERO } from './neuron/work.js';
import { createHold } from './ui/hold.js';
import { subscribe, lastTraffic } from './traffic.js';
import { createGlow } from './ui/glow.js';
import { setTheme, applyTheme } from './ui/theme.js';
import { writePref, SORT_KEY, INSTALL_KEY, snapshotOf, readSnapshot, writeSnapshot } from './ui/prefs.js';
import { isHttps } from './util.js';
import { defaultsFrom, DEV_DEFAULTS, BUILD_DEFAULTS, versionOf } from './config.js';
import { shortHash, claimLine, stepText, fmtNum } from './ui/format.js';
import { startPwa, registerWorker, applyUpdate, install, storage, keepStorage } from './pwa/index.js';

// Settings' defaults: the dev server's (the dev central, the test relay, the local fork, so a dev
// checkout writes nothing to production) or a build's, each replaceable by a VITE_* variable.
const DEFAULTS = defaultsFrom(import.meta.env, import.meta.env.DEV ? DEV_DEFAULTS : BUILD_DEFAULTS);
/* global __NEURON_VERSION__ */
/** browser-<package version>+<git short sha>, stamped by vite.config.js: register's neuron-version, Settings, status().version. */
const VERSION = typeof __NEURON_VERSION__ === 'string' ? __NEURON_VERSION__ : versionOf(version);
state.version = VERSION;
const DEFAULT_CENTRAL = DEFAULTS.central;

let db;
let dbOpening = null; // the database's open, begun at boot: a first visit's Setup runs meanwhile, and its keys wait for it
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
const invitedBy = referrerOf(location.search); // an invite link's ?ref= (docs/design/base.md#referral-invite-links), read once at load
let reward = null; // the reward address, as the Satori Network keeps it (src/neuron/reward.js): read when Settings opens
let activity = null; // the activity log Home's health reads (docs/design/health.md)
let trainer = null; // the training pass (src/neuron/train.js): every model's current fit, from stored history
let retrain = null; // Retrain (src/neuron/retrain.js): a model trained on until it beats no change, as the user asked
let afterUnlock = null; // the action an inline Unlock prompt was opened for
const nowS = () => Date.now() / 1000;
/** What the neuron is doing now (src/neuron/work.js): Home's hero and action lines, and health().work. */
const work = createWork({ onChange: () => { state.work = work.all(); } });

/** status().central: central's state, and the reward address as last read ({ address, at, error, reading }). */
const centralStatus = async () => ({ ...(await statusOf({ db, central, registration, poller })), reward: reward?.status ?? null });

async function refresh() {
  state.central = await centralStatus();
  state.streams = await db.streams();
  state.sparks = await db.sparks();
  if (state.streamOpen) state.streamPreds = await db.predictions(state.streamOpen, 10);
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
/**
 * The track record (docs/design/track-record.md): records() and the open stream's record(), read again when a watched
 * stream gets an observation, only while Streams shows, at most about once a second.
 */
const recordOf = (key) => nostr.record(key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1));
const refreshRecords = coalesce('records', async () => {
  if (state.tab !== 'streams' || state.screen !== 'home' || !nostr) return;
  state.records = await nostr.records();
  if (state.recordOpen) state.recordDetail = await recordOf(state.recordOpen);
  await new Promise((r) => setTimeout(r, 1000));
});
const refreshBase = coalesce('base status', async () => { state.base = await base.status(); });

// ── the Models tab (docs/design/models.md) ──
/** Every model (models()), from the given statuses, each with the backtest kept with it (the training pass's for Base's older ones). */
async function listModels({ streams, nostrStatus, baseStatus }) {
  return modelsOf({ streams, subscriptions: nostrStatus.subscriptions, lastBatch: baseStatus.lastBatch, baseFits: trainer?.baseFits });
}
/**
 * The Models list, read again when central's streams, the Nostr status or the Base status change; the open model
 * with it (a poll, a `_pred` published or a Base batch may have changed it). Then the training pass, when a model lacks a
 * current fit (src/neuron/train.js: not awaited, it runs one at a time and refreshes this when it is done).
 */
const refreshModels = coalesce('models', async () => {
  modelBox.list = await listModels({ streams: state.streams, nostrStatus: state.nostr, baseStatus: state.base });
  state.modelsRev++;
  if (state.modelOpen) await loadModel(state.modelOpen);
  trainer?.run();
});
/** One model's drill-in (model(id)), from the given statuses: recomputed from its stored spec and history. */
const detailOf = (id, { streams, nostrStatus, baseStatus }) => modelDetail({ db, id, streams, subscriptions: nostrStatus.subscriptions,
  lastBatch: baseStatus.lastBatch, baseHistory: (streamId) => base.history(streamId) });
/** A central model's uuid from an id as models() gives it ('central:<uuid>'), its bare uuid or its name; else null. */
function centralUuid(id) {
  const s = String(id ?? '');
  if (/^(nostr|base):/.test(s)) return null;
  const key = s.replace(/^central:/, '');
  return state.streams.find((r) => r.uuid === key || r.name === key)?.uuid ?? null;
}
/** model(id).retrain: whether Retrain is offered, and the runner's status ({ running, waiting, after, tried, best, result }). */
const retrainOf = (d) => {
  const uuid = d.source === 'central' ? d.id.slice('central:'.length) : null;
  const s = uuid && retrain ? retrain.status(uuid) : { running: false, waiting: null, after: null, tried: 0, best: null, result: null };
  return { available: d.retrain.available, why: d.retrain.why, ...s, result: s.result ?? d.retrain.last };
};
let modelAsked = 0; // the latest drill-in asked for wins
/** The open model, (re)computed; its error is shown in place. */
async function loadModel(id) {
  const n = ++modelAsked;
  try {
    const d = await detailOf(id, { streams: state.streams, nostrStatus: state.nostr, baseStatus: state.base });
    if (n !== modelAsked || state.modelOpen !== id) return;
    if (d) console.info(`[satori] model ${d.id} in ${d.ms} ms`);
    modelBox.detail = d;
    state.modelError = d ? '' : `No such model: ${id}. It may not have predicted yet.`;
  } catch (err) {
    if (n !== modelAsked) return;
    modelBox.detail = null;
    state.modelError = `This model could not be opened: ${err?.message ?? err}`;
  }
  state.modelRev++;
}
let listScroll = 0; // the list's scroll, kept while a model is open
let fromList = false; // the open model was opened from the list: its back link is the browser's back

// ── core: used by the UI and by window.satori ───────────────────────────────

/** The stored (or default) central; a new client means a new register result. */
async function connect() {
  const url = (await db.get('central_url')) || DEFAULT_CENTRAL;
  central = createCentral({ url, identity, version: VERSION });
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
 * run after it). Never throws. The screen is read again by the caller (the
 * cycle does at its end), not here: the poll waits for this.
 */
const backfill = coalesce('history', () => work.run('central', async (step) => {
  const t0 = nowS();
  const r = await backfillHistory({ db, central, onProgress: (done, total) => step('history', done, total) });
  if (r?.streams) console.info('[satori] central history', r);
  if (r?.at >= t0) await activity.history(r); // this run's, not the last one's kept result
}));

/** A poll (createPoller's run): its steps are central's work on Home, which ends once the next poll is armed. */
async function runCycle(report) {
  // the last register failed: again before each poll until it succeeds (Lite registers on every start, and restarts daily)
  if (!registration?.ok) {
    report('register');
    await registerWith(central);
  }
  // never throws: errors are in r and in the status; seed: the identity draws each target's spec
  const r = await cycle({ db, central, seed: identity.pubkey, backfill, report });
  console[r.poll.error || r.submit?.error ? 'warn' : 'info']('[satori] central cycle', r);
  await refresh();
  await activity.central(r, state.central.pending); // Home still shows the last step, then the answer (src/ui/hold.js)
  return r;
}

async function startNeuron() {
  ({ identity, nostr: nostrKey, vault: vaultPublic } = loadKeys(record));
  state.identity = identity.evmAddress;
  state.vault = vaultPublic.evmAddress;
  state.centralDefault = DEFAULT_CENTRAL;
  state.backupAt = (await db.get('backup_at')) ?? null;
  activity = createActivity({ db, onChange: () => { state.activityRev++; } });
  await activity.start(); // this session, and whether a poll came due while Satori was closed
  // the training pass: what the screen shows is what it trains (it waits for central's work); the list read again after it
  trainer = createTrainer({ db, work, baseHistory: (streamId) => base.history(streamId),
    read: async () => ({ streams: state.streams, subscriptions: state.nostr.subscriptions, lastBatch: state.base.lastBatch }),
    after: async (r) => {
      console.info('[satori] training pass', r);
      if (r.central) await refresh();
      if (r.nostr) await refreshNostr();
      await refreshModels();
    } });
  // Retrain (docs/design/models.md#retrain): one at a time, waiting for central's work; the list read again after each
  retrain = createRetrain({ db, work, seed: () => identity.pubkey, nameOf: (u) => state.streams.find((r) => r.uuid === u)?.name ?? u,
    onChange: () => {
      modelBox.retrains = retrain.all();
      state.retrainRev++;
    },
    after: async (uuid, result) => {
      console.info('[satori] retrain', uuid, result);
      await refresh();
      await refreshModels();
    } });
  state.now = nowS();
  const c = await connect();
  reward = createReward({ central: () => central, work, identity: identity.evmAddress, vault: vaultPublic.evmAddress,
    onChange: (st) => { state.reward = st; } });
  poller = createPoller(runCycle, { db, work, onChange: ({ next, running }) => {
    state.now = nowS(); // Home's "next try in 2 min" from now, not from the last 30 s tick (it read 3 min)
    state.central = { ...state.central, nextPoll: next, polling: running };
  } });
  await refresh();
  nostr = createNostr({ db, key: nostrKey, walletPubkey: identity.pubkey, central: () => central, ws: import.meta.env.DEV, // csp.js: only the dev page allows ws:
    defaults: { relays: DEFAULTS.relays, centralWrite: DEFAULTS.centralWrite, wss: DEFAULTS.wss }, // wss: relays' stand-ins (config.js)
    onChange: refreshNostr, onPublished: () => activity.published(), onError: (err) => activity.error('nostr', err),
    onRecords: refreshRecords, work,
    // paid streams (docs/design/market.md): the identity signs and settles, the vault is paid and funds a Buy, on Base's chain
    identity, vaultAddress: vaultPublic.evmAddress, vault: () => vault, chain: () => base.channels() });
  await refreshNostr();
  base = createBase({ db, identity, vaultAddress: vaultPublic.evmAddress, vault: () => vault, central: () => central, defaultRpc: DEFAULTS.rpc,
    onChange: refreshBase, onCheck: (r) => activity.base(r), onConfigDiffers: (keys, url) => activity.configDiffers(keys, url), work });
  if (invitedBy) await base.holdReferrer(invitedBy); // the invite link's ?ref=, kept until Stake registers it
  await refreshBase();
  // when a poll is due (a new neuron, or one reopened late) it runs at once, after register: signing in is its first
  // step on Home, set before Home shows
  const signIn = firstPollAt(await db.get('next_poll_at'), nowS()) <= nowS() ? work.start('central') : null;
  signIn?.step('register');
  Object.assign(state, { screen: 'home', cached: null }); // live: the last visit's Home gives way
  fillSettings();
  keepStorage(); // after setup and on each load until the browser keeps it: the keys live in this storage
  // register, as Lite does, then the schedule: a new neuron or a due poll polls at once, a time still ahead is kept
  registerWith(c).catch((err) => console.error('[satori] register', err))
    .then(() => poller.start()).catch((err) => console.error('[satori] poll schedule', err)).finally(() => signIn?.end());
  backfill().then(refresh).catch((err) => console.error('[satori] history', err)); // streams with no history yet get it now, not at the first poll
  nostr.start().catch((err) => console.error('[satori] nostr start', err));
  base.start();
  wakeUps();
  if (state.modelOpen) loadModel(state.modelOpen); // a link to a model (#models/<id>), now that every flow is up
  retrain.resume().catch((err) => console.error('[satori] retrain resume', err)); // pending work: a retrain asked before continues
}

/**
 * The heartbeat, and every wake (docs/plans/runtime.md#catch-up-pass): the session's heartbeat first (a late one means
 * the page did not run: a new session, *Was asleep*), then the catch-up pass. Browser timers don't count the time a
 * device sleeps, so every job whose time has passed and isn't running runs now: the poll, the Base batch check, the
 * relays' reconnects and hourly pass, and the training pass. Each job's own single flight keeps it from running twice.
 */
async function tick(why) {
  state.now = nowS();
  autoLock.check(); // a device that slept past the vault's deadline locks it now
  await activity.beat();
  catchUpAll({ poll: poller.catchUp, base: base.catchUp, relays: nostr.catchUp, train: () => void trainer.run() }, why);
}
function wakeUps() {
  setInterval(() => void tick('tick'), 30_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void tick('visible'); });
  document.addEventListener('resume', () => void tick('resume')); // a frozen tab, thawed (Page Lifecycle)
  addEventListener('pageshow', (e) => { if (e.persisted) void tick('pageshow'); }); // back from the back-forward cache
  addEventListener('online', () => {
    poller.online()?.catch((err) => console.error('[satori] poll', err)); // after a failed cycle, the poll now: no 2 min wait
    void tick('online');
  });
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
  if (url && !isHttps(url)) throw new Error('The Satori Network server must be an https:// address.');
  const moved = (url || DEFAULT_CENTRAL) !== central.url;
  if (moved) {
    await poller.idle(); // its rows are the old central's
    await db.resetCentral();
    reward.reset(); // that one's reward address is not known yet, and the last one's words go with it
    Object.assign(state, { rewardDone: '', rewardError: '' });
  }
  await db.set('central_url', url);
  if (moved) await activity.setting('central', url, url ? undefined : DEFAULT_CENTRAL); // Home notes it for 24 h
  await db.checkpoint();
  const c = await connect();
  await refresh();
  await registerWith(c);
  await nostr.reconcile(); // this central's relays
  await base.refresh(); // this central's Base config
  readReward();
}

/** The reward address read now; the last save's words go, as they may no longer hold (it may have changed elsewhere). */
function readRewardNow() {
  state.rewardDone = '';
  return reward.read();
}

/** The reward address, read from the Satori Network once Settings shows it: once per page load and central, again after a failed read. */
function readReward() {
  if (state.tab === 'settings' && reward && !reward.known && !reward.status.reading) void readRewardNow();
}

/**
 * Set the reward address (a 0x address) or clear it (null or ''), from Settings or an agent (docs/design/central.md#the-reward-address):
 * signed in by the identity, no vault; one at a time. A change is logged, so Home notes it for 24 h. → its status
 */
const setReward = (address) => exclusive(address == null || !String(address).trim() ? 'clear' : 'save', async () => {
  state.rewardDone = '';
  const r = await reward.set(address);
  if (r.changed) await activity.setting('reward', r.address ?? '');
  state.rewardDone = !r.address ? 'Cleared: rewards go to your vault.'
    : `Saved: the Satori Network sends this neuron's rewards to ${r.address}${r.whose === 'vault' ? ', your vault' : ''}.`;
  return reward.status;
}, 'rewardBusy');

/**
 * The Base RPC and the max fee (Settings, agents): base.setSettings, and a changed RPC is logged, so Home notes it for
 * 24 h (the security review, 2026-10-19). → base's status
 */
async function setBaseSettings(o) {
  const before = (await db.get('base_rpc_url')) || '';
  const s = await base.setSettings(o);
  if (o.rpc !== undefined && s.rpcSetting !== before) await activity.setting('rpc', s.rpcSetting, s.rpcSetting ? undefined : s.rpc[0]);
  return s;
}

/** The keys record, stored in one commit (each commit is checkpointed: docs/design/storage.md); critical work. */
const storeKeys = (r) => work.run('keys', async (step) => {
  step('save');
  await db.set('keys', r);
  await db.checkpoint();
  record = r;
});

/**
 * The keys, then the neuron; backedUp: the vault's words were confirmed, given or brought (docs/design/health.md). On a
 * first visit the database may still be loading: Setup says "Finishing setup… downloading the engine, 3.2 of 7.6 MB".
 */
async function saveKeys(r, { backedUp = false } = {}) {
  state.setupWaiting = true; // until Home: the engine's step, then "saving your keys…"
  try {
    db ??= await dbOpening;
    await storeKeys(r);
    if (backedUp) await markBackup();
    await startNeuron();
  } finally {
    state.setupWaiting = false;
  }
}

/** The vault's backup is confirmed (meta.backup_at): Home stops asking for it while storage is not kept. */
async function markBackup() {
  if (state.backupAt) return;
  state.backupAt = nowS();
  await db.set('backup_at', state.backupAt);
  await db.checkpoint();
}

async function unlock(passphrase) {
  const count = lockCount;
  const { vault: v, record: upgraded } = await unlockVault(record, passphrase);
  if (upgraded) await storeKeys(upgraded); // an earlier version's vault, now in this app's format (keys.md#migration)
  if (count !== lockCount) return void v.lock();
  vault?.lock();
  vault = v;
  state.unlocked = true;
  state.unlockFor = '';
  autoLock.start();
}

/** Lock: the vault wiped from memory, and any backup on screen hidden. */
function lock() {
  lockCount++;
  vault?.lock();
  vault = null;
  afterUnlock = null;
  autoLock.stop();
  Object.assign(state, { unlocked: false, unlockFor: '', backup: '', backupWords: '', backupKey: '', backupHex: '', backupAsk: '', backupError: '' });
}

/**
 * The vault locks on its own (docs/design/keys.md#the-vault-locks-on-its-own): 5 minutes after the last interaction (a
 * key, a tap, the wheel, a vault action) while it is unlocked or a backup is on screen, never in the middle of a vault
 * action, and at once on a wake past the deadline. An action an inline Unlock was opened for locks it when it ends.
 */
const autoLock = createAutoLock({ onLock: () => lock(), busy: () => !!state.baseBusy || !!state.busy || state.revealing,
  onChange: (at) => Object.assign(state, { lockAt: at, lockNow: Date.now() }) });
for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, () => autoLock.touch(), { capture: true, passive: true });
setInterval(() => { if (state.lockAt) state.lockNow = Date.now(); }, 15_000); // "Locks in 4 min" by Lock

/** An earlier version's vault with no public key in clear: its first Unlock stores it in this app's format, then the neuron starts. */
async function finishUpdate(passphrase) {
  await exclusive('unlock', () => unlock(passphrase));
  await startNeuron();
}

/**
 * One key's backup ({ words, privateKey }, or the Nostr key's { nsec, secret }), or all three (which null or undefined),
 * from the passphrase each time, unlocked or not (keys' backupKeys: ~0.3 s; docs/design/keys.md#backup).
 */
async function backupOf(which, passphrase) {
  const b = await backupKeys(record, which, passphrase);
  markBackup().catch((err) => console.warn('[satori] backup_at', err)); // shown: the backup is confirmed
  return b;
}

/**
 * "Set aside and start again" (the database file won't open, docs/design/storage.md#recovery): the file renamed, never
 * deleted; a fresh database; Setup, which offers Restore from words and Import. The UI's button and setAside().
 */
const setAsideDb = () => exclusive('setAside', async () => {
  if (state.screen !== 'damaged') throw new Error(`Nothing to set aside (screen: ${state.screen}).`);
  state.setAsideError = '';
  try {
    state.setAside = await setAsideOpfsDb();
    console.warn('[satori] the database file that would not open was set aside as', state.setAside);
    dbOpening = openOpfsDb(undefined, { onStep: (e) => { state.engine = e; } });
    db = await dbOpening;
  } catch (err) {
    state.setAsideError = `It could not be set aside: ${err?.message ?? err}`;
    throw err;
  }
  state.engine = { step: 'ready' };
  registerWorker();
  Object.assign(state, { screen: 'setup', step: 'choose', fatal: '', cached: null });
});

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

/** A paid-stream action (docs/design/market.md), one at a time; then the relays card is read again. An interaction, as Base's. */
const marketAction = (what, fn) => exclusive(what, fn, 'marketBusy').finally(() => {
  autoLock.touch();
  void refreshNostr();
});

/** A Base action, one at a time; then the card is read again. It counts as an interaction (the vault's 5 minutes). */
const baseAction = (what, fn) => exclusive(what, fn, 'baseBusy').finally(() => {
  autoLock.touch();
  void refreshBase();
});

/** The vault's Base actions (Unlock), for the UI and agents alike; the activity log says what each did. */
const vaultOps = {
  async delegate() {
    const r = await base.delegate();
    if (r.steps.length) activity.wallet('stake', 'Staked with this neuron');
    return r;
  },
  async undelegate() {
    const r = await base.undelegate();
    if (r.steps.length) activity.wallet('unstake', 'Unstaked');
    return r;
  },
  async claim() {
    const r = await base.claim();
    const sum = [r.rewards, r.merkle, r.airdrop].filter((x) => x?.hash).reduce((n, x) => n + Number(x.amount), 0);
    if (sum > 0) activity.wallet('claim', `Claimed ${fmtNum(sum)} SATORI`);
    return r;
  },
  /** { asset, to, amount, passphrase }: the inputs checked first, then the vault opened from the passphrase for this send alone. */
  async send(o = {}) {
    const { asset, amount } = checkSend(o);
    const r = await withPassphrase(record, o.passphrase, (v) => base.send(o, v));
    activity.wallet('send', `Sent ${amount} ${asset} from the vault`);
    return r;
  },
};

/**
 * Setup, from the UI or an agent: one at a time, and only on the Setup screen. `makeRecord` → the keys, or null (not
 * yet). backedUp: the vault's words were confirmed (Create), given (Restore) or brought (a Dockerized Neuron's files).
 */
const setup = (makeRecord, { backedUp = false } = {}) => exclusive('setup', async () => {
  if (state.screen !== 'setup') throw new Error(`Already set up (screen: ${state.screen}).`);
  const r = await makeRecord();
  if (r) await saveKeys(r, { backedUp });
});

// ── tabs (hash routes) and the inline Unlock ──

/** A route ('#models/central:…', 'settings') → { tab, model } (tab null: none such; model '': the list). */
function routeOf(where) {
  const [t, ...rest] = String(where ?? '').replace(/^#/, '').split('/');
  const model = t === 'models' && rest.length ? decodeURIComponent(rest.join('/')) : '';
  return { tab: TABS.includes(t) ? t : null, model };
}

/** Open a model's drill-in ('' closes it): its route's data, computed now; the list's scroll kept for the way back. */
function showModel(id) {
  if (id === state.modelOpen) return;
  if (id && !state.modelOpen) listScroll = scrollY;
  const back = !id && state.modelOpen;
  fromList = false;
  Object.assign(state, { modelOpen: id, modelOutput: 0, modelHover: null, modelError: '', retrainError: '' });
  modelBox.detail = null;
  state.modelRev++;
  if (id && db) loadModel(id);
  requestAnimationFrame(() => scrollTo(0, back ? listScroll : 0));
}

/**
 * Show a tab (#home, #models, #streams, #wallet, #settings) and, given one, scroll to its section
 * (#settings-<section>); 'models/<id>' opens a model's drill-in.
 */
function go(where, section) {
  const { tab, model } = routeOf(where);
  if (!tab) throw new Error(`No such tab: ${where}. One of ${TABS.join(', ')}, or models/<id>.`);
  const hash = model ? modelHref(model) : `#${tab}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  const changed = state.tab !== tab;
  const opened = tab === 'models' && model !== state.modelOpen; // showModel scrolls
  if (changed && tab === 'models') state.modelTo = [...DESTS]; // a visit to the tab: every filter on (not kept)
  state.tab = tab;
  if (changed) fillSettings();
  if (tab === 'models') showModel(model);
  requestAnimationFrame(() => {
    const el = section && document.getElementById(`${tab}-${section}`);
    if (el) el.scrollIntoView({ block: 'start' });
    else if (changed && !opened) scrollTo(0, 0);
  });
  return model ? `models/${model}` : tab;
}
addEventListener('popstate', () => {
  const { tab, model } = routeOf(location.hash);
  if (tab === 'models' && state.tab !== 'models') state.modelTo = [...DESTS]; // a visit to the tab: every filter on
  state.tab = tab ?? 'home';
  if (state.tab === 'models') showModel(model);
  fillSettings();
});

/** Settings' forms show what is stored, each time the tab opens (typing there is kept until it closes); the reward address is read. */
function fillSettings() {
  if (state.tab !== 'settings' || !nostr || !base) return;
  actions.fillRelays(document.querySelector('form.relays-form'));
  actions.fillBase(document.querySelector('form.base-rpc-form'));
  readReward();
}

/** Run `fn` now if the vault is open; else open the inline Unlock prompt at `slot`, and run it after Unlock. */
function withVault(slot, fn) {
  if (vault) return fn();
  afterUnlock = fn;
  Object.assign(state, { unlockFor: slot, unlockError: '' });
  requestAnimationFrame(() => document.querySelector(`[data-unlock-for="${slot}"] input`)?.focus());
  return undefined;
}

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
  Object.assign(state, { baseResult: '', baseTxs: [], baseDid: what });
  const { text, txs = [] } = await baseAction(what, fn);
  Object.assign(state, { baseResult: text, baseTxs: txs });
})();

const stepTxs = (steps) => steps.map((x) => ({ label: stepText(x.step), title: `${x.step} by the ${x.by}`, hash: x.hash }));
const claimTxs = (r) => [['Rewards', r.rewards], ['Merkle', r.merkle], ['Airdrop', r.airdrop]]
  .filter(([, x]) => x?.hash).map(([label, x]) => ({ label, hash: x.hash }));

const actions = {
  goStep,
  setTheme(t) { state.theme = setTheme(t); },
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
    }, { backedUp: true }); // reached only after the words were confirmed, typed in, or brought as files
  }),
  /**
   * Dockerized Neuron files: decrypted with the Docker vault password and translated into this app's
   * record. The same password becomes this app's passphrase when it meets the rule and `reuse` is ticked;
   * otherwise the passphrase step asks for one.
   */
  importDocker: shownAt('error', async (el) => {
    const f = new FormData(el);
    await setup(async () => {
      for (const [field, name] of [['wallet', 'wallet.yaml'], ['vault', 'vault.yaml'], ['nostr', 'nostr.yaml']]) {
        if (f.get(field)?.size > IMPORT_MAX) throw new Error(`${name}: over 64 KB, so not a Dockerized Neuron file.`); // not read at all
      }
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
    }, { backedUp: true });
  }),
  /** Settings' Unlock; an action asked for meanwhile (its inline prompt open) runs after it, and the vault stays unlocked. */
  unlock: shownAt('vaultError', async (f, el) => actions.unlockAndRun(f, el)),
  /** The inline prompt: Unlock, then the action it was opened for, then Lock again (it was unlocked for that alone). */
  unlockThen: shownAt('unlockError', async (f, el) => actions.unlockAndRun(f, el, { inline: true })),
  async unlockAndRun(f, el, { inline = false } = {}) {
    await exclusive('unlock', () => unlock(f.pass));
    el.reset();
    const fn = afterUnlock;
    afterUnlock = null;
    if (!fn) return;
    try {
      await fn();
    } finally {
      if (inline) lock();
    }
  },
  cancelUnlock() {
    afterUnlock = null;
    Object.assign(state, { unlockFor: '', unlockError: '' });
  },
  go,
  /** Models: open a model's drill-in (#models/<id>). */
  openModel(id) {
    const listed = state.tab === 'models' && !state.modelOpen;
    go(`models/${id}`);
    fromList = listed;
  },
  /** Back to the list: the browser's back when the list is the page before, else to #models. */
  closeModel() {
    if (fromList) history.back();
    else go('models');
  },
  /** The open model's Retrain button: 'retrain' asks for one (kept, then run), 'stop' ends it (docs/design/models.md#retrain). */
  async retrainModel(action) {
    const d = modelBox.detail;
    const uuid = d?.source === 'central' ? d.id.slice('central:'.length) : null;
    if (!uuid || !retrain) return;
    state.retrainError = '';
    try {
      if (action === 'stop') retrain.stop(uuid);
      else await retrain.start(uuid);
    } catch (err) {
      state.retrainError = err?.message ?? String(err);
    }
  },
  /** The Models list's filters (where predictions go: a tap turns one off or on, the last stays on) and sort; the sort is kept on this device. */
  setModelView({ to, sort }) {
    if (to) state.modelTo = toggleDest(state.modelTo, to);
    if (sort) {
      state.modelSort = sort;
      writePref(SORT_KEY, sort);
    }
  },
  /** Streams: a stream's detail (its trend, its model, its latest predictions), or none (''). */
  /** A prediction stream's detail on Streams (its record, with its pairs), in place under its row; '' closes it. */
  async openRecord(key) {
    Object.assign(state, { recordOpen: key, recordDetail: null, recordError: '' });
    if (!key) return;
    try {
      const r = await recordOf(key);
      if (state.recordOpen === key) Object.assign(state, r ? { recordDetail: r } : { recordError: 'No longer watched.' });
    } catch (err) {
      if (state.recordOpen === key) state.recordError = `Its record could not be read: ${err?.message ?? err}`;
    }
  },
  async openStream(uuid) {
    state.streamOpen = uuid;
    state.streamPreds = uuid ? await db.predictions(uuid, 10) : [];
  },
  /** Home's action card: its one button (docs/design/health.md#reasons-in-priority-order). */
  act(a) {
    if (!a) return;
    if (a.do === 'reload') location.reload();
    else if (a.do === 'poll') actions.pollNow();
    else if (a.do === 'install') actions.install();
    else if (a.do === 'dismiss') actions.dismissAdvice(a.id);
    else if (a.do === 'stake') withVault('card', actions.baseDelegate);
    else if (a.do === 'backup') {
      go('settings', 'backup');
      actions.askBackup('vault');
    } else if (a.do === 'go') go(a.tab, a.section);
  },
  finishUpdate: shownAt('vaultError', async (f, el) => {
    await finishUpdate(f.pass);
    el.reset();
  }),
  lock,
  /** Backup's buttons: the passphrase is asked each time, in place (docs/design/keys.md#backup). */
  askBackup(which) {
    Object.assign(state, { backupAsk: which, backupError: '' });
    requestAnimationFrame(() => document.querySelector('[data-test=backup-prompt] input')?.focus());
  },
  cancelBackup() { Object.assign(state, { backupAsk: '', backupError: '' }); },
  /** The passphrase typed: the key's backup shown, for 5 minutes without interaction at most. */
  showBackup: shownAt('backupError', async (f, el) => {
    const which = state.backupAsk;
    state.revealing = true;
    try {
      const b = await backupOf(which, f.pass);
      el.reset();
      Object.assign(state, { backupAsk: '', backup: which, backupWords: b.words ?? '', backupKey: b.privateKey ?? b.nsec, backupHex: b.secret ?? '' });
      if (autoLock.lockAt == null) autoLock.start();
      else autoLock.touch();
    } finally {
      state.revealing = false;
    }
  }),
  hideBackup() {
    Object.assign(state, { backup: '', backupWords: '', backupKey: '', backupHex: '' });
    if (!vault) autoLock.stop();
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
  /** Home's Install card put away (Not now, Got it): once, on this device (docs/design/pwa.md#install). */
  dismissAdvice(id) {
    if (id !== 'install') return;
    state.installDismissed = true;
    writePref(INSTALL_KEY, 'dismissed');
  },
  update: applyUpdate,
  dismissNotice() { state.noticeDismissed = true; },
  setAside: () => setAsideDb().catch((err) => console.error('[satori] set aside', err)),
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
  /** Paid streams (docs/design/market.md): a price on one of our `_pred`s, free again, Buy (the vault: Unlock in place), Stop. */
  sell: shownAt('marketError', (stream, f) => marketAction(`sell:${stream}`, () => nostr.sell(stream, f.price))),
  unsell: shownAt('marketError', (stream) => marketAction(`sell:${stream}`, () => nostr.unsell(stream))),
  buy(pubkey, stream, f) {
    state.networkError = '';
    return withVault('buy', () => actions.buyNow(pubkey, stream, f.deposit));
  },
  buyNow: shownAt('networkError', (pubkey, stream, deposit) => marketAction(`buy:${pubkey}:${stream}`, () => nostr.buy(pubkey, stream, deposit))),
  stop: shownAt('marketError', (pubkey, stream) => marketAction(`stop:${pubkey}:${stream}`, () => nostr.stopBuying(pubkey, stream))),
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
  /** A vault action from the UI: Unlock first (inline, at `slot`) when the vault is locked. */
  vaultAction(slot, name) {
    if (name === 'baseClaim' && state.base.vault.lowEth) { // a claim is a vault transaction: said before trying (and before Unlock)
      return void Object.assign(state, { baseDid: 'claim', baseResult: '', baseTxs: [], baseError: NEED_GAS });
    }
    return withVault(slot, () => actions[name]());
  },
  baseDelegate: () => baseUi('stake', async () => {
    const r = await vaultOps.delegate();
    return { text: r.steps.length ? 'Staked with this neuron.' : 'Already staked with this neuron.',
      txs: stepTxs(r.steps) };
  }),
  baseUndelegate: () => baseUi('unstake', async () => {
    const r = await vaultOps.undelegate();
    return { text: r.steps.length ? 'Unstaked.' : 'Not staked.', txs: stepTxs(r.steps) };
  }),
  baseClaim: () => baseUi('claim', async () => {
    const r = await vaultOps.claim();
    return { text: [claimLine('Rewards', r.rewards), claimLine('Merkle', r.merkle), claimLine('Airdrop', r.airdrop)].join(' · '),
      txs: claimTxs(r) };
  }),
  /**
   * Send, step one: the review (docs/design/base.md#send-the-passphrase-each-time): the recipient in full, the amount and the asset, the
   * estimated fee; SATORI that can't be sent is said here, before the passphrase.
   */
  reviewSend: shownAt('baseError', async (f) => {
    Object.assign(state, { baseDid: 'send', baseResult: '', baseTxs: [], sendQuoting: true });
    try {
      state.sendReview = await base.quoteSend({ asset: f.asset, to: f.to, amount: f.amount });
    } finally {
      state.sendQuoting = false;
    }
    requestAnimationFrame(() => document.querySelector('[data-test=send-review] input')?.focus());
  }),
  /** Back to the form, as it was typed. */
  backSend() { Object.assign(state, { sendReview: null, baseError: '' }); },
  /** Step two: Send, with the vault's passphrase (asked each time, unlocked or not). */
  confirmSend: (f, el) => baseUi('send', async () => {
    const q = state.sendReview;
    const r = await vaultOps.send({ asset: q.asset, to: q.to, amount: q.amount, passphrase: f.pass });
    el.reset();
    document.querySelector('form.send')?.reset();
    state.sendReview = null;
    return { text: `Sent ${q.amount} ${q.asset}.`, txs: [{ label: `${q.asset} to ${shortHash(q.to)}`, hash: r.hash }] };
  }),
  /** What is stored, not the defaults (those are the placeholders). */
  fillBase(el) {
    el.elements.rpc.value = state.base.rpcSetting;
    el.elements.maxFee.value = state.base.maxFeeSetting ?? '';
  },
  saveBase: shownAt('baseRpcError', async (f, el) => {
    state.base = await setBaseSettings({ rpc: f.rpc, maxFee: f.maxFee });
    actions.fillBase(el);
  }),
  saveCentral: shownAt('settingsError', async (f, el) => {
    await setCentral(f.url);
    el.reset();
  }),
  /** Settings › Reward address: Save (the address typed), Clear, and Try again after a failed read. */
  saveReward: shownAt('rewardError', async (f, el) => {
    await setReward(f.address);
    el.reset();
  }),
  clearReward: shownAt('rewardError', () => setReward(null)),
  readReward: () => void (reward && readRewardNow()),
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
      version: VERSION, // browser-<package version>+<git short sha>
      identity: state.identity || null,
      vault: state.vault || null,
      unlocked: state.unlocked,
      lockAt: state.lockAt, // when the vault locks on its own (ms), or null

      central: home ? await centralStatus() : null,
      nostr: home ? await nostrStatus() : null,
      base: home ? await base.status() : null,
      storage: await storage(),
      app: { ...state.app },
      recovered: state.recovered,
      setAside: state.setAside, // a database file that would not open, set aside under this name (this page load), or null
      // the last training pass (docs/design/models.md#the-training-pass): { central, nostr, base, stopped, ms }, or null
      train: trainer?.last ?? null,
    };
  },
  /** Chromium's install prompt, when offered (status().app.canInstall; needs a user gesture). → 'accepted' | 'dismissed' | 'unavailable' */
  install() { return install(); },
  /** When status().app.update: the new version takes over and the page reloads. → false if none is waiting */
  update() { return applyUpdate(); },
  /**
   * On the 'damaged' screen (the database file won't open): set it aside (renamed, never deleted) and start again on
   * Setup, to restore from words or import. Only on the person's request: their keys are in that file. → status()
   */
  async setAside() { await setAsideDb(); return window.satori.status(); },
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
    }, { backedUp: !!vaultWords }); // given words are a backup; random ones are not until backup() shows them
    return window.satori.status();
  },
  /**
   * Home's answer (docs/design/health.md): { status: 'ok' | 'idle' | 'warn' | 'bad', tone, title, line, action, days,
   * channels: { central, base, network }, feed, reasons (each bad, warn, idle or advice: the card only), work }, read fresh.
   */
  async health() {
    ready();
    return healthOf({ now: nowS(), rows: activity.rows(), central: await centralStatus(), base: await base.status(),
      nostr: await nostrStatus(), storage: await storage(), app: { ...state.app }, backedUp: !!state.backupAt, since: since(),
      installDismissed: state.installDismissed, traffic: lastTraffic(), work: work.all() });
  },
  /**
   * Show a tab: 'home' | 'models' | 'streams' | 'wallet' | 'settings' (also #home … #settings in the URL), or a model's
   * drill-in: 'models/<id>' (#models/<id>). → the tab, or 'models/<id>'
   */
  go(tab) { return go(String(tab ?? '').replace(/^#/, '')); },
  /** Settings → Appearance: 'system' (the default: the device's light or dark), 'light' or 'dark'; kept on this device. → it */
  setTheme(theme) { state.theme = setTheme(theme); return state.theme; },
  /** Poll central now: store, forecast new rows, send what is pending. → { poll, submit } */
  async poll() { ready(); return pollNow(); },
  /** Central's streams with the latest observation, our latest prediction and the stream's spec. */
  async streams() { ready(); return (await db.streams()).map((r) => ({ ...r, meta: parseMeta(r.meta), spec: parseMeta(r.spec) })); },
  /**
   * Every model the neuron runs (docs/design/models.md): central's streams, the Base batch's, the Nostr `_pred`s; each
   * { id, source, name, kind, quality, inputs, outputs: [{ stream, name, latest, forecast, direction, influence,
   * quality, destinations }], trained } and, for central's, the spec as before. From what the Models tab shows (read
   * again after every poll, Nostr publish and Base check: poll() resolves after it), so it is cheap.
   */
  async models() {
    ready();
    return listModels({ streams: state.streams, nostrStatus: state.nostr, baseStatus: state.base });
  },
  /**
   * One model's drill-in, recomputed now from its stored spec and history: models()'s fields, `model` (kind, rows,
   * tests, step, horizon, weight, λ's, generation, accepted, coef, trained, quality), each output's `history` (the
   * chart's), `ms` and `readMs`. id: models()'s, or a central stream's uuid or name. → null when there is none
   */
  async model(id) {
    ready();
    const d = await detailOf(String(id ?? ''), { streams: state.streams, nostrStatus: state.nostr, baseStatus: state.base });
    return d && { ...d, retrain: retrainOf(d) };
  },
  /**
   * Retrain a Satori Network model (docs/design/models.md#retrain): keep training it, from stored history, until one
   * beats no change, then stop; never a prediction. Resolves when it ends (or at once with a note when its last retrain
   * looked at the same data) → model(id).retrain's status. Throws when it can't: not a Network model, no history.
   */
  async retrain(id) {
    ready();
    const uuid = centralUuid(id);
    if (!uuid) throw new Error(`Retrain is for Satori Network models for now (got ${id}).`);
    if ((await retrain.start(uuid)).running) await retrain.done(uuid);
    return retrain.status(uuid);
  },
  /** Stop a retrain: it ends at its next try and keeps the current model. → its status */
  async stopRetrain(id) {
    ready();
    const uuid = centralUuid(id);
    if (!uuid) throw new Error(`No Satori Network model: ${id}.`);
    retrain.stop(uuid);
    await retrain.done(uuid);
    return retrain.status(uuid);
  },
  /** One stream's predictions (uuid or name), newest first. */
  async predictions(stream, limit = 20) { ready(); return db.predictions(stream, limit); },
  /** Set the central URL ('' = the default) and register there. → status().central */
  async setCentral(url) { ready(); await setCentral(url); return centralStatus(); },
  /**
   * Where the Satori Network sends this neuron's rewards, read from it now (signed in by the identity). → { address: '0x…'
   * (checksummed) | null (not set: the vault), whose: 'vault' | 'identity' | null, at }; throws when it could not be read.
   */
  async rewardAddress() {
    ready();
    const st = await readRewardNow();
    if (st.error) throw new Error(st.error);
    return { address: st.address, whose: st.whose, at: st.at };
  },
  /**
   * Set the reward address (a Base 0x address, not this neuron's identity) or clear it (null or ''), signed in by the
   * identity; free. → { address, whose, at }
   */
  async setRewardAddress(address) { ready(); const st = await setReward(address); return { address: st.address, whose: st.whose, at: st.at }; },
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
   * The passphrase each time, unlocked or not (~0.3 s). 'identity' | 'vault' → { words, privateKey }; 'nostr' → { nsec,
   * secret }; null or undefined → { identity, vault, nostr }.
   */
  async backup(which, passphrase) { ready(); return backupOf(which, passphrase); },
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
  /**
   * The track record (docs/design/track-record.md): every prediction stream on the relays, watched on its own, best first:
   * [{ pubkey, stream, name, mine, source: { pubkey, stream, name }, cadence_seconds, received, scored, error, noChange,
   * ratio, mark, markText, direction: { right, total }, since, last }]. Only predictions this neuron received before the outcome count.
   */
  async records() { ready(); return nostr.records(); },
  /** One watched prediction stream's record, with `pairs`: the last 28 scored { ts, predicted, actual, baseline }; null when not watched. */
  async record(pubkey, stream) { ready(); return nostr.record(pubkey, stream); },
  /** Sell one of this neuron's `<stream>_pred` streams at `price` SATORI per observation (only on the person's request). → nostr() */
  async sell(stream, price) { ready(); return marketAction('sell', () => nostr.sell(stream, price)); },
  /** That stream free again. → nostr() */
  async unsell(stream) { ready(); return marketAction('unsell', () => nostr.unsell(stream)); },
  /**
   * Buy a stream sold on the Satori contract (only on the person's request; needs Unlock; gas): the vault opens a channel
   * with `deposit` SATORI (100 observations by default). → nostr().market.bought's entry
   */
  async buy(pubkey, stream, deposit) { ready(); return marketAction('buy', () => nostr.buy(String(pubkey ?? '').trim().toLowerCase(), stream, deposit)); },
  /** Stop buying: the identity asks to close the channel (gas, no Unlock); the rest comes back to the vault after 7 days. → the same */
  async stop(pubkey, stream) { ready(); return marketAction('stop', () => nostr.stopBuying(String(pubkey ?? '').trim().toLowerCase(), stream)); },
  /** Settings: { relays: ['wss://…'], centralWrite: boolean }, either or both. → nostr() */
  async setRelays(settings) { ready(); const s = await nostr.setRelays(settings); await refreshNostr(); return s; },
  /** Base: a fresh read of the chain (one multicall) and the last batch. */
  async base() { ready(); await base.refresh(); return base.status(); },
  /** Stake with this neuron (needs Unlock): the vault's prediction power to the identity. → { steps: [{ step, by, hash }], settled } */
  async stake() { ready(); return baseAction('stake', vaultOps.delegate); },
  /** Unstake (needs Unlock): the SATORI can be sent once the next round ends. → the same shape */
  async unstake() { ready(); return baseAction('unstake', vaultOps.undelegate); },
  /** hub.claim(), the merkle drop, the airdrop, from the vault (needs Unlock). → { rewards, merkle, airdrop } */
  async claim() { ready(); return baseAction('claim', vaultOps.claim); },
  /** The identity's daily batch now, if this round has none yet. → the check's result */
  async predictBase() { ready(); const r = await base.predict(); await refreshBase(); return r; },
  /** The review before a send, no key needed: { asset, to, amount } → { asset, to, amount, fee: { gas, about, max } } */
  async quoteSend(o) { ready(); return base.quoteSend(o); },
  /** From the vault, with its passphrase each time: { asset: 'ETH' | 'SATORI', to: '0x…', amount: '1.5', passphrase } → { hash } */
  async send(o) { ready(); return baseAction('send', () => vaultOps.send(o)); },
  /** The Base RPC: an https URL, a same-origin path, or '' for the default. → base() */
  async setBaseRpc(url) { ready(); return setBaseSettings({ rpc: url }); },
  /** The unattended batch's ceiling on the max fee per gas, in gwei (null or '' = the default, 2). → base() */
  async setBaseMaxFee(gwei) { ready(); return base.setSettings({ maxFee: gwei }); },
};

/** When this neuron began: the log's first session, or the keys' creation when earlier (records before it have none). */
const since = () => Math.min(activity.first() ?? Infinity, record?.created ?? Infinity);

/** Home's health, kept current from the log and the statuses (the UI's; agents' health() reads fresh). */
watch(() => {
  if (state.screen !== 'home' || !activity) return;
  void state.activityRev; // the log changed
  state.health = healthOf({ now: state.now, rows: activity.rows(), central: state.central, base: state.base, nostr: state.nostr,
    storage: state.storage, app: state.app, backedUp: !!state.backupAt, since: since(), installDismissed: state.installDismissed,
    work: state.work });
});

/**
 * What the neuron is doing, at a pace a person can read (src/ui/hold.js; docs/design/health.md#work): the hero (central's
 * poll, the Base batch, the vault's actions, a critical one first: its ring turns, its line says the step, its tone is
 * green, vivid while closing would lose work), the Wallet card's line (the vault's actions, there) and the network's
 * (the Network streams line, only once one lasts a second). At rest the hero turns sky green from the tone before it
 * (data-from: over 2.5 min after work, style.css); back to work, at once.
 */
const VAULT_TASKS = ['stake', 'unstake', 'claim', 'send'];
let heroWas = null; // the hero's view shown last (not read from state: the watch below would depend on what it writes)
const heroHold = createHold({ show: (v) => {
  const from = v.tone !== 'idle' ? null : heroWas?.tone === 'idle' ? heroWas.from : heroWas?.tone ?? null;
  state.hero = heroWas = { ...v, from };
} });
/** A phone (a coarse pointer, or a small screen) stops a tab as soon as it leaves the screen: the hero says so while it works. */
const PHONE = matchMedia('(pointer: coarse), (max-width: 640px)');
state.phone = PHONE.matches;
PHONE.addEventListener('change', (e) => { state.phone = e.matches; });
watch(() => {
  const h = state.health;
  if (!h) return;
  const w = leading(state.work, HERO);
  const view = { status: h.status, tone: toneOf(h.status, w), title: h.title };
  heroHold(w ? { ...view, key: `${w.task}:${w.step}`, working: true, line: workText(w, { keepOpen: state.phone }) }
    : { ...view, key: 'idle', working: false, line: h.line });
});
const lineOf = (tasks, hold) => () => {
  const w = tasks.map((t) => state.work[t]).find(Boolean);
  hold(w ? { key: `${w.task}:${w.step}:${w.done}`, working: true, line: workText(w) } : { key: 'idle', working: false, line: '' });
};
watch(lineOf(VAULT_TASKS, createHold({ show: (v) => { state.actionLine = v.line; } })));
watch(lineOf(['discover', 'subscribe'], createHold({ delay: 1000, show: (v) => { state.networkLine = v.line; } })));
watch(lineOf(['watch'], createHold({ show: (v) => { state.watchLine = v.line; } }))); // Streams › Prediction streams: the scan's step
/** Streams › Prediction streams: read when the tab shows, and when the watched set changes (nostr's status). */
watch(() => {
  void state.nostr.watching;
  if (state.tab === 'streams' && state.screen === 'home') refreshRecords();
});
watch(lineOf(['reward'], createHold({ show: (v) => { state.rewardLine = v.line; } }))); // Settings › Reward address
/** The Models tab's status: the poll's, the Base batch's, the training pass's or a Retrain's step, in Home's hero's words at its pace (no ring). */
const engineHold = createHold({ show: (v) => { state.engineWork = v.working ? { line: v.line, critical: v.critical } : null; } });
watch(() => {
  const w = leading(state.work, ['central', 'base', 'train', 'retrain']);
  engineHold(w ? { key: `${w.task}:${w.step}`, working: true, line: workText(w), critical: w.critical } : { key: 'idle', working: false, line: '' });
});
/** The Models list follows central's streams, the Nostr status and the Base status. */
watch(() => {
  void state.streams;
  void state.nostr;
  void state.base;
  if (state.screen === 'home') refreshModels();
});
/** The training pass and a Retrain wait while central's work runs (a poll, its sign-in, the history): its end runs them. */
let centralWas = false;
watch(() => {
  const now = !!state.work.central;
  if (centralWas && !now && state.screen === 'home') {
    trainer?.run();
    retrain?.wake();
  }
  centralWas = now;
});

/** Home's chips glow while their channel has real traffic (src/traffic.js, src/ui/glow.js): data-live on the chip. */
function glowChips() {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  subscribe(createGlow({ reduced: () => motion.matches,
    apply: (channel, on) => document.querySelector(`[data-test=chip][data-channel=${CHIP_OF[channel]}]`)?.toggleAttribute('data-live', on) }));
}

/**
 * The last visit's Home (docs/design/health.md#the-last-visit): painted at once on a revisit, marked "From your last
 * visit", until the neuron's own health arrives. Kept at most every 10 s while Home's health changes, and when the page
 * is hidden or left.
 */
let snapshotAt = 0;
const keepSnapshot = () => {
  if (state.screen !== 'home' || !state.health) return;
  snapshotAt = Date.now();
  writeSnapshot(snapshotOf({ health: state.health, base: state.base.config ? state.base : null, at: snapshotAt }));
};
watch(() => {
  if (state.health && state.screen === 'home' && Date.now() - snapshotAt > 10_000) keepSnapshot();
});
addEventListener('pagehide', keepSnapshot);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') keepSnapshot(); });

/**
 * The start (docs/design/storage.md#the-first-visit): DuckDB loads in the background (7.6 MB on a first visit, its
 * progress in state.engine). A first visit (no database on this origin) shows Setup at once: its first steps need no
 * database, and writing the keys waits for it. A revisit paints the last visit's Home meanwhile (Home's route only),
 * else "Opening…" with the engine's step. The service worker is registered once the database is open.
 */
async function boot() {
  const root = document.getElementById('app');
  root.replaceChildren(); // index.html's "Opening…", painted before any module loads
  const { tab, model } = routeOf(location.hash);
  if (tab) Object.assign(state, { tab, modelOpen: model });
  render(root, actions);
  applyTheme(state.theme); // public/theme.js set data-theme before the first paint; this, the browser bar's color too
  glowChips();
  startPwa();
  // one tab runs the neuron; another waits, says so, and takes over when that one closes (no reload)
  await claimTab(undefined, undefined, { onWait: () => { state.screen = 'elsewhere'; } });
  if (state.screen === 'elsewhere') state.screen = 'loading';
  const fresh = await hasDatabase().then((has) => !has, () => false); // OPFS can't say: the usual way
  dbOpening = openOpfsDb(undefined, { onStep: (e) => { state.engine = e; } });
  dbOpening.catch(() => {}); // boot's own await reports it
  if (fresh) state.screen = 'setup';
  else if (state.tab === 'home') state.cached = readSnapshot();
  try {
    db = await dbOpening;
    state.engine = { step: 'ready' };
    registerWorker();
    state.recovered = db.recovered; // a WAL DuckDB could not replay, set aside (docs/design/storage.md#recovery)
    if (fresh) return; // Setup is on screen: it writes the keys (saveKeys)
    record = (await db.get('keys')) ?? null; // an earlier version's rows were translated by migration 7
    if (!record) return void Object.assign(state, { screen: 'setup', cached: null });
    // an earlier version's vault whose public key was not in clear: the neuron needs it (register, the Base address)
    if (!loadKeys(record).vault.pubkey) return void Object.assign(state, { screen: 'finish', cached: null });
    await startNeuron();
  } catch (err) {
    // the database file itself won't open (damaged): offer to set it aside; anything else, "could not start"
    state.fatal = err?.dbFile ? `The database file could not be opened: ${err?.message ?? err}` : `The neuron did not start: ${err?.message ?? err}`;
    Object.assign(state, { screen: err?.dbFile ? 'damaged' : 'fatal', cached: null });
  }
}

boot();
