// App wiring: one tab → open the database → Setup, or Home with the neuron
// running on the alias key from page load: register with central, then
// poll on Satori Lite's schedule (docs/design/central.md), and follow the
// subscribed Nostr streams, publishing `<stream>_pred` (docs/design/nostr.md),
// and the alias's daily batch on Base (docs/design/base.md).
// Unlock/Lock open and wipe the wallet; the neuron never needs it (Base's
// Stake, claims and sends do). The keys are one record of this app's own
// (meta `keys`, docs/design/keys.md); Base is the only chain shown.
// window.satori is the same surface for agents (public/llms.txt). The
// installed app (service worker, Install, persistent storage) is src/pwa/.
import { version } from '../package.json';
import { watch } from '@arrow-js/core';
import { state, render, TABS } from './ui/view.js';
import { pickIndexes } from './ui/format.js';
import { openOpfsDb, hasDatabase, setAsideOpfsDb, readStoredKeys } from './db/opfs.js';
import {
  generateSecret, secretFromText, wordsOf, newKeys, readDockerFiles, sealBackup, openBackup, passphraseOk, MIN_PASSPHRASE,
  keepRetired, checkWalletPassphrase, IMPORT_MAX, evmAddress, connectedRecord, linkMessage,
} from './keys/index.js';
import { findWallets, requestAddress, signText, connectedWallet, showKeysText } from './keys/connect.js';
import { openRelay, RELAYS } from './keys/relay.js';
import { DEFAULTS as CHAIN } from './chain/config.js';
import { errorText, UP, DOWN } from './chain/index.js';
import { createAutoLock } from './keys/autolock.js';
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
import { callResult, dayOf, dayRange, networkMark } from './neuron/day.js';
import { createBase, checkSend, NEED_GAS, NEED_ALIAS_GAS, NEED_STAKE_GAS } from './neuron/base.js';
import { referrerOf, shareLink, sharedLink } from './neuron/referral.js';
import { queueOf, stepOf, favoritesIn, played, latestText } from './ui/gameflow.js';
import { listingOf } from './neuron/market.js';
import { playerOf, sendsToday } from './neuron/play.js';
import { watchable } from './neuron/records.js';
import { DEFAULT_PRICE } from './ui/market.js';
import { formatEther } from 'viem';
import { contractChecks, predictedToday, networkChecks, networkSent, relayChecks, relaysOn } from './ui/contractflow.js';
import { createReward } from './neuron/reward.js';
import { createActivity } from './neuron/activity.js';
import { healthOf, toneOf, CHIP_OF } from './neuron/health.js';
import { createWork, workText, leading, HERO } from './neuron/work.js';
import { createHold } from './ui/hold.js';
import { subscribe, lastTraffic } from './traffic.js';
import { createGlow } from './ui/glow.js';
import { setTheme, applyTheme } from './ui/theme.js';
import { readPref, writePref, readFavorites, writeFavorites, SORT_KEY, INSTALL_KEY, NEXT_STEP_KEY, GAME_KEY, snapshotOf, readSnapshot, writeSnapshot, dropSnapshot } from './ui/prefs.js';
import { readWallets, writeWallets, setAsideWalletFile, activeOf, pathOf, withAdded, withAddress, withActive, withoutWallet, walletsView, appGet, appPut } from './wallets.js';
import { deviceKey } from './keys/atrest.js';
import { createSession } from './session.js';
import { HANDOFF, SW_BATCH } from './pwa/handoff.js';
import { isHttps } from './util.js';
import { defaultsFrom, DEV_DEFAULTS, BUILD_DEFAULTS, versionOf } from './config.js';
import { shortHash, claimLine, stepText, fmtNum } from './ui/format.js';
import { startPwa, registerWorker, applyUpdate, install, storage, keepStorage } from './pwa/index.js';
import { startReminder, followPlayer, turnReminder, followNotifications } from './pwa/push.js';

// Settings' defaults: the dev server's (the dev central, the test relay, the local fork, so a dev
// checkout writes nothing to production) or a build's, each replaceable by a VITE_* variable.
const DEFAULTS = defaultsFrom(import.meta.env, import.meta.env.DEV ? DEV_DEFAULTS : BUILD_DEFAULTS);
/* global __NEURON_VERSION__ */
/** browser-<package version>+<git short sha>, stamped by vite.config.js: register's neuron-version, Settings, status().version. */
const VERSION = typeof __NEURON_VERSION__ === 'string' ? __NEURON_VERSION__ : versionOf(version);
state.version = VERSION;
const DEFAULT_CENTRAL = DEFAULTS.central;

let db;
let wallets = null; // this app's wallets as stored (src/wallets.js; null: one, in the first file)
let dbPath = pathOf(activeOf(null)); // the active wallet's database
let releaseTab = () => {}; // lets the one-tab lock go (claimTab)
let dbOpening = null; // the database's open, begun at boot: a first visit's Setup runs meanwhile, and its keys wait for it
let nostr = null; // the Nostr flow
let wallet = null; // only while unlocked; a connected wallet's (src/keys/connect.js) while its wallet app is in this browser
let foundWallets = []; // Setup's Connect: the wallets in this browser, with their providers
let lockCount = 0; // a Lock during an Unlock in flight wins
let pending = null; // setup only: { wallet, alias?, nostr? } secrets
let central = null;
let registration = null; // this page load's register result
let poller = null;
let base = null; // the Base flow
const invitedBy = referrerOf(location.search); // an invite link's ?ref= (docs/design/base.md#referral-invite-links), read once at load
let reward = null; // the reward address, as the Satori Service keeps it (src/neuron/reward.js): read when Settings opens
let activity = null; // the activity log Home's health reads (docs/design/health.md)
let trainer = null; // the training pass (src/neuron/train.js): every model's current fit, from stored history
let retrain = null; // Retrain (src/neuron/retrain.js): a model trained on until it beats no change, as the user asked
let afterUnlock = null; // the action an inline Unlock prompt was opened for
const nowS = () => Date.now() / 1000;
/** What the neuron is doing now (src/neuron/work.js): Home's hero and action lines, and health().work. */
const work = createWork({ onChange: () => { state.work = work.all(); } });
/** This browser's key for the alias and the Nostr key at rest (docs/design/keys.md#at-rest), or null: checked once a page. */
let restKeyOf;
const restKey = () => (restKeyOf ??= deviceKey({ get: appGet, put: appPut }));
/** The keys (src/session.js): the record and everything read from it, kept nowhere else. */
const session = createSession({ db: { get: (k) => db.get(k), set: (k, v) => db.set(k, v), checkpoint: () => db.checkpoint() }, restKey });

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
const refreshBase = coalesce('base status', async () => {
  state.base = await base.status();
  // staked or unstaked, by hand or not: the reminder server's player follows (only when it changed)
  if (state.reminder.on) followPlayer(reminderPlayer()).catch((err) => console.warn('[satori] reminder', err));
});

/** Whom the daily reminder watches on the chain (neuron/play.js sendsToday): its address. */
const reminderPlayer = () => (sendsToday({ play: state.base.play, staked: state.base.wallet?.staked }) === 'alias' ? state.alias : state.wallet);


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
  central = createCentral({ url, alias: session.alias, version: VERSION });
  registration = null;
  return central;
}

/** Register, as Lite does on every start; the result is shown, never thrown. */
async function registerWith(c) {
  const r = await register({ central: c, wallet: session.walletPublic.evmAddress, link: session.record.link, nostrPubkey: session.nostr.pubkey });
  if (c !== central) return; // the URL changed meanwhile
  registration = r;
  console[r.ok && !r.walletMismatch ? 'info' : 'warn']('[satori] central register', c.url, r);
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
  // never throws: errors are in r and in the status; seed: the alias draws each target's spec
  const r = await cycle({ db, central, seed: session.alias.pubkey, backfill, report });
  console[r.poll.error || r.submit?.error ? 'warn' : 'info']('[satori] central cycle', r);
  await refresh();
  await activity.central(r, state.central.pending); // Home still shows the last step, then the answer (src/ui/hold.js)
  if (r.poll?.predicted > 0) void publishNetwork(r.poll.at);
  return r;
}

/**
 * Every stream this app produces goes to the relays (CLAUDE.md, docs/design/nostr.md#our-other-streams): a poll's
 * Satori Service predictions, each as `<stream>_pred` (its forecast, 24 h ahead).
 */
async function publishNetwork(since) {
  try {
    const list = (await db.streams()).filter((s) => s.made_at != null && s.made_at >= since - 1 && Number.isFinite(s.t2))
      .map((s) => ({ stream: `${s.name}_pred`, name: `Predictions for ${s.name}`, value: s.t2, at: s.made_at, source: s.name,
        description: `This app's forecast of the Satori Service stream ${s.name}, 24 hours ahead, as sent to the Satori Service.`,
        tags: ['satori-network'] }));
    await nostr?.publishOwn(list);
  } catch (err) {
    console.warn('[satori] publishing the Satori Service predictions to the relays', err);
  }
}

/**
 * The Satori contract's predictions to the relays too: each game's call (1 up, -1 down) as
 * `satori-contract-<stream id>_pred`, whether the app's batch or the game played by hand.
 */
function publishContract(games, at) {
  const list = (games ?? []).filter((g) => g.direction === UP || g.direction === DOWN).map((g) => ({
    stream: `satori-contract-${g.streamId}_pred`, name: `Satori contract calls for stream ${g.streamId}`, value: g.direction === UP ? 1 : -1,
    at, source: `satori-contract-${g.streamId}`, cadence: 86_400, tags: ['satori-contract'],
    description: `This app's daily call on the Satori contract's stream ${g.streamId}: 1 up, -1 down.` }));
  if (list.length) nostr?.publishOwn(list).catch((err) => console.warn('[satori] publishing the contract calls to the relays', err));
}

async function startNeuron() {
  const { alias, walletPublic } = session;
  state.alias = alias.evmAddress;
  state.wallet = walletPublic.evmAddress;
  state.keysFrom = session.from; // docs/design/wallets.md#derived-keys: derived keys need no backup of their own
  if (walletPublic.connected) await findConnected();
  if (wallets && activeOf(wallets).address !== state.wallet) await keepWallets(withAddress(wallets, state.wallet)).catch(() => {});
  state.wallets = walletsView(wallets, state.wallet);
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
  retrain = createRetrain({ db, work, seed: () => alias.pubkey, nameOf: (u) => state.streams.find((r) => r.uuid === u)?.name ?? u,
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
  reward = createReward({ central: () => central, work, alias: alias.evmAddress, wallet: walletPublic.evmAddress,
    onChange: (st) => { state.reward = st; } });
  poller = createPoller(runCycle, { db, work, onChange: ({ next, running }) => {
    state.now = nowS(); // Home's "next try in 2 min" from now, not from the last 30 s tick (it read 3 min)
    state.central = { ...state.central, nextPoll: next, polling: running };
  } });
  await refresh();
  nostr = createNostr({ db, key: session.nostr, aliasPubkey: alias.pubkey, central: () => central, ws: import.meta.env.DEV, // csp.js: only the dev page allows ws:
    defaults: { relays: DEFAULTS.relays, centralWrite: DEFAULTS.centralWrite, wss: DEFAULTS.wss }, // wss: relays' stand-ins (config.js)
    onChange: refreshNostr, onPublished: () => activity.published(), onError: (err) => activity.error('nostr', err),
    onRecords: refreshRecords, work,
    // paid streams (docs/design/market.md): the alias signs and settles, the wallet is paid and funds a Buy, on Base's chain
    alias, walletAddress: walletPublic.evmAddress, wallet: () => wallet, chain: () => base.channels() });
  await refreshNostr();
  base = createBase({ db, alias, walletAddress: walletPublic.evmAddress, wallet: () => wallet, central: () => central, defaultRpc: DEFAULTS.rpc,
    onChange: refreshBase, onCheck: (r) => { activity.base(r); if (r.sent) publishContract(r.sent.games, r.sent.at); }, onConfigDiffers: (keys, url) => activity.configDiffers(keys, url), work,
    sw: { get: appGet, put: appPut, handoff: leaveHandoff } });
  if (invitedBy) await base.holdReferrer(invitedBy); // the invite link's ?ref=, kept until Stake registers it
  state.base = { ...state.base, play: await base.play() }; // at once (the database): the Game tab never shows the wrong switch
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
  startReminder().catch((err) => console.warn('[satori] reminder', err));
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
  autoLock.check(); // a device that slept past the wallet's deadline locks it now
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
  if (url && !isHttps(url)) throw new Error('The Satori Service address must be an https:// address.');
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

/** The reward address, read from the Satori Service once Settings shows it: once per page load and central, again after a failed read. */
function readReward() {
  if (state.tab === 'settings' && reward && !reward.known && !reward.status.reading) void readRewardNow();
}

/**
 * Set the reward address (a 0x address) or clear it (null or ''), from Settings or an agent (docs/design/central.md#the-reward-address):
 * signed in by the alias, no wallet; one at a time. A change is logged, so Home notes it for 24 h. → its status
 */
const setReward = (address) => exclusive(address == null || !String(address).trim() ? 'clear' : 'save', async () => {
  state.rewardDone = '';
  const r = await reward.set(address);
  if (r.changed) await activity.setting('reward', r.address ?? '');
  state.rewardDone = !r.address ? 'Cleared: rewards go to your wallet.'
    : `Saved: the Satori Service sends this app's rewards to ${r.address}${r.whose === 'wallet' ? ', your wallet' : ''}.`;
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

/**
 * The daily push's handoff (docs/design/push.md, src/pwa/wake.js): what the service worker needs to send the day's batch
 * with the app closed. The alias sealed with this browser's key, as in the keys record; in hex where it keeps none.
 */
async function leaveHandoff(info) {
  await appPut(HANDOFF, { ...info, ...await session.handoffAlias(), at: Date.now() });
}

/** The keys record, stored in one commit (session.save: every key it replaces kept); critical work. */
const storeKeys = (next) => work.run('keys', async (step) => {
  step('save');
  await session.save(next);
  state.retiredKeys = session.retired;
});

/**
 * The keys, then the neuron; backedUp: the wallet's words were confirmed, given or brought (docs/design/health.md). On a
 * first visit the database may still be loading: Setup says "Finishing setup… downloading the engine, 3.2 of 7.6 MB".
 */
async function saveKeys(r, { backedUp = false } = {}) {
  const listed = wallets && withAddress(wallets, r.wallet.address ?? evmAddress(r.wallet.pubkey)); // throws: already in this app
  state.setupWaiting = true; // until Home: the engine's step, then "saving your keys…"
  try {
    db ??= await dbOpening;
    await storeKeys(r);
    if (listed) await keepWallets(listed);
    if (backedUp) await markBackup();
    await startNeuron();
  } finally {
    state.setupWaiting = false;
  }
}

/**
 * A connected wallet, found again in this browser by its EIP-6963 id (docs/design/wallets.md#a-connected-wallet): its
 * signer, or none (another browser, the extension removed): the app still predicts, and wallet actions say so.
 */
async function findConnected() {
  const { rdns, name } = session.walletPublic.connected;
  const relay = RELAYS.includes(rdns);
  const provider = relay ? await relayed(rdns) : (await findWallets()).find((x) => x.rdns === rdns)?.provider;
  wallet = provider ? connectedWallet({ address: session.walletPublic.evmAddress, name, provider }) : null;
  state.connected = { name, found: !!provider, relay };
}

/** A phone path's stored session (src/keys/relay.js), if it is still this wallet's: its provider, else null. Never a prompt. */
async function relayed(rdns) {
  try {
    const r = await openRelay(rdns, { config: CHAIN, projectId: DEFAULTS.walletConnect });
    const accounts = r ? await r.provider.request({ method: 'eth_accounts' }) : [];
    return accounts.some((a) => a.toLowerCase() === session.walletPublic.evmAddress.toLowerCase()) ? r.provider : null;
  } catch (err) {
    console.warn('[satori] the wallet\'s relay session', err);
    return null;
  }
}

const notHere = () => new Error(state.connected.relay ? `The link to ${state.connected.name} has ended: reconnect it in Settings › Keys.`
  : `${state.connected.name} isn't in this browser: open the app where it is installed.`);

/** Reconnect a phone path whose session ended: the person approves again, and it must be the same account. */
const reconnect = () => exclusive('reconnect', async () => {
  const { rdns, name } = session.walletPublic.connected;
  const { provider } = await openRelay(rdns, { config: CHAIN, projectId: DEFAULTS.walletConnect, connect: true });
  const address = await requestAddress(provider);
  if (address !== session.walletPublic.evmAddress) throw new Error(`That is another account: choose ${session.walletPublic.evmAddress} in ${name}.`);
  wallet = connectedWallet({ address, name, provider });
  state.connected = { name, found: true, relay: true };
});

/** The list stored and shown. */
async function keepWallets(list) {
  await writeWallets(list);
  wallets = list;
  state.wallets = walletsView(wallets, state.wallet);
}

/** Another wallet opens: the keys wiped (Lock), the list's active one set, the last visit's Home dropped, the page reloaded. */
async function reopenWith(list) {
  lock();
  await writeWallets(list);
  dropSnapshot();
  const other = pathOf(activeOf(list)) !== dbPath;
  // the push's wake (src/pwa/wake.js) is this wallet's alias's: gone until the next wallet's first check leaves its own
  if (other) await Promise.all([appPut(HANDOFF, null), appPut(SW_BATCH, null)]).catch(() => {});
  setTimeout(() => {
    if (other) releaseTab(); // the next page opens another wallet's file: this page's open database is not in its way
    location.reload();
  }, 50); // after an agent's call has its answer
}

const addWallet = () => exclusive('wallets', () => reopenWith(withAdded(wallets, state.wallet || null)));
const switchWallet = (id) => exclusive('wallets', () => reopenWith(withActive(wallets, Number(id))));
/**
 * What removing a wallet asks for: 'passphrase' (its own, checked against its file), or 'none' (a connected wallet's is
 * in its wallet app; a wallet never set up has no keys).
 */
async function removeNeeds(id) {
  const { file } = withoutWallet(wallets, Number(id));
  const stored = await readStoredKeys(file);
  return !stored || stored.wallet?.kind === 'connected' ? 'none' : 'passphrase';
}
/**
 * Remove a wallet that is not in use, with that wallet's passphrase (the owner, 2026-10-28): its entry gone, its database
 * file (its keys among it) set aside, never deleted.
 */
const removeWallet = (id, passphrase) => exclusive('wallets', async () => {
  const { list, file } = withoutWallet(wallets, Number(id));
  const stored = await readStoredKeys(file);
  if (stored) await checkWalletPassphrase(stored, passphrase);
  await setAsideWalletFile(file);
  await keepWallets(list);
  Object.assign(state, { walletRemove: 0, walletRemoveNeeds: '' });
});

/** Backup's "Earlier keys" (keepRetired), as text: each earlier alias's address and private key, its Nostr key. */
const retiredText = (list) => list.map((k) => `Alias ${k.address}\nPrivate key ${k.privateKey}\nNostr ${k.npub}\nnsec ${k.nsec}`).join('\n\n');

/** The wallet's backup is confirmed (meta.backup_at): Home stops asking for it while storage is not kept. */
async function markBackup() {
  if (state.backupAt) return;
  state.backupAt = nowS();
  await db.set('backup_at', state.backupAt);
  await db.checkpoint();
}

async function unlock(passphrase) {
  const count = lockCount;
  const { wallet: v, linked, rekeyed } = await work.run('keys', () => session.unlock(passphrase)); // an upgrade saved
  state.retiredKeys = session.retired;
  if (rekeyed && base) { // the running app is the old alias's: start again with the new one (docs/design/wallets.md#derived-keys)
    v.lock();
    return void location.reload();
  }
  if (linked && central) registerWith(central).catch(() => {}); // the Satori Service learns the link at once
  if (count !== lockCount) return void v.lock();
  wallet?.lock();
  wallet = v;
  state.unlocked = true;
  state.unlockFor = '';
  autoLock.start();
}

/** Lock: the wallet wiped from memory, and any backup on screen hidden. */
function lock() {
  lockCount++;
  if (!wallet?.connected) { // a connected wallet holds no secret here: nothing to wipe
    wallet?.lock();
    wallet = null;
  }
  afterUnlock = null;
  autoLock.stop();
  Object.assign(state, { unlocked: false, unlockFor: '', backup: '', backupWords: '', backupKey: '', backupHex: '', backupAsk: '', backupError: '' });
}

/**
 * The wallet locks on its own (docs/design/keys.md#the-wallet-locks-on-its-own): 5 minutes after the last interaction (a
 * key, a tap, the wheel, a wallet action) while it is unlocked or a backup is on screen, never in the middle of a wallet
 * action, and at once on a wake past the deadline. An action an inline Unlock was opened for locks it when it ends.
 */
const autoLock = createAutoLock({ onLock: () => lock(), busy: () => !!state.baseBusy || !!state.busy || state.revealing,
  onChange: (at) => Object.assign(state, { lockAt: at, lockNow: Date.now() }) });
for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, () => autoLock.touch(), { capture: true, passive: true });
setInterval(() => { if (state.lockAt) state.lockNow = Date.now(); }, 15_000); // "Locks in 4 min" by Lock

/** An earlier version's wallet with no public key in clear: its first Unlock stores it in this app's format, then the neuron starts. */
async function finishUpdate(passphrase) {
  await exclusive('unlock', () => unlock(passphrase));
  await startNeuron();
}

/**
 * One key's backup ({ words, privateKey }, or the Nostr key's { nsec, secret }), or all three (which null or undefined),
 * from the passphrase each time, unlocked or not (keys' backupKeys: ~0.3 s; docs/design/keys.md#backup).
 */
async function backupOf(which, passphrase) {
  const b = session.walletPublic.connected ? await connectedBackupOf(which) : await session.backup(which, passphrase);
  if (which == null || which === 'wallet') markBackup().catch((err) => console.warn('[satori] backup_at', err)); // the wallet's words shown: backed up
  return b;
}

/** A connected wallet's Backup: the alias's or the Nostr key's, once its wallet app has signed showKeysText (checked). */
async function connectedBackupOf(which) {
  if (which === 'wallet') return session.connectedBackup(which); // its words are in its wallet app: said so
  if (!wallet) throw notHere();
  await signText(wallet.provider, session.walletPublic.evmAddress, showKeysText(session.walletPublic.evmAddress));
  return session.connectedBackup(which);
}

/**
 * "Set aside and start again" (the database file won't open, docs/design/storage.md#recovery): the file renamed, never
 * deleted; a fresh database; Setup, which offers Import and Import Docker files. The UI's button and setAside().
 */
const setAsideDb = () => exclusive('setAside', async () => {
  if (state.screen !== 'damaged') throw new Error(`Nothing to set aside (screen: ${state.screen}).`);
  state.setAsideError = '';
  try {
    state.setAside = await setAsideOpfsDb(dbPath);
    console.warn('[satori] the database file that would not open was set aside as', state.setAside);
    dbOpening = openOpfsDb(dbPath, { onStep: (e) => { state.engine = e; } });
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
async function setSubscribed(pubkey, stream, on, { predict = false } = {}) {
  const r = on ? await nostr.subscribe(pubkey, stream, { predict }) : await nostr.unsubscribe(pubkey, stream);
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

/**
 * The game's calls sent ([{ stream, direction }], docs/design/base.md#the-game), from the alias when the wallet is staked
 * with it, else the wallet (unlocked, or its wallet app): those already predicted are done without sending; none
 * left, nothing is sent. Noted (the Game tab opens on its Sent screen this round). → { count, hash, by, at, round }
 */
async function playCalls(calls, { by, round }) {
  const real = calls.filter((c) => !played(c.stream));
  let sent = { hash: null, by, count: calls.length, at: Math.floor(nowS()), round };
  if (!real.length) activity.wallet('play', `Played the game by hand: ${calls.length} prediction${calls.length === 1 ? '' : 's'}`); // the round's were sent already
  if (real.length) {
    const r = await baseAction('play', () => base.playHand(real.map((c) => ({ gameId: c.stream.gameId, direction: c.direction }))));
    publishContract(real.map((c) => ({ streamId: c.stream.streamId, direction: c.direction })), r.at);
    activity.wallet('play', `Sent ${real.length} prediction${real.length === 1 ? '' : 's'} to the Satori contract by hand`);
    sent = { ...r, count: calls.length };
  }
  await base.notePlay(sent).catch((err) => console.warn('[satori] game', err));
  return sent;
}

/** A Base action, one at a time; then the card is read again. It counts as an interaction (the wallet's 5 minutes). */
const baseAction = (what, fn) => exclusive(what, fn, 'baseBusy').finally(() => {
  autoLock.touch();
  void refreshBase();
});

/** The wallet's Base actions (Unlock), for the UI and agents alike; the activity log says what each did. */
const walletOps = {
  async delegate() {
    const r = await base.delegate();
    if (r.steps.length) activity.wallet('stake', 'Staked with this app');
    state.game = { ...state.game, loaded: 0 }; // the player changed (the alias now): the Game tab reads again
    return r;
  },
  async undelegate() {
    const r = await base.undelegate();
    if (r.steps.length) activity.wallet('unstake', 'Unstaked');
    state.game = { ...state.game, loaded: 0 }; // the player changed (the wallet now): the Game tab reads again
    return r;
  },
  async claim() {
    const r = await base.claim();
    const sum = [r.rewards, r.merkle, r.airdrop].filter((x) => x?.hash).reduce((n, x) => n + Number(x.amount), 0);
    if (sum > 0) activity.wallet('claim', `Claimed ${fmtNum(sum)} SATORI`);
    return r;
  },
  /** { asset, to, amount, passphrase }: the inputs checked first, then the wallet opened from the passphrase for this send alone. */
  async send(o = {}) {
    const { asset, amount } = checkSend(o);
    const r = session.walletPublic.connected ? await base.send(o, wallet ?? (() => { throw notHere(); })())
      : await session.withPassphrase(o.passphrase, (v) => base.send(o, v));
    activity.wallet('send', `Sent ${amount} ${asset} from the wallet`);
    return r;
  },
};

/**
 * Connect a wallet found in this browser: its chosen account, then the link it signs (the wallet app asks the person);
 * no passphrase. Its words are in its wallet app, so there is no backup to ask for.
 */
const connectTo = (rdns) => setup(async () => {
  const relay = RELAYS.includes(rdns);
  const w = relay ? null : foundWallets.find((x) => x.rdns === rdns);
  if (!relay && !w) throw new Error('That wallet is not in this browser.');
  state.connecting = relay ? (rdns === RELAYS[0] ? 'MetaMask' : 'your wallet app') : w.name;
  try {
    const { provider, name } = relay ? await openRelay(rdns, { config: CHAIN, projectId: DEFAULTS.walletConnect, connect: true }) : w;
    state.connecting = name;
    const address = await requestAddress(provider);
    const sign = (m) => signText(provider, address, m);
    return await connectedRecord({ address, rdns, name, signLink: sign, signKeys: sign });
  } finally {
    state.connecting = '';
  }
}, { backedUp: true });

/**
 * Setup, from the UI or an agent: one at a time, and only on the Setup screen. `makeRecord` → the keys, or null (not
 * yet). backedUp: the wallet's words were confirmed (Create), given (Restore) or brought (a Dockerized Neuron's files).
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
    if (el) {
      const folded = el.closest('details'); // Settings › Advanced
      if (folded) folded.open = true;
      el.scrollIntoView({ block: 'start' });
    }
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

/** Run `fn` now if the wallet is open; else open the inline Unlock prompt at `slot`, and run it after Unlock. */
function withWallet(slot, fn) {
  if (wallet) return fn();
  if (state.connected) return void (state.baseError = notHere().message); // nothing to unlock: its wallet app is elsewhere
  afterUnlock = fn;
  Object.assign(state, { unlockFor: slot, unlockError: '' });
  requestAnimationFrame(() => document.querySelector(`[data-unlock-for="${slot}"] input`)?.focus());
  return undefined;
}

// ── UI actions ──────────────────────────────────────────────────────────────

function wipePending() {
  pending?.wallet?.fill(0);
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
/**
 * A fresh link (issued now), signed by the wallet, kept with the keys and sent with a register at once. The Satori Service
 * keeps the newest link per wallet, so this takes the wallet back from another app's alias (docs/design/wallets.md).
 */
async function relinkWallet() {
  if (!wallet) throw new Error(session.walletPublic.connected ? notHere().message : 'Unlock the wallet first.');
  const issued = Math.floor(nowS()); // whole seconds: the network refuses any other issued line
  let link;
  if (session.walletPublic.connected) {
    const message = linkMessage({ alias: session.alias.evmAddress, wallet: session.walletPublic.evmAddress, issued });
    link = { message, signature: await signText(wallet.provider, session.walletPublic.evmAddress, message) };
  } else link = wallet.signLink(session.alias.evmAddress, issued);
  await storeKeys({ ...session.record, link });
  await registerWith(central);
  if (registration?.ok && registration.walletMismatch) {
    throw new Error(`The Satori Service did not take the link${registration.walletLinkError ? `: ${registration.walletLinkError}` : ''}.`);
  }
  return registration;
}

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
    pending = { wallet: generateSecret() };
    state.words = wordsOf(pending.wallet).split(' ');
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
    const secret = (text, which) => {
      try { return secretFromText(text); } catch { throw new Error(`The ${which}: not 24 backup words or a private key.`); }
    };
    try {
      pending = { wallet: secret(f.wallet, 'wallet') }; // the alias and the Nostr key are derived from it
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
   * Dockerized Neuron files: decrypted with the Docker wallet password and translated into this app's
   * record. The same password becomes this app's passphrase when it meets the rule and `reuse` is ticked;
   * otherwise the passphrase step asks for one.
   */
  /** Setup's Connect: the wallets in this browser (docs/design/wallets.md#a-connected-wallet). */
  async lookForWallets() {
    goStep('connect');
    Object.assign(state, { connectFound: null, error: '' });
    foundWallets = await findWallets();
    state.connectFound = foundWallets.map(({ rdns, name }) => ({ rdns, name }));
    state.walletConnectReady = !!DEFAULTS.walletConnect;
  },
  connect: shownAt('error', (rdns) => connectTo(rdns)),
  reconnect: shownAt('walletError', () => reconnect()),
  importDocker: shownAt('error', async (el) => {
    const f = new FormData(el);
    await setup(async () => {
      if (f.get('wallet')?.size > IMPORT_MAX) throw new Error('The wallet file: over 64 KB, so not a Docker file.'); // not read at all
      const password = String(f.get('pass') ?? '');
      const reuse = f.get('reuse') === 'on';
      const secrets = await readDockerFiles({ walletText: await f.get('wallet').text(), password });
      el.reset();
      if (reuse && passphraseOk(password)) {
        try {
          return await newKeys(secrets, password);
        } finally {
          secrets.wallet.fill(0);
        }
      }
      wipePending();
      pending = secrets;
      state.passNote = reuse
        ? `The Docker install's wallet password is shorter than ${MIN_PASSPHRASE} characters. Choose a new passphrase for this app.`
        : 'Choose a passphrase for this app.';
      goStep('passphrase');
      return null;
    }, { backedUp: true });
  }),
  /** Settings' Unlock; an action asked for meanwhile (its inline prompt open) runs after it, and the wallet stays unlocked. */
  unlock: shownAt('walletError', async (f, el) => actions.unlockAndRun(f, el)),
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
  /** Home's strip: a day opened (docs/design/health.md#a-day-opened), or the same day again: closed. */
  async openDay(date) {
    state.dayOpen = state.dayOpen === date ? '' : date;
    if (!state.dayOpen) return;
    try {
      const day = await dayDetail(date);
      if (state.dayOpen === date) state.day = day;
    } catch (err) {
      if (state.dayOpen === date) state.day = { date, error: `This day could not be read: ${err?.message ?? err}` };
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
    else if (a.do === 'stake') actions.walletAction('card', 'baseDelegate');
    else if (a.do === 'receive') { go('wallet', 'receive'); state.contractQr = state.wallet; } // the address, with its QR code
    else if (a.do === 'preload') { go('wallet', 'preload'); requestAnimationFrame(actions.preloadForm); }
    else if (a.do === 'auto') actions.setPlay('auto');
    else if (a.do === 'relink') withWallet('card', actions.baseRelink);
    else if (a.do === 'backup') {
      go('settings', 'backup');
      actions.askBackup('wallet');
    } else if (a.do === 'go') go(a.tab, a.section);
  },
  finishUpdate: shownAt('walletError', async (f, el) => {
    await finishUpdate(f.pass);
    el.reset();
  }),
  lock,
  /** Backup's buttons: the passphrase is asked each time, in place (docs/design/keys.md#backup). */
  askBackup(which) {
    Object.assign(state, { backupAsk: which, backupError: '', backup: '', backupWords: '', backupKey: '', backupHex: '' }); // what another showed goes
    requestAnimationFrame(() => [...document.querySelectorAll('form.inline-unlock')].find((f) => !f.hidden && f.dataset.test?.endsWith('backup-prompt'))
      ?.querySelector('input')?.focus());
  },
  cancelBackup() { Object.assign(state, { backupAsk: '', backupError: '' }); },
  /** The passphrase typed: the key's backup shown, for 5 minutes without interaction at most. */
  showBackup: shownAt('backupError', async (f, el) => {
    const which = state.backupAsk;
    state.revealing = true;
    try {
      const b = await backupOf(which, f.pass);
      el.reset();
      const key = which === 'retired' ? retiredText(b) : b.privateKey ?? b.nsec;
      Object.assign(state, { backupAsk: '', backup: which, backupWords: b.words ?? '', backupKey: key, backupHex: b.secret ?? '' });
      if (autoLock.lockAt == null) autoLock.start();
      else autoLock.touch();
    } finally {
      state.revealing = false;
    }
  }),
  hideBackup() {
    Object.assign(state, { backup: '', backupWords: '', backupKey: '', backupHex: '' });
    if (!wallet) autoLock.stop();
  },
  async copy(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      state.copied = key;
      setTimeout(() => (state.copied = ''), 1500);
    } catch { /* clipboard not allowed */ }
  },
  /** Share: the invite link (docs/design/base.md#referral-invite-links) to the device's share sheet, else copied. */
  async share() {
    if (await shareLink(sharedLink(state.base.inviteLink, state.tab)) !== 'copied') return;
    state.copied = 'share';
    setTimeout(() => (state.copied = ''), 1500);
  },
  pollNow: () => pollNow().catch((err) => console.error('[satori] poll', err)),
  install: () => install().catch((err) => console.warn('[satori] install', err)),
  /**
   * Home's Install card put away (Not now, Got it): once, on this device (docs/design/pwa.md#install). The next step's
   * (Not now): for 3 days.
   */
  dismissAdvice(id) {
    if (id === 'next-step') {
      state.nextStepDismissed = nowS();
      writePref(NEXT_STEP_KEY, String(state.nextStepDismissed));
      return;
    }
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
  /** The Network Streams list's one button: Predict follows the stream and predicts it; Stop predicting unfollows it. */
  predictStream: shownAt('networkError', async (pubkey, stream, on) => {
    state.subscribing = `${pubkey}:${stream}`;
    try {
      const followed = state.nostr.subscriptions.some((x) => x.provider === pubkey && x.stream === stream);
      if (on && followed) {
        await nostr.setPredict(pubkey, stream, true);
        await refreshNostr();
      } else await setSubscribed(pubkey, stream, on, { predict: true });
    } finally {
      state.subscribing = '';
    }
  }),
  /** Predict a followed stream (its `_pred` published to the relays), or stop. */
  setPredict: shownAt('networkError', async (pubkey, stream, on) => {
    state.subscribing = `${pubkey}:${stream}`;
    try {
      await nostr.setPredict(pubkey, stream, on);
      await refreshNostr();
    } finally {
      state.subscribing = '';
    }
  }),
  /** Paid streams (docs/design/market.md): a price on one of our `_pred`s, free again, Buy (the wallet: Unlock in place), Stop. */
  sell: shownAt('marketError', (stream, f) => marketAction(`sell:${stream}`, () => nostr.sell(stream, String(f.price ?? '').trim() || DEFAULT_PRICE))),
  unsell: shownAt('marketError', (stream) => marketAction(`sell:${stream}`, () => nostr.unsell(stream))),
  buy(pubkey, stream, f) {
    state.networkError = '';
    return withWallet('buy', () => actions.buyNow(pubkey, stream, f.deposit));
  },
  buyNow: shownAt('networkError', (pubkey, stream, deposit) => marketAction(`buy:${pubkey}:${stream}`, () => nostr.buy(pubkey, stream, deposit))),
  stop: shownAt('marketError', (pubkey, stream) => marketAction(`stop:${pubkey}:${stream}`, () => nostr.stopBuying(pubkey, stream))),
  /** A channel's grace period, what is left taken back, a buyer's payout address: the wallet (Unlock in place). */
  setGrace(channel, f) { state.marketError = ''; return withWallet('market', () => actions.setGraceNow(channel, f.days)); },
  setGraceNow: shownAt('marketError', (channel, days) => marketAction(`grace:${channel}`, () => nostr.setGrace(channel, days))),
  takeBack(channel, f) { state.marketError = ''; return withWallet('market', () => actions.takeBackNow(channel, f.amount, f.to)); },
  takeBackNow: shownAt('marketError', (channel, amount, to) => marketAction(`take:${channel}`, () => nostr.takeBack(channel, amount, to))),
  setPayout(channel, f) { state.marketError = ''; return withWallet('market', () => actions.setPayoutNow(channel, f.payout)); },
  setPayoutNow: shownAt('marketError', (channel, address) => marketAction(`payout:${channel}`, () => nostr.setPayout(channel, address))),
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
  /** A wallet action from the UI: Unlock first (inline, at `slot`) when the wallet is locked. */
  async walletAction(slot, name) {
    // Claim and Stake are transactions: no gas is said before trying (and before Unlock), after a fresh read (it may have just come)
    const noGas = () => (name === 'baseClaim' ? state.base.wallet.lowEth && NEED_GAS
      : name === 'baseDelegate' && (state.base.alias.noGas ? NEED_ALIAS_GAS : state.base.wallet.lowEth && NEED_STAKE_GAS));
    if (noGas()) await base.refresh().then((v) => { state.base = v; }, () => {});
    if (noGas()) return void Object.assign(state, { baseDid: name === 'baseClaim' ? 'claim' : 'stake', baseResult: '', baseTxs: [], baseError: noGas() });
    return withWallet(slot, () => actions[name]());
  },
  baseRelink: () => baseUi('link', async () => {
    await relinkWallet();
    return { text: 'Linked: the Satori Service pays this wallet.' };
  }),
  baseDelegate: () => baseUi('stake', async () => {
    const r = await walletOps.delegate();
    return { text: r.steps.length ? 'Staked with this app.' : 'Already staked with this app.',
      txs: stepTxs(r.steps) };
  }),
  baseUndelegate: () => baseUi('unstake', async () => {
    const r = await walletOps.undelegate();
    return { text: r.steps.length ? 'Unstaked.' : 'Not staked.', txs: stepTxs(r.steps) };
  }),
  baseClaim: () => baseUi('claim', async () => {
    const r = await walletOps.claim();
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
  /** Preload gas: the Send form filled in, Base ETH to this app's alias, a month of daily batches; the person checks and sends. */
  preloadForm() {
    const f = document.querySelector('form.send');
    if (!f) return;
    Object.assign(state, { sendReview: null, baseError: '' });
    f.elements.asset.value = 'ETH';
    f.elements.to.value = state.base.alias.address;
    f.elements.amount.value = state.base.alias.preload ?? '';
    f.elements.amount.focus();
  },
  /** Back to the form, as it was typed. */
  backSend() { Object.assign(state, { sendReview: null, baseError: '' }); },
  /** Step two: Send, with the wallet's passphrase (asked each time, unlocked or not). */
  confirmSend: (f, el) => baseUi('send', async () => {
    const q = state.sendReview;
    const r = await walletOps.send({ asset: q.asset, to: q.to, amount: q.amount, passphrase: f.pass });
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
  // ── the Game tab (docs/design/base.md#the-game) ──
  /** Its streams read again: which can be played now, in order (favorites first). */
  async loadGame() {
    const g = state.game;
    if (g.loading || !base) return;
    state.game = { ...g, loading: true, error: '' };
    try {
      const { by, streams, round, played: last } = await base.gameStreams();
      const favorites = readFavorites(session.walletPublic?.evmAddress);
      const { queue, split } = queueOf(streams, favorites);
      // played with the game this round: its Sent screen again (predictions made elsewhere are played as usual)
      const sent = last && round != null && last.round === round ? { ...last, again: true } : null;
      state.game = { ...state.game, loading: false, loaded: Date.now(), by, streams, queue, split, favorites, round,
        favs: favoritesIn(queue, favorites), index: 0, picks: {}, screen: 'play', move: '', sendError: '', sent };
    } catch (err) {
      state.game = { ...state.game, loading: false, error: errorText(err) };
    }
  },
  /** Up (UP) or down (DOWN) on the stream shown; the next one. */
  gamePick(direction) {
    const s = state.game.queue[state.game.index];
    if (!s || state.game.screen !== 'play') return;
    state.game = { ...state.game, picks: { ...state.game.picks, [s.streamId]: direction } };
    actions.gameNext();
  },
  /** On (a swipe left: skips the stream; from the submit screen, on to more streams), as gameflow.js stepOf. */
  gameNext() { actions.gameStep(1); },
  /** Back (a swipe right). */
  gameBack() { actions.gameStep(-1); },
  gameStep(dir) {
    const g = state.game;
    const to = stepOf({ screen: g.screen, index: g.index, length: g.queue.length, split: g.split }, dir);
    if (to) state.game = { ...g, ...to, move: dir > 0 ? 'next' : 'back', sendError: '' };
  },
  gameSubmitNow() { state.game = { ...state.game, screen: 'submit', move: 'next' }; },
  toggleChip(key) { state.chipOpen = state.chipOpen === key ? '' : key; },
  toggleContractQr(address) { state.contractQr = state.contractQr === address ? '' : address; },
  /** The game's CLAIM: Home's Claim (Unlock in place); the amount kept to show beside CLAIMED. */
  gameClaim() {
    state.game = { ...state.game, claimAmount: Number(state.base.claimable?.total ?? 0) };
    return actions.walletAction('game-claim', 'baseClaim');
  },
  /** Played today: the Sent screen put away (for this session), the streams shown again to look at. */
  async gameRest() {
    const fresh = !state.game.sent?.again; // just sent: the streams read again first, so they show as played
    state.game = { ...state.game, rest: true, screen: 'play', index: 0 };
    if (fresh) await actions.loadGame();
  },
  /** Star a stream, or unstar it: kept on this device for this wallet; the next game shows favorites first. */
  gameStar(streamId) {
    const f = state.game.favorites;
    const favorites = f.includes(streamId) ? f.filter((id) => id !== streamId) : [...f, streamId];
    writeFavorites(session.walletPublic?.evmAddress, favorites);
    state.game = { ...state.game, favorites };
  },
  /**
   * Send the calls: from the alias when staked with it; else from the wallet (Unlock in place, or its wallet app).
   * Streams already predicted (gameflow.js played) are not sent: done, as if they were. All of them: done, nothing sent.
   */
  async gameSend() {
    const g = state.game;
    const calls = g.queue.filter((s) => g.picks[s.streamId]).map((s) => ({ stream: s, direction: g.picks[s.streamId] }));
    if (!calls.length || g.sending) return undefined;
    // who sends: the stake read from the chain now, at Submit (the tab's read may be minutes old, a Stake elsewhere since)
    state.game = { ...state.game, sending: true, sendError: '' };
    await base.refresh().then(refreshBase).catch(() => {}); // unread: the last read decides, and playHand reads again
    state.game = { ...state.game, sending: false };
    const run = async () => {
      state.game = { ...state.game, sending: true, sendError: '' };
      try {
        state.game = { ...state.game, sending: false, sent: await playCalls(calls, g) };
      } catch (err) {
        state.game = { ...state.game, sending: false, sendError: errorText(err) };
      }
    };
    // nothing to send (all already predicted), or the alias sends: no Unlock (base.playHand decides the same way)
    return playerOf(state.base.wallet.staked) === 'alias' || calls.every((c) => played(c.stream)) ? run() : withWallet('game', run);
  },
  /** The daily reminder (Settings › This device; docs/design/push.md): on or off. */
  async setReminder(on) {
    state.reminder = { ...state.reminder, busy: true, error: '' };
    try {
      await turnReminder(on, reminderPlayer());
    } catch (err) {
      state.reminder = { ...state.reminder, error: errorText(err) };
    } finally {
      state.reminder = { ...state.reminder, busy: false };
    }
  },
  /** The Game tab's switch: 'manual' (play by hand: the daily batch is not sent) or 'auto' (docs/design/base.md#played-by-hand). */
  async setPlay(mode) {
    const was = state.base.play;
    state.base = { ...state.base, play: mode }; // at once; stored meanwhile
    try { await base.setPlay(mode); } catch (err) { state.base = { ...state.base, play: was }; console.warn('[satori] play', err); }
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
  /** The Wallets card (docs/design/wallets.md#several-wallets): Add, Switch, and Remove after it asks. */
  addWallet: shownAt('walletsError', () => addWallet()),
  switchWallet: shownAt('walletsError', (id) => switchWallet(id)),
  askRemoveWallet: shownAt('walletsError', async (id) => {
    Object.assign(state, { walletRemove: id, walletRemoveNeeds: '', walletsError: '' });
    const needs = await removeNeeds(id);
    if (state.walletRemove === id) state.walletRemoveNeeds = needs;
    requestAnimationFrame(() => document.querySelector('[data-test=wallet-remove-pass]')?.focus());
  }),
  cancelRemoveWallet() { Object.assign(state, { walletRemove: 0, walletRemoveNeeds: '', walletsError: '' }); },
  removeWallet: shownAt('walletsError', async (f, el) => {
    await removeWallet(state.walletRemove, f.pass);
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
      version: VERSION, // browser-<package version>+<git short sha>
      alias: state.alias || null,
      wallet: state.wallet || null,
      walletKind: !state.wallet ? null : state.connected ? 'connected' : 'sealed',
      keysFrom: state.keysFrom || null, // where the alias and the Nostr key came from (docs/design/wallets.md#derived-keys)
      connected: state.connected, // a connected wallet: { name, found } (found: its wallet app is in this browser), else null
      unlocked: state.unlocked,
      lockAt: state.lockAt, // when the wallet locks on its own (ms), or null

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
  /** On Setup: the wallets in this browser that can be connected (EIP-6963, else window.ethereum; with none, MetaMask Connect and
   * WalletConnect) → [{ rdns, name }]. */
  async connectWallets() {
    foundWallets = await findWallets();
    const found = foundWallets.map(({ rdns, name }) => ({ rdns, name }));
    // none in this browser (a phone's Chrome or Safari): the dapp's two relay paths
    return found.length ? found : [{ rdns: RELAYS[0], name: 'MetaMask' }, ...(DEFAULTS.walletConnect ? [{ rdns: RELAYS[1], name: 'Other wallet' }] : [])];
  },
  /** On Setup: connect one of them (connectWallets() first); its wallet app asks the person for the account and the link. → status */
  async connect(rdns) {
    await connectTo(rdns);
    return window.satori.status();
  },
  /** This app's wallets (docs/design/wallets.md#several-wallets) → { active, wallets: [{ id, address, active }] }. */
  wallets: async () => walletsView(wallets, state.wallet || null),
  /** A new wallet, active: the page reloads on Setup (setup() then makes it). Only on the person's request. → { reloading: true } */
  async addWallet() { await addWallet(); return { reloading: true }; },
  /** Another wallet of this app's, by id: the keys locked, the page reloaded with it. → { reloading: true } */
  async switchWallet(id) { await switchWallet(id); return { reloading: true }; },
  /** Remove a wallet that is not in use, with that wallet's passphrase (none for a connected one): off the list, its file
   * set aside, never deleted. Only on the person's request, after its words are backed up. → wallets() */
  async removeWallet(id, passphrase) { await removeWallet(id, passphrase); return walletsView(wallets, state.wallet || null); },
  /** Chromium's install prompt, when offered (status().app.canInstall; needs a user gesture). → 'accepted' | 'dismissed' | 'unavailable' */
  install() { return install(); },
  /** When status().app.update: the new version takes over and the page reloads. → false if none is waiting */
  update() { return applyUpdate(); },
  /**
   * On the 'damaged' screen (the database file won't open): set it aside (renamed, never deleted) and start again on
   * Setup, to import again. Only on the person's request: their keys are in that file. → status()
   */
  async setAside() { await setAsideDb(); return window.satori.status(); },
  /** Create a wallet (a new one unless its words or private key are given; its alias and Nostr key derived). Stays locked. */
  async setup({ passphrase, walletWords, backup } = {}) {
    let retired = [];
    if (backup) { // exportBackup()'s file, opened with its passphrase
      const b = await openBackup(backup, passphrase);
      if (!b.walletWords) throw new Error("This backup is a connected wallet's: its words are in its wallet app. Connect it (connect()).");
      ({ walletWords, retired } = b);
    }
    await setup(async () => {
      const keys = {};
      try {
        keys.wallet = walletWords ? secretFromText(walletWords) : generateSecret();
        const r = await newKeys(keys, passphrase);
        return retired.length ? keepRetired(null, { ...r, retired }) : r; // its earlier keys come back with it
      } finally {
        keys.wallet?.fill(0);
      }
    }, { backedUp: !!walletWords }); // given words are a backup; random ones are not until backup() shows them
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
      installDismissed: state.installDismissed, nextStepDismissed: state.nextStepDismissed, traffic: lastTraffic(), work: work.all() });
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
   * Retrain a Satori Service model (docs/design/models.md#retrain): keep training it, from stored history, until one
   * beats no change, then stop; never a prediction. Resolves when it ends (or at once with a note when its last retrain
   * looked at the same data) → model(id).retrain's status. Throws when it can't: not a Network model, no history.
   */
  async retrain(id) {
    ready();
    const uuid = centralUuid(id);
    if (!uuid) throw new Error(`Retrain is for Satori Service models for now (got ${id}).`);
    if ((await retrain.start(uuid)).running) await retrain.done(uuid);
    return retrain.status(uuid);
  },
  /** Stop a retrain: it ends at its next try and keeps the current model. → its status */
  async stopRetrain(id) {
    ready();
    const uuid = centralUuid(id);
    if (!uuid) throw new Error(`No Satori Service model: ${id}.`);
    retrain.stop(uuid);
    await retrain.done(uuid);
    return retrain.status(uuid);
  },
  /** One stream's predictions (uuid or name), newest first. */
  async predictions(stream, limit = 20) { ready(); return db.predictions(stream, limit); },
  /** Set the central URL ('' = the default) and register there. → status().central */
  async setCentral(url) { ready(); await setCentral(url); return centralStatus(); },
  /**
   * Where the Satori Service sends this neuron's rewards, read from it now (signed in by the alias). → { address: '0x…'
   * (checksummed) | null (not set: the wallet), whose: 'wallet' | 'alias' | null, at }; throws when it could not be read.
   */
  async rewardAddress() {
    ready();
    const st = await readRewardNow();
    if (st.error) throw new Error(st.error);
    return { address: st.address, whose: st.whose, at: st.at };
  },
  /**
   * Set the reward address (a Base 0x address, not this neuron's alias) or clear it (null or ''), signed in by the
   * alias; free. → { address, whose, at }
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
   * The passphrase each time, unlocked or not (~0.3 s). 'alias' | 'wallet' → { words, privateKey }; 'nostr' → { nsec,
   * secret }; null or undefined → { alias, wallet, nostr }.
   */
  async backup(which, passphrase) { ready(); return backupOf(which, passphrase); },
  /**
   * Every key, sealed with `passphrase` (the wallet's; a connected wallet's own words are in its wallet app) in one
   * JSON file to keep where the person keeps secrets: setup({ passphrase, backup }) restores it on a fresh browser.
   * → { kind: 'satori-backup', v: 1, address, at, sealed }
   */
  async exportBackup(passphrase) {
    ready();
    const keys = await backupOf(undefined, passphrase);
    return sealBackup({ address: session.walletPublic.evmAddress, keys, passphrase });
  },
  /** Import a Docker (Lite) install: its { wallet } file's text, its `password`, and `passphrase` for this app (default: the password). */
  async importDocker({ wallet: walletText, password = '', passphrase = password } = {}) {
    await setup(async () => {
      const secrets = await readDockerFiles({ walletText, password });
      try {
        return await newKeys(secrets, passphrase);
      } finally {
        secrets.wallet.fill(0);
      }
    }, { backedUp: true });
    return window.satori.status();
  },
  /**
   * The Game tab (docs/design/base.md#the-game): who plays (`by`: the alias when staked with it, else the wallet), the
   * mode (`play`: by hand is 'manual'), whether it was played this round, the favorites, and the streams in the game's
   * order (eligible: reward eligible; alreadyPredicted: played as usual, not sent), with their history.
   */
  async game() {
    ready();
    const { by, streams, round, played: last } = await base.gameStreams();
    const favorites = readFavorites(session.walletPublic?.evmAddress);
    const { queue, split } = queueOf(streams, favorites);
    return { play: state.base.play, by, round, playedToday: last && last.round === round ? last : null, favorites,
      streams: queue.map((s, i) => ({ streamId: s.streamId, gameId: s.gameId, name: s.name, named: s.named, eligible: i < split,
        alreadyPredicted: played(s), latest: latestText(s), display: s.display ?? null, streak: s.streak ?? null, history: s.history })),
      unavailable: streams.filter((s) => !queue.includes(s)).map((s) => ({ streamId: s.streamId, name: s.name, why: s.blocked })) };
  },
  /**
   * Play the game by hand: [{ streamId, direction: 'up' | 'down' }], one transaction (needs setPlay('manual'); the wallet
   * unlocked when it plays). → { count, hash (null: nothing needed sending), by, at, round }
   */
  async playGame(picks = []) {
    ready();
    if (state.base.play !== 'manual') throw new Error("The app plays automatically: setPlay('manual') first, if the person asked to play by hand.");
    const g = await base.gameStreams();
    const { queue } = queueOf(g.streams);
    const calls = picks.map(({ streamId, direction }) => {
      const stream = queue.find((s) => s.streamId === Number(streamId));
      if (!stream) throw new Error(`Stream ${streamId} can't be played now.`);
      if (direction !== 'up' && direction !== 'down') throw new Error("direction: 'up' or 'down'.");
      return { stream, direction: direction === 'up' ? UP : DOWN };
    });
    if (!calls.length) throw new Error('No predictions to send.');
    const sent = await playCalls(calls, g);
    state.game = { ...state.game, loaded: 0 }; // the Game tab reads again when it opens
    return sent;
  },
  /** The game's favorites (stream ids, shown first, in this order), kept on this device for this wallet. → them */
  setGameFavorites(ids = []) {
    const favorites = [...new Set(ids.map(Number).filter(Number.isInteger))];
    writeFavorites(session.walletPublic?.evmAddress, favorites);
    state.game = { ...state.game, favorites, loaded: 0 };
    return favorites;
  },
  /**
   * Home's Satori contract card: the mode, whether a prediction went to the contract this round, and what has to be in
   * place, each { id, state: 'ok' | 'bad' | 'wait', text, fix?: 'stake' | 'fund' (with address) | 'game' }.
   */
  async contract() {
    ready();
    await base.refresh();
    const v = await base.status();
    return { play: v.play, predictedToday: predictedToday(v), checks: contractChecks(v) };
  },
  /**
   * Home's chip cards (docs/design/health.md#the-chip-cards): 'network' | 'contract' | 'relays' → { working, checks }
   * (working: the arrow is green: sent in the last day, predicted this round, a relay connected); the contract's also
   * has `play` (as contract()).
   */
  async channel(key) {
    ready();
    if (key === 'contract') { const c = await window.satori.contract(); return { ...c, working: c.predictedToday }; }
    if (key === 'network') { const c = await centralStatus(); return { working: networkSent(c, nowS()), checks: networkChecks(c, nowS()) }; }
    if (key === 'relays') { const n = await nostrStatus(); return { working: relaysOn(n), checks: relayChecks(n) }; }
    throw new Error("channel: 'network', 'contract' or 'relays'.");
  },
  /** One day of Home's strip ('2026-10-24', local): when the app predicted, on the Satori Service and the contract, and how those did. */
  async day(date) { ready(); return dayDetail(String(date)); },
  /**
   * Put away Home's advice card ('install': Install, kept on this device; 'next-step': the next step, for 3 days) or the
   * recovered-database notice ('notice').
   */
  dismiss(what) {
    if (what === 'notice') return void actions.dismissNotice();
    if (what !== 'install' && what !== 'next-step') throw new Error("dismiss: 'install', 'next-step' or 'notice'.");
    actions.dismissAdvice(what);
  },
  /** Nostr: the key, the relays and their state, the subscribed streams with the latest observation and our `_pred`. */
  async nostr() { ready(); return nostrStatus(); },
  /** The relays' stream catalog (newest per provider and stream, no tombstones); `pred` and `subscribed` marked. */
  async discover() { ready(); const list = await nostr.discover(); state.catalog = list; return list; },
  /**
   * The Market tab (docs/design/market.md#the-market-tab): `forSale`, every stream the relays announce with a price
   * (discover()'s entries, with its listing's `price` in SATORI and the track record's `record` when watched); and
   * nostr().market's `selling` and `bought`.
   */
  async market() {
    ready();
    const list = state.catalog.length ? state.catalog : await window.satori.discover();
    const records = await nostr.records();
    const forSale = list.filter((s) => listingOf(s) && watchable(s)).map((s) => ({ pubkey: s.pubkey, stream: s.stream_name, name: s.name,
      description: s.description, cadence_seconds: s.cadence_seconds, price: formatEther(listingOf(s).price),
      record: records.find((r) => r.pubkey === s.pubkey && r.stream === s.stream_name)?.markText ?? null }));
    const { market: mk } = await nostrStatus();
    return { forSale, selling: mk?.selling ?? [], bought: mk?.bought ?? [] };
  },
  /**
   * Follow a free stream: its data kept (Streams, the engine's inputs). { predict: true } predicts it too: its
   * `<stream>_pred` is published to the relays on each new observation (or setPredict later).
   */
  async subscribe(pubkey, stream, { predict = false } = {}) {
    ready();
    return setSubscribed(String(pubkey ?? '').trim().toLowerCase(), stream, true, { predict });
  },
  /** Predict a followed stream, or stop (its `_pred` tombstoned; still followed). → its view */
  async setPredict(pubkey, stream, on) {
    ready();
    const r = await nostr.setPredict(String(pubkey ?? '').trim().toLowerCase(), stream, on);
    await refreshNostr();
    return r;
  },
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
  async sell(stream, price = DEFAULT_PRICE) { ready(); return marketAction('sell', () => nostr.sell(stream, price ?? DEFAULT_PRICE)); },
  /** That stream free again. → nostr() */
  async unsell(stream) { ready(); return marketAction('unsell', () => nostr.unsell(stream)); },
  /**
   * Buy a stream sold on the Satori contract (only on the person's request; needs Unlock; gas): the wallet opens a channel
   * with `deposit` SATORI (100 observations by default). → nostr().market.bought's entry
   */
  async buy(pubkey, stream, deposit) { ready(); return marketAction('buy', () => nostr.buy(String(pubkey ?? '').trim().toLowerCase(), stream, deposit)); },
  /** Stop buying: the alias asks to close the channel (gas, no Unlock); the rest comes back to the wallet after 7 days. → the same */
  async stop(pubkey, stream) { ready(); return marketAction('stop', () => nostr.stopBuying(String(pubkey ?? '').trim().toLowerCase(), stream)); },
  /**
   * After a stopped channel's grace period, take back `amount` SATORI (all that is left by default) to `to` (the wallet by
   * default); the channel stays, and buy() of that stream uses it again (needs Unlock; gas). → nostr().market.bought's entry
   */
  async takeBack(channel, amount, to) { ready(); return marketAction('takeBack', () => nostr.takeBack(channel, amount, to)); },
  /**
   * A bought or sold channel's grace period in `days` (needs Unlock; gas): longer by the buyer or shorter by the seller
   * applies at once, otherwise it is asked of the other side. → { applied, grace } (seconds)
   */
  async setGrace(channel, days) { ready(); return marketAction('setGrace', () => nostr.setGrace(channel, days)); },
  /** Where a buyer's channel of ours pays its settlements (needs Unlock; gas). → that buyer's entry in nostr().market.selling */
  async setPayout(channel, address) { ready(); return marketAction('setPayout', () => nostr.setPayout(channel, address)); },
  /** Settings: { relays: ['wss://…'], centralWrite: boolean }, either or both. → nostr() */
  async setRelays(settings) { ready(); const s = await nostr.setRelays(settings); await refreshNostr(); return s; },
  /** Base: a fresh read of the chain (one multicall) and the last batch. */
  async base() { ready(); await base.refresh(); return base.status(); },
  /** Stake with this neuron (needs Unlock): the wallet's prediction power to the alias. → { steps: [{ step, by, hash }], settled } */
  async stake() { ready(); return baseAction('stake', walletOps.delegate); },
  /** A fresh wallet link to this app's alias, sent at once (needs Unlock, or a connected wallet's approval). → the register's answer */
  async relink() { ready(); return baseAction('link', relinkWallet); },
  /** Unstake (needs Unlock): the SATORI can be sent once the next round ends. → the same shape */
  async unstake() { ready(); return baseAction('unstake', walletOps.undelegate); },
  /** hub.claim(), the merkle drop, the airdrop, from the wallet (needs Unlock). → { rewards, merkle, airdrop } */
  async claim() { ready(); return baseAction('claim', walletOps.claim); },
  /** The alias's daily batch now, if this round has none yet. → the check's result */
  async predictBase() { ready(); const r = await base.predict(); await refreshBase(); return r; },
  /** The review before a send, no key needed: { asset, to, amount } → { asset, to, amount, fee: { gas, about, max } } */
  async quoteSend(o) { ready(); return base.quoteSend(o); },
  /** From the wallet, with its passphrase each time: { asset: 'ETH' | 'SATORI', to: '0x…', amount: '1.5', passphrase } → { hash } */
  async send(o) { ready(); return baseAction('send', () => walletOps.send(o)); },
  /** Preload gas: Base ETH from the wallet to this app's alias (it pays the daily batch's gas); `amount` defaults to base().alias.preload. → { hash } */
  async preloadGas({ amount, passphrase } = {}) {
    ready();
    const to = state.base.alias.address;
    return baseAction('send', () => walletOps.send({ asset: 'ETH', to, amount: amount ?? state.base.alias.preload, passphrase }));
  },
  /** The Base RPC: an https URL, a same-origin path, or '' for the default. → base() */
  async setBaseRpc(url) { ready(); return setBaseSettings({ rpc: url }); },
  /** The unattended batch's ceiling on the max fee per gas, in gwei (null or '' = the default, 2). → base() */
  async setBaseMaxFee(gwei) { ready(); return base.setSettings({ maxFee: gwei }); },
  /** Who sends the Satori contract predictions: 'auto' (the daily batch) or 'manual' (the Game tab: not sent). → base() */
  async setPlay(mode) { ready(); const v = await base.setPlay(mode); state.base = v; return v; },
  /**
   * The daily reminder (docs/design/push.md): on, this browser asks for notification permission and subscribes; once a
   * day, if today's predictions aren't in, the app sends them in the background, or a notification reminds the person.
   * → reminder() */
  async setReminder(on) {
    ready();
    if (typeof on !== 'boolean') throw new Error('setReminder(true) or setReminder(false).');
    await turnReminder(on, reminderPlayer());
    return this.reminder();
  },
  /** { supported, on, minute, note }: whether this browser can take the daily reminder, whether it is on, its time (minute
   * of the local day: when it was turned on), and why not. */
  reminder() { const { supported, on, minute, note } = state.reminder; return { supported, on, minute, note }; },
};

/** When this neuron began: the log's first session, or the keys' creation when earlier (records before it have none). */
const since = () => Math.min(activity.first() ?? Infinity, session.record?.created ?? Infinity);

/** Home's health, kept current from the log and the statuses (the UI's; agents' health() reads fresh). */
watch(() => {
  if (state.screen !== 'home' || !activity) return;
  void state.activityRev; // the log changed
  state.health = healthOf({ now: state.now, rows: activity.rows(), central: state.central, base: state.base, nostr: state.nostr,
    storage: state.storage, app: state.app, backedUp: !!state.backupAt, since: since(), installDismissed: state.installDismissed,
    nextStepDismissed: state.nextStepDismissed, work: state.work });
});

/**
 * What the neuron is doing, at a pace a person can read (src/ui/hold.js; docs/design/health.md#work): the hero (central's
 * poll, the Base batch, the wallet's actions, a critical one first: its ring turns, its line says the step, its tone is
 * green, vivid while closing would lose work), the Wallet card's line (the wallet's actions, there) and the network's
 * (the Network streams line, only once one lasts a second). At rest the hero turns sky green from the tone before it
 * (data-from: over 2.5 min after work, style.css); back to work, at once.
 */
const WALLET_TASKS = ['stake', 'unstake', 'claim', 'send'];
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
watch(lineOf(WALLET_TASKS, createHold({ show: (v) => { state.actionLine = v.line; } })));
watch(lineOf(['discover', 'subscribe'], createHold({ delay: 1000, show: (v) => { state.networkLine = v.line; } })));
watch(lineOf(['watch'], createHold({ show: (v) => { state.watchLine = v.line; } }))); // Streams › Prediction streams: the scan's step
/** Streams › Prediction streams: read when the tab shows, and when the watched set changes (nostr's status). */
watch(() => {
  void state.nostr.watching;
  if ((state.tab === 'streams' || state.tab === 'market') && state.screen === 'home') refreshRecords();
});
/** The Market tab: what the relays offer, asked for when it opens and nothing is known yet. */
watch(() => state.tab === 'market' && state.screen === 'home', (open) => {
  if (open && !state.catalog.length && !state.discovering) void actions.discover();
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

/**
 * A day on Home's strip: its network predictions marked against no change (each stream's values from the day before
 * to two days after), its contract calls with their results (each stream's history on the chain, once per stream).
 */
async function dayDetail(date) {
  const [a, b] = dayRange(date);
  const sent = await db.sentBetween(a, b);
  const obs = await db.observationsBetween([...new Set(sent.map((p) => p.stream_uuid))], a - 86400, b + 2 * 86400);
  const predictions = sent.map((p) => ({ ...p, mark: networkMark(p, obs.get(p.stream_uuid)) }));
  const day = dayOf({ date, rows: activity.rows(), predictions });
  const histories = new Map();
  const historyOf = (id) => {
    if (!histories.has(id)) histories.set(id, base.chainHistory(id).then((h) => h.map((v) => ({ hour: Number(v.hour), value: v.value }))).catch(() => null));
    return histories.get(id);
  };
  for (const batch of day.contract.batches) {
    if (!batch.calls) continue;
    batch.calls = await Promise.all(batch.calls.map(async (c) => {
      const h = await historyOf(c.streamId);
      return { ...c, result: h ? callResult(c, h) : null };
    }));
  }
  return day;
}

/** Home's chips glow while their channel has real traffic (src/traffic.js, src/ui/glow.js): data-live on the chip. */
function glowChips() {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  subscribe(createGlow({ reduced: () => motion.matches,
    apply: (channel, on) => document.querySelector(`[data-test=chip][data-channel=${CHIP_OF[channel]}]`)?.toggleAttribute('data-live', on) }));
}

/**
 * Home's hero fits its text; when that changes height (a line wraps, the last visit's line goes) the box grows or
 * shrinks over 250 ms instead of snapping the page under it (docs/design/health.md#the-hero). Reduced motion: none.
 */
function smoothHero() {
  const hero = document.querySelector('[data-test=health]');
  if (!hero || typeof ResizeObserver === 'undefined') return;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let last = 0;
  let easing = null; // its own height animation: only that is cancelled (the fade to sky is a CSS transition on the hero)
  new ResizeObserver(() => {
    easing?.cancel();
    easing = null;
    const now = hero.getBoundingClientRect().height;
    if (last && now && now !== last && !motion.matches) {
      easing = hero.animate([{ height: `${last}px` }, { height: `${now}px` }], { duration: 250, easing: 'ease' });
    }
    if (now) last = now;
  }).observe(hero.lastElementChild);
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
  else if (readPref(GAME_KEY, ['in', 'out'], 'out') === 'in') state.tab = 'game'; // no route: where they were playing
  render(root, actions);
  watch(() => writePref(GAME_KEY, state.tab === 'game' ? 'in' : 'out'));
  // the Game tab reads its streams when it opens (again after 5 min or a send), once the app runs; not while it is open
  watch(() => state.tab === 'game' && state.screen === 'home', (open) => {
    const g = state.game;
    if (open && !g.loading && (!g.loaded || g.sent || Date.now() - g.loaded > 5 * 60_000)) void actions.loadGame();
  });
  applyTheme(state.theme); // public/theme.js set data-theme before the first paint; this, the browser bar's color too
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { state.systemDark = e.matches; });
  glowChips();
  smoothHero();
  startPwa();
  followNotifications();
  // one tab runs the neuron; another waits, says so, and takes over when that one closes (no reload)
  releaseTab = await claimTab(undefined, undefined, { onWait: () => { state.screen = 'elsewhere'; } });
  if (state.screen === 'elsewhere') state.screen = 'loading';
  wallets = await readWallets().catch(() => null); // IndexedDB can't say: the first wallet, as before any list
  dbPath = pathOf(activeOf(wallets));
  state.wallets = walletsView(wallets);
  const fresh = await hasDatabase(dbPath).then((has) => !has, () => false); // OPFS can't say: the usual way
  dbOpening = openOpfsDb(dbPath, { onStep: (e) => { state.engine = e; } });
  dbOpening.catch(() => {}); // boot's own await reports it
  if (fresh) state.screen = 'setup';
  else if (state.tab === 'home') state.cached = readSnapshot();
  try {
    db = await dbOpening;
    state.engine = { step: 'ready' };
    registerWorker();
    state.recovered = db.recovered; // a WAL DuckDB could not replay, set aside (docs/design/storage.md#recovery)
    if (fresh) return; // Setup is on screen: it writes the keys (saveKeys)
    if (!(await session.load())) return void Object.assign(state, { screen: 'setup', cached: null }); // migration 7 translated earlier rows
    state.retiredKeys = session.retired;
    // an earlier version's wallet whose public key was not in clear: the neuron needs it (register, the Base address)
    const w = session.walletPublic;
    if (!w.pubkey && !w.connected) return void Object.assign(state, { screen: 'finish', cached: null });
    await startNeuron();
  } catch (err) {
    // the database file itself won't open (damaged): offer to set it aside; anything else, "could not start"
    state.fatal = err?.dbFile ? `The database file could not be opened: ${err?.message ?? err}` : `The app did not start: ${err?.message ?? err}`;
    Object.assign(state, { screen: err?.dbFile ? 'damaged' : 'fatal', cached: null });
  }
}

boot();
