// The neuron's flow, as Satori Lite runs it (docs/design/central.md):
//   page load → register with central, then poll at once (a stored time still ahead is kept), then every 11 h:
//   poll ─▶ store (insert or ignore) ─▶ history for new streams ─▶ forecast each stream whose latest observation has no
//   prediction yet (a new row, or one an interrupted cycle stored) ─▶ send everything pending
// The forecasts: each target's own bvar spec, evolved after each poll (docs/design/engine.md).
import { normalizeObservation, predictionItem } from '../central/index.js';
import { evmAddress } from '../keys/keys.js';
import { runModelsAsync } from '../engine/evolve.js';
import { createSchedule } from './schedule.js';
import { backfillHistory } from './history.js';
import { fitKey, statsFrom } from './train.js';

export const POLL_EVERY_S = 11 * 3600; // start.py:4785-4876
export const BATCH_LIMIT = 100;
export const KEEP_PENDING_S = 2 * POLL_EVERY_S; // the cap on the kept queue (Lite's in-memory queue has none)
/** After a failed cycle: tries again 2, 10 and 30 min later, then on the 11 h rhythm (docs/design/central.md#errors). */
export const RETRY_S = [120, 600, 1800];

/**
 * When the next poll is due after a cycle that ended at `at`, with `failures` failed cycles in a row: 11 h after a good
 * one; after a failure, the next of RETRY_S, then 11 h, and that try's failure starts the retries again.
 */
export function nextPollAfter(failures, at) {
  if (!failures) return at + POLL_EVERY_S;
  return at + (RETRY_S[(failures - 1) % (RETRY_S.length + 1)] ?? POLL_EVERY_S);
}

/** A cycle that failed: its poll or submission had an error (a local one too), or central took none of the batch. */
export const failedCycle = (r) => !!(r?.poll?.error || r?.submit?.error || (r?.submit && !(r.submit.successful > 0)));

const nowS = () => Date.now() / 1000;
const errorText = (err) => String(err?.message ?? err);
/** Central was not reached at all (a network error or a timeout: CentralError status 0), as Home names it. */
const reach = (err) => (err?.status === 0 ? { unreachable: true } : {});

/**
 * Register with central (on every start). Never throws: the result says what
 * happened and whether central pays this vault: `vault` (this vault's Base
 * address), `vault_base_address` (central's answer: the Base address it pays
 * this vault's rewards to) and vaultMismatch: false (the same address, in any
 * letter case), 'other' (a different one), 'none' (null: central kept no
 * vault) or null (unknown: a central without the field, as prod on main).
 */
export async function register({ central, vaultPubkey, nostrPubkey, now = nowS }) {
  const at = now();
  try {
    const r = await central.register({ vaultPubkey, nostrPubkey });
    const vault = evmAddress(vaultPubkey);
    const known = r != null && Object.hasOwn(r, 'vault_base_address');
    const theirs = known ? r.vault_base_address ?? null : null;
    const vaultMismatch = !known ? null : theirs == null ? 'none' : String(theirs).toLowerCase() === vault.toLowerCase() ? false : 'other';
    return { at, ok: true, peer_id: r?.peer_id ?? null, message: r?.message ?? '', vault, vault_base_address: theirs, vaultMismatch };
  } catch (err) {
    return { at, ok: false, error: errorText(err) };
  }
}

/** Lite's batch item, rebuilt from the stored prediction: the same bytes as when it was made. */
const toItem = (p) => predictionItem({ streamUuid: p.stream_uuid, streamName: p.name, t1: p.t1, t2: p.t2, now: p.made_at });

/**
 * Send every pending prediction made in the last 2 × 11 h (older ones are
 * dropped). successful > 0 marks them all sent; anything else keeps them
 * (engine.py:446-454).
 */
async function submit(db, central, now, report) {
  await db.dropPending(now() - KEEP_PENDING_S);
  const pending = await db.pending();
  if (!pending.length) return null;
  report('send', null, pending.length);
  let result;
  try {
    const r = await central.submitPredictions(pending.map(toItem));
    result = { at: now(), total_submitted: r?.total_submitted ?? pending.length, successful: r?.successful ?? 0,
      failed: r?.failed ?? 0, errors: r?.errors ?? null };
    if (result.successful > 0) await db.markSent(pending.map((p) => p.id), result.at);
  } catch (err) {
    // how many it tried to send, and whether central refused the login (docs/design/health.md)
    result = { at: now(), error: errorText(err), total_submitted: pending.length, ...(err?.login ? { login: true } : {}), ...reach(err) };
  }
  await db.set('central_last_submit', result);
  return result;
}

async function pollAndSubmit({ db, central, engine, now, at, seed, backfill, report }) {
  report('observations');
  let batch;
  try {
    batch = await central.observations(BATCH_LIMIT);
    if (!Array.isArray(batch)) throw new Error('the Satori Network sent no list of observations');
  } catch (err) {
    const poll = { at, error: errorText(err), ...reach(err) };
    await db.set('central_last_poll', poll);
    return { poll, submit: null };
  }
  const rows = batch.map(normalizeObservation).filter(Boolean);
  const fresh = await db.addObservations(rows);
  await backfill({ onProgress: (done, total) => report('history', done, total) }); // a stream first seen gets its past now (never throws; its rows are never new)
  const poll = { at, streams: rows.length, new: fresh.length, predicted: 0 };
  // each stream in the batch whose latest observation has no prediction yet: a new row, or one a cycle cut off
  // (a reload, a local failure) stored and never forecast
  const unpredicted = new Set(await db.unpredicted());
  const due = [...new Set(rows.map((o) => o.stream_uuid))].filter((u) => unpredicted.has(u));
  if (due.length) {
    report('models', 0, due.length);
    const histories = await db.centralHistories();
    const specs = await db.specs();
    const t0 = performance.now();
    const out = await engine({ fresh: due, histories, specs, seed, onProgress: (done, total) => report('models', done, total) });
    poll.engine_ms = Math.round(performance.now() - t0);
    // each spec with the key of the data it was fit on: current, until new history comes (src/neuron/train.js)
    const stat = statsFrom(histories);
    for (const [u, row] of out.specs) row.fit_key = fitKey(u, row.spec, stat);
    await db.saveSpecs(out.specs, Math.floor(now()));
    const made = [];
    for (const uuid of due) {
      const f = out.forecasts.get(uuid);
      if (!f) continue;
      const made_at = now();
      const { observed_at, hash } = predictionItem({ t1: f.t1, t2: f.t2, now: made_at });
      made.push({ stream_uuid: uuid, made_at, model: f.model, t1: f.t1, t2: f.t2, phi: f.phi, weight: f.weight, observed_at, hash,
        obs_ts: histories.get(uuid).at(-1).ts }); // the observation it is made from: predicted once
    }
    await db.addPredictions(made); // one transaction: every commit is a checkpoint (docs/design/storage.md)
    poll.predicted = made.length;
  }
  await db.set('central_last_poll', poll);
  const sent = await submit(db, central, now, report);
  await db.checkpoint();
  return { poll, submit: sent };
}

/**
 * One cycle: poll → store → history for new streams → forecast each stream in
 * the batch whose latest observation has no prediction yet → submit. Never
 * throws: a failed poll or a local failure (the database) is the poll's error;
 * a failed submission keeps the queue.
 * @param {{db, central, now?: () => number, seed?: string, engine?: typeof runModelsAsync, backfill?: Function,
 *   report?: (step: string, done?: number|null, total?: number|null) => void}} o
 *   seed: the identity's public key (the specs' RNG); engine: one poll's models (src/engine/evolve.js);
 *   backfill({ onProgress }): central's history; report: each step as it begins, and its count (src/neuron/work.js):
 *   'observations', 'history' (streams in hand of those needing it), 'models' (targets done), 'send' (what is pending)
 * @returns {Promise<{poll: object, submit: object | null}>}
 */
export async function cycle({ db, central, now = nowS, seed = '', engine = runModelsAsync,
  backfill = ({ onProgress } = {}) => backfillHistory({ db, central, now, onProgress }), report = () => {} }) {
  const at = now();
  try {
    return await pollAndSubmit({ db, central, engine, now, at, seed, backfill, report });
  } catch (err) {
    console.error('[satori] cycle failed', err);
    const poll = { at, error: errorText(err), local: true }; // not central's: the database or the engine
    await db.set('central_last_poll', poll).catch(() => {});
    return { poll, submit: null };
  }
}

/**
 * When the first poll after a (re)load is due: a stored time still ahead (by
 * at most 11 h) is kept, so a reload doesn't reset the schedule; otherwise
 * (a new neuron, a poll that came due while closed) now. Lite waits a random
 * 5–30 min on every start; browser opens are not synchronized, so this has no
 * herd to spread (docs/design/central.md#deviations).
 */
export function firstPollAt(stored, now) {
  return typeof stored === 'number' && stored > now && stored <= now + POLL_EVERY_S ? stored : now;
}

/**
 * The schedule: start() arms the first poll (meta.next_poll_at); each poll,
 * from the timer or poll(), runs `run` and arms the next one when it ends:
 * 11 h after a good cycle, and after a failed one (failedCycle, or a run that
 * threw) 2, 10, 30 min, then 11 h (nextPollAfter). The time and the count of
 * failures in a row are stored (meta.next_poll_at, meta.poll_failures), so a
 * reload keeps the retries. One run at a time: poll() during a run returns
 * it; idle() waits for it without starting one; online() polls at once after
 * a failure (the network is back). onChange({ next, running }) follows them.
 * With `work` (src/neuron/work.js), each poll is central's work from its
 * start until the next one is armed, so Home shows its steps
 * (run(report): report(step, done, total)) and, after them, the next time,
 * never "next now…".
 */
export function createPoller(run, { db, work = null, now = nowS, setTimeout, clearTimeout, onChange = () => {} }) {
  let job = null; // the poll in progress, as central's work
  let failures = 0; // failed cycles in a row
  const s = createSchedule(() => run(job?.step ?? (() => {})), {
    now, setTimeout, clearTimeout, name: 'poll',
    after: ({ result, error } = {}) => {
      failures = error || failedCycle(result) ? failures + 1 : 0;
      return nextPollAfter(failures, now());
    },
    onChange: () => {
      if (s.running) job ??= work?.start('central') ?? null;
      onChange({ next: s.next, running: s.running });
      if (!s.running && job) { // after the next poll is armed
        job.end();
        job = null;
      }
    },
    async onArm(at) {
      try {
        await db.set('next_poll_at', at);
        await db.set('poll_failures', failures);
        await db.checkpoint(); // OPFS keeps what is checkpointed; a tab may close at any time
      } catch (err) {
        console.error('[satori] saving the next poll time', err);
      }
    },
  });
  return {
    start: async () => {
      failures = Number(await db.get('poll_failures')) || 0;
      return s.start(firstPollAt(await db.get('next_poll_at'), now()));
    },
    poll: s.run,
    /** Back online after a failed cycle: the poll now (not in 2 min); else null (no failure, or one is running). */
    online: () => (failures > 0 && !s.running ? s.run() : null),
    /** The poll now when its time has passed and none runs (the device slept: timers don't count it); else null. */
    catchUp: s.catchUp,
    idle: s.idle,
    get next() { return s.next; },
    get running() { return s.running; },
    /** Failed cycles in a row (0 after a good one). */
    get failures() { return failures; },
  };
}

/**
 * Central's state for the UI and agents (window.satori.status().central): plain values. The schedule's is read last,
 * once the reads are done, so a status begun during a poll that ended meanwhile never says it still runs.
 */
export async function centralStatus({ db, central, registration, poller }) {
  const lastPoll = (await db.get('central_last_poll')) ?? null;
  const lastSubmit = (await db.get('central_last_submit')) ?? null;
  const pending = await db.pendingCount();
  // central's history (history.js): the last backfill, and how many streams still have none
  const history = { ...((await db.get('central_history')) ?? {}), needed: (await db.needHistory()).length };
  return { url: central?.url ?? null, registration, lastPoll, nextPoll: poller?.next ?? null, polling: !!poller?.running,
    failures: poller?.failures ?? 0, lastSubmit, pending, history };
}

/**
 * The one tab that runs the neuron (docs/design/pwa.md#one-neuron): a Web Lock, held for the life of the page, so only
 * one tab opens the database. The request is queued (no ifAvailable): a second tab waits (onWait, once it has not got the
 * lock within waitMs) and becomes the neuron as soon as the first closes. → resolves once this tab holds it.
 */
export async function claimTab(name = 'satori-neuron', locks = globalThis.navigator?.locks, { onWait = () => {}, waitMs = 300 } = {}) {
  if (!locks) return;
  let held = false;
  const got = new Promise((resolve) => {
    locks.request(name, () => {
      held = true;
      resolve();
      return new Promise(() => {}); // kept until the page goes
    });
  });
  await Promise.race([got, new Promise((r) => setTimeout(r, waitMs))]);
  if (!held) onWait();
  await got;
}
