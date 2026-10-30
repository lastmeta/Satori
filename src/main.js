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
import { openOpfsDb, hasDatabase, setAsideOpfsDb, readStoredKeys } from './db/opfs.js';
import { checkWalletPassphrase, evmAddress, connectedRecord, linkMessage } from './keys/index.js';
import { requestAddress, signText } from './keys/connect.js';
import { openRelay, RELAYS } from './keys/relay.js';
import { DEFAULTS as CHAIN } from './chain/config.js';
import { same, UP, DOWN } from './chain/index.js';
import { createAutoLock } from './keys/autolock.js';
import { createCentral } from './central/index.js';
import { cycle, register, createPoller, centralStatus as statusOf, claimTab, firstPollAt } from './neuron/index.js';
import { catchUpAll } from './neuron/schedule.js';
import { modelsOf, modelDetail, DESTS } from './neuron/models.js';
import { createTrainer } from './neuron/train.js';
import { createRetrain } from './neuron/retrain.js';
import { box as modelBox, modelHref } from './ui/models.js';
import { backfillHistory } from './neuron/history.js';
import { createNostr } from './neuron/nostr.js';
import { callResult, dayOf, dayRange, networkMark } from './neuron/day.js';
import { createBase, checkSend } from './neuron/base.js';
import { referrerOf } from './neuron/referral.js';
import { played } from './ui/gameflow.js';
import { sendsToday } from './neuron/play.js';
import { formatEther, getAddress, isAddress, zeroAddress } from 'viem';
import { ROLE_IDS, roleOf, doneText } from './neuron/roles.js';
import { payeeName } from './neuron/devfee.js';
import { createReward } from './neuron/reward.js';
import { createActivity } from './neuron/activity.js';
import { healthOf, toneOf, CHIP_OF } from './neuron/health.js';
import { createWork, workText, leading, HERO } from './neuron/work.js';
import { createHold } from './ui/hold.js';
import { subscribe } from './traffic.js';
import { createGlow } from './ui/glow.js';
import { applyTheme } from './ui/theme.js';
import { readPref, writePref, GAME_KEY, snapshotOf, readSnapshot, writeSnapshot, dropSnapshot } from './ui/prefs.js';
import { readWallets, writeWallets, setAsideWalletFile, activeOf, pathOf, withAdded, withAddress, withActive, withName, withoutWallet, walletsView, appGet, appPut } from './wallets.js';
import { deviceKey } from './keys/atrest.js';
import { createSession } from './session.js';
import { createKeyring } from './keyring.js';
import { createAgent } from './agent.js';
import { createActions } from './actions.js';
import { HANDOFF, SW_BATCH } from './pwa/handoff.js';
import { isHttps } from './util.js';
import { defaultsFrom, DEV_DEFAULTS, BUILD_DEFAULTS, versionOf } from './config.js';
import { shortHash, fmtNum } from './ui/format.js';
import { startPwa, registerWorker, keepStorage } from './pwa/index.js';
import { startReminder, followPlayer, followNotifications } from './pwa/push.js';

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
let foundWallets = []; // Setup's Connect: the wallets in this browser, with their providers
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
/** The wallet's signer while it is open (src/keyring.js): held nowhere else. */
const keyring = createKeyring({ session, projectId: DEFAULTS.walletConnect });

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
  void refreshDevFee();
  void refreshAdmin();
  void refreshRoles();
  void refreshSafe();
  // staked or unstaked, by hand or not: the reminder server's player follows (only when it changed)
  if (state.reminder.on) followPlayer(reminderPlayer()).catch((err) => console.warn('[satori] reminder', err));
});

/**
 * A special key's tab read (Dev Fee, Admin, the keys, Safe): with the Base card at most every 15 min, at once when the
 * tab opens and after each of its actions (refresh(true)); one that fails keeps the last answer (the tab is never
 * hidden by a read that did not come) and says why at state[slot].error. → { read, refresh }
 */
function tabRead(name, slot, read) {
  let at = 0;
  const run = coalesce(name, async () => {
    try {
      await read(); // in place: an action's outcome and the tally stay
      state[slot].error = '';
      at = nowS();
    } catch (err) {
      state[slot].error = err?.shortMessage ?? err?.message ?? String(err);
    }
  });
  return { read: run, refresh: (now = false) => (now || nowS() - at > 900 ? run() : undefined) };
}
/** The Dev Fee tab (docs/design/devfee.md): the splitters and the wallet in them. */
const { read: readDevFee, refresh: refreshDevFee } = tabRead('dev fee', 'devFee', async () => {
  const tree = await base.devFee();
  Object.assign(state.devFee, { tree, shown: tree.shown });
});
/** The Admin tab (docs/design/admin.md): whether the wallet is the admin, then (only then) its levers. */
const { read: readAdmin, refresh: refreshAdmin } = tabRead('admin', 'admin', async () => {
  const { admin, isAdmin } = await base.adminRole();
  const levers = isAdmin ? await base.adminState() : null;
  Object.assign(state.admin, { address: admin, shown: isAdmin, levers });
});
/** The other special keys' tabs (docs/design/roles.md): which the wallet holds, and their pages. */
const { read: readRoles, refresh: refreshRoles } = tabRead('special keys', 'roles', async () => {
  state.roles.of = await base.roles();
});
/** The Safe tab (docs/design/safe.md): the Safes the wallet owns, their keys and waiting transactions. */
const { read: readSafe, refresh: refreshSafe } = tabRead('safe', 'safe', async () => {
  state.safe.safes = (await base.safes()).safes;
});
const NOT_SAFE = "The Safe tab is only for an owner of the Safe that holds the token's keys (docs/design/safe.md).";
const theSafe = () => {
  const x = state.safe.safes?.[0];
  if (!x) throw new Error(NOT_SAFE);
  return x.address;
};
/** A Safe action (propose and sign need Unlock; execute, gas too), one at a time; then the Safe is read again. */
function safeAction(name, fn) {
  return exclusive(name, fn, 'safeBusy').finally(() => {
    autoLock.touch();
    void refreshSafe(true);
    void refreshRoles(true);
    void refreshBase();
  });
}
const notHeld = (id) => {
  const r = roleOf(id);
  return `The ${r.label} tab is only for the wallet that holds the ${r.name.toLowerCase()} key (docs/design/roles.md).`;
};
/** A special key's action (needs Unlock), one at a time; then the keys are read again. → [{ hash, label }] */
function roleAction(role, action, typed) {
  const values = state.roles.of?.[role]?.values;
  return exclusive(`${role}:${action}`, async () => {
    const txs = await base.roleAct(role, action, typed);
    return { txs, said: doneText(role, action, typed, values) };
  }, 'rolesBusy').finally(() => {
    autoLock.touch();
    void refreshRoles(true);
    void refreshAdmin(true);
    void refreshBase();
  });
}

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
    alias, walletAddress: walletPublic.evmAddress, wallet: () => keyring.wallet, chain: () => base.channels() });
  await refreshNostr();
  base = createBase({ db, alias, walletAddress: walletPublic.evmAddress, wallet: () => keyring.wallet, central: () => central, defaultRpc: DEFAULTS.rpc,
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

/** A connected wallet's app found again in this browser (src/keyring.js), or not: the app still predicts. */
async function findConnected() {
  state.connected = await keyring.findConnected();
}

const notHere = () => keyring.notHere();

/** Reconnect a phone path whose session ended: the person approves again, and it must be the same account. */
const reconnect = () => exclusive('reconnect', async () => {
  state.connected = await keyring.reconnect();
});

/** The list stored and shown. */
async function keepWallets(list) {
  await writeWallets(list);
  wallets = list;
  state.wallets = walletsView(wallets, state.wallet);
}

/** The wallet in use named (docs/design/wallets.md#names): a person's name, or (`auto`) its special key's; '' clears. */
async function nameWallet(name, { auto = false } = {}) {
  if (!state.wallet) throw new Error('Set up a wallet first.');
  await keepWallets(withName(wallets, name, { auto, address: state.wallet }));
}
/** The special key the wallet holds, as its name while it has none of its own: the admin first, then the most powerful. */
const NAMED = ['appoint', 'wiring', 'schedule', 'split', 'publisher'];
const roleName = () => (state.admin.shown ? 'Admin' : roleOf(NAMED.find((id) => state.roles.of?.[id]?.isHolder) ?? '')?.name
  ?? (state.safe.safes?.length ? 'Safe owner' : payeeName(state.devFee.tree)));
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
  const { linked, rekeyed, opened } = await keyring.unlock(passphrase, (fn) => work.run('keys', fn)); // an upgrade saved
  state.retiredKeys = session.retired;
  if (rekeyed && base) { // the running app is the old alias's: start again with the new one (docs/design/wallets.md#derived-keys)
    keyring.lock();
    return void location.reload();
  }
  if (linked && central) registerWith(central).catch(() => {}); // the Satori Service learns the link at once
  if (!opened) return;
  state.unlocked = true;
  state.unlockFor = '';
  autoLock.start();
}

/** Lock: the wallet wiped from memory, and any backup on screen hidden. */
function lock() {
  keyring.lock();
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
  const b = session.walletPublic.connected ? await keyring.connectedBackup(which) : await session.backup(which, passphrase);
  if (which == null || which === 'wallet') markBackup().catch((err) => console.warn('[satori] backup_at', err)); // the wallet's words shown: backed up
  return b;
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
  const made = calls.map((c) => ({ streamId: c.stream.streamId, name: c.stream.name, direction: c.direction })); // the Sent screen lists them
  let sent = { hash: null, by, count: calls.length, calls: made, at: Math.floor(nowS()), round };
  if (!real.length) activity.wallet('play', `Played the game by hand: ${calls.length} prediction${calls.length === 1 ? '' : 's'}`); // the round's were sent already
  if (real.length) {
    const r = await baseAction('play', () => base.playHand(real.map((c) => ({ gameId: c.stream.gameId, direction: c.direction }))));
    publishContract(real.map((c) => ({ streamId: c.stream.streamId, direction: c.direction })), r.at);
    activity.wallet('play', `Sent ${real.length} prediction${real.length === 1 ? '' : 's'} to the Satori contract by hand`);
    sent = { ...r, count: calls.length, calls: made };
  }
  await base.notePlay(sent).catch((err) => console.warn('[satori] game', err));
  return sent;
}

/** A Base action, one at a time; then the card is read again. It counts as an interaction (the wallet's 5 minutes). */
const baseAction = (what, fn) => exclusive(what, fn, 'baseBusy').finally(() => {
  autoLock.touch();
  void refreshBase();
});

const NOT_ADMIN = "The Admin tab is only for the Satori contract's admin (docs/design/admin.md).";
const fixAddress = (a) => (isAddress(String(a ?? '').trim()) ? getAddress(String(a).trim()) : '');
/** What an Admin action did, in its card (docs/design/admin.md#the-cards). */
const ADMIN_DONE = {
  capabilities: () => 'Saved: the capabilities are as ticked now.',
  game: (gameId, approved) => {
    const g = state.admin.levers?.games.find((x) => x.gameId === Number(gameId));
    const name = g ? `"${g.name}"` : `Game ${gameId}`;
    return approved ? `${name} is approved: it can earn now.` : `${name} is disapproved: it earns nothing now.`;
  },
  relayer: (to) => (fixAddress(to) && fixAddress(to) !== zeroAddress ? `The official relayer is ${shortHash(fixAddress(to))} now.` : 'There is no official relayer now.'),
  registrationFee: (v) => `The registration fee is ${String(v).trim()} SATORI now.`,
  reporter: (to) => (fixAddress(to) && fixAddress(to) !== zeroAddress ? `The off-chain reporter is ${shortHash(fixAddress(to))} now.` : 'Off-chain reporting is off.'),
  registerAdapter: (kind, impl, name) => `Registered the ${kind} adapter "${String(name).trim()}".`,
  transfer: (to) => `Transferred: ${shortHash(fixAddress(to))} is the admin now.`,
};
/** An Admin action (needs Unlock), one at a time; then the tab is read again. → [{ hash, label }] */
function adminAction(op, ...args) {
  return exclusive(op, () => base.adminAct(op, ...args), 'adminBusy').finally(() => {
    autoLock.touch();
    void refreshAdmin(true);
    void refreshBase();
  });
}

const NOT_DEV_FEE = "The Dev Fee tab is only for a wallet in the dev fee's splitters (docs/design/devfee.md).";
/** What a Dev Fee action did, in its card (docs/design/devfee.md#the-cards). */
const DEV_FEE_DONE = {
  claim: (amount) => `Claimed ${amount} SATORI.`,
  trigger: (caller) => (caller ? `Only ${shortHash(caller)} (and you) can trigger your payout now.` : 'Anyone can trigger your payout again.'),
  moveSlot: (to) => `Moved: ${shortHash(to)} holds the slot now.`,
  vote: (to) => `You agreed to redirect it to ${shortHash(to)}.`,
  unvote: () => 'Your agreement is taken back.',
  redirect: (to) => `Redirected to ${shortHash(to)}.`,
  offer: (to) => `Offered to ${shortHash(to)}: it moves when they accept.`,
  accept: () => 'You hold its authority now.',
  giveUp: () => "Given up for good: only its payees' agreement can redirect it now.",
};
/** A Dev Fee action (needs Unlock), one at a time; the activity log says a claim; then the tab is read again. → [{ hash, label }] */
function devFeeAction(op, splitter, ...args) {
  return exclusive(`${op}:${splitter}`, async () => {
    const mine = state.devFee.tree?.mine.find((m) => same(m.node, splitter));
    const txs = await base.devFeeAct(op, splitter, ...args);
    if (op === 'claim' && mine) activity.wallet('claim', `Claimed ${fmtNum(Number(formatEther(mine.claimable + mine.waiting)))} SATORI of the dev fee`);
    return txs;
  }, 'devFeeBusy').finally(() => {
    autoLock.touch();
    void refreshDevFee(true);
    void refreshBase();
  });
}

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
    const r = session.walletPublic.connected ? await base.send(o, keyring.wallet ?? (() => { throw notHere(); })())
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
  if (tab === 'devfee' && state.devFee.tree && !state.devFee.shown) throw new Error(NOT_DEV_FEE);
  if (tab === 'admin' && state.admin.address && !state.admin.shown) throw new Error(NOT_ADMIN);
  if (ROLE_IDS.includes(tab) && state.roles.of && !state.roles.of[tab].held) throw new Error(notHeld(tab));
  if (tab === 'safe' && state.safe.safes && !state.safe.safes.length) throw new Error(NOT_SAFE);
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
  if (keyring.wallet) return fn();
  if (state.connected) return void (state.baseError = notHere().message); // nothing to unlock: its wallet app is elsewhere
  afterUnlock = fn;
  Object.assign(state, { unlockFor: slot, unlockError: '' });
  requestAnimationFrame(() => document.querySelector(`[data-unlock-for="${slot}"] input`)?.focus());
  return undefined;
}

/**
 * A fresh link (issued now), signed by the wallet, kept with the keys and sent with a register at once. The Satori Service
 * keeps the newest link per wallet, so this takes the wallet back from another app's alias (docs/design/wallets.md).
 */
async function relinkWallet() {
  const { wallet } = keyring;
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

// ── UI actions (src/actions.js) ──────────────────────────────────────────────
const actions = createActions({
  ADMIN_DONE, DEFAULTS, DEV_FEE_DONE, addWallet, adminAction, autoLock, backupOf, baseAction, connectTo, dayDetail,
  devFeeAction, exclusive, finishUpdate, go, keyring, lock, marketAction, nameWallet, nowS, playCalls, pollNow,
  readRewardNow, reconnect, recordOf, refreshAdmin, refreshBase, refreshDevFee, refreshNostr, refreshRoles,
  refreshSafe, relinkWallet, reminderPlayer, removeNeeds, removeWallet, retiredText, roleAction, safeAction, session,
  setAsideDb, setBaseSettings, setCentral, setReward, setSubscribed, setup, switchWallet, theSafe, unlock, walletOps,
  withWallet,
  get afterUnlock() { return afterUnlock; },
  set afterUnlock(v) { afterUnlock = v; },
  get base() { return base; },
  get db() { return db; },
  get foundWallets() { return foundWallets; },
  set foundWallets(v) { foundWallets = v; },
  get fromList() { return fromList; },
  set fromList(v) { fromList = v; },
  get nostr() { return nostr; },
  get pending() { return pending; },
  set pending(v) { pending = v; },
  get retrain() { return retrain; },
  get reward() { return reward; },
});

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
/** The Dev Fee tab: read again when it opens; not for this wallet (a #devfee link, or a slot moved away): Home. */
watch(() => state.tab === 'devfee' && state.screen === 'home', (open) => { if (open) void refreshDevFee(true); });
watch(() => {
  if (state.tab === 'devfee' && state.devFee.tree && !state.devFee.shown) {
    state.tab = 'home';
    history.replaceState(null, '', '#home');
  }
});
/** A wallet with no name of its own takes its special key's ("Admin"); one that no longer holds it loses that name. */
watch(() => {
  const me = state.wallets.wallets.find((w) => w.active);
  if (!me || !state.wallet || !state.admin.address || !state.roles.of || !state.safe.safes || !state.devFee.tree) return; // the keys not read yet
  if (me.name && !me.nameAuto) return; // the person's own name wins
  const role = roleName();
  if (role && me.name !== role) nameWallet(role, { auto: true }).catch((err) => console.warn('[satori] wallet name', err));
  else if (!role && me.nameAuto) nameWallet('').catch((err) => console.warn('[satori] wallet name', err));
});
/** A special key's tab: read again when it opens; not held (a link, or handed on): Home. */
watch(() => ROLE_IDS.includes(state.tab) && state.screen === 'home', (open) => { if (open) void refreshRoles(true); });
watch(() => {
  if (ROLE_IDS.includes(state.tab) && state.roles.of && !state.roles.of[state.tab]?.held) {
    state.tab = 'home';
    history.replaceState(null, '', '#home');
  }
});
/** The Safe tab: read again when it opens; no Safe of this wallet's: Home. */
watch(() => state.tab === 'safe' && state.screen === 'home', (open) => { if (open) void refreshSafe(true); });
watch(() => {
  if (state.tab === 'safe' && state.safe.safes && !state.safe.safes.length) {
    state.tab = 'home';
    history.replaceState(null, '', '#home');
  }
});
/** The Admin tab: read again when it opens; not for this wallet (a #admin link, or the admin handed on): Home. */
watch(() => state.tab === 'admin' && state.screen === 'home', (open) => { if (open) void refreshAdmin(true); });
watch(() => {
  if (state.tab === 'admin' && state.admin.address && !state.admin.shown) {
    state.tab = 'home';
    history.replaceState(null, '', '#home');
  }
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

/** window.satori (src/agent.js): the same app for agents (see /llms.txt). */
window.satori = createAgent({
  DEFAULTS, VERSION, actions, addWallet, adminAction, backupOf, baseAction, centralStatus, centralUuid, connectTo,
  dayDetail, detailOf, devFeeAction, exclusive, finishUpdate, go, listModels, lock, marketAction, nameWallet,
  nowS, playCalls, pollNow, readAdmin, readDevFee, readRewardNow, readRoles, readSafe, refreshBase, refreshNostr,
  relinkWallet, reminderPlayer, removeWallet, retrainOf, roleAction, safeAction, session, setAsideDb,
  setBaseSettings, setCentral, setReward, setSubscribed, setup, since, switchWallet, theSafe, unlock, walletOps,
  work,
  get activity() { return activity; },
  get base() { return base; },
  get db() { return db; },
  get foundWallets() { return foundWallets; },
  set foundWallets(v) { foundWallets = v; },
  get nostr() { return nostr; },
  get retrain() { return retrain; },
  get trainer() { return trainer; },
  get wallets() { return wallets; },
});

boot();
