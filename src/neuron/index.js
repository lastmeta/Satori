// The neuron's flow, as Satori Lite runs it (docs/design/central.md):
//   page load → register with central; first poll 5–30 min later, then every 11 h:
//   poll ─▶ store (insert or ignore) ─▶ forecast streams with a new row ─▶ send everything pending
import { normalizeObservation, predictionItem } from '../central/index.js';
import { forecast as engineForecast } from '../engine/index.js';

export const POLL_EVERY_S = 11 * 3600; // start.py:4785-4876
export const FIRST_POLL_S = [5 * 60, 30 * 60]; // start.py:4777
export const BATCH_LIMIT = 100;
export const KEEP_PENDING_S = 2 * POLL_EVERY_S; // the cap on the kept queue (Lite's in-memory queue has none)

const nowS = () => Date.now() / 1000;
const errorText = (err) => String(err?.message ?? err);

/**
 * Register with central (on every start). Never throws: the result says what
 * happened, and whether central's vault for this identity is ours.
 */
export async function register({ central, vaultPubkey, vaultAddress, nostrPubkey, now = nowS }) {
  const at = now();
  if (!vaultPubkey) return { at, ok: false, skipped: true, error: 'no vault public key in vault.yaml' };
  try {
    const r = await central.register({ vaultPubkey, nostrPubkey });
    const vault = r?.vault_address ?? null;
    return { at, ok: true, peer_id: r?.peer_id ?? null, wallet_address: r?.wallet_address ?? null,
      vault_address: vault, message: r?.message ?? '', vaultMismatch: vault !== vaultAddress };
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
async function submit(db, central, now) {
  await db.dropPending(now() - KEEP_PENDING_S);
  const pending = await db.pending();
  if (!pending.length) return null;
  let result;
  try {
    const r = await central.submitPredictions(pending.map(toItem));
    result = { at: now(), total_submitted: r?.total_submitted ?? pending.length, successful: r?.successful ?? 0,
      failed: r?.failed ?? 0, errors: r?.errors ?? null };
    if (result.successful > 0) await db.markSent(pending.map((p) => p.id), result.at);
  } catch (err) {
    result = { at: now(), error: errorText(err) };
  }
  await db.set('central_last_submit', result);
  return result;
}

async function pollAndSubmit(db, central, forecast, now, at) {
  let batch;
  try {
    batch = await central.observations(BATCH_LIMIT);
    if (!Array.isArray(batch)) throw new Error('central sent no list of observations');
  } catch (err) {
    const poll = { at, error: errorText(err) };
    await db.set('central_last_poll', poll);
    return { poll, submit: null };
  }
  const rows = batch.map(normalizeObservation).filter(Boolean);
  const fresh = await db.addObservations(rows);
  let predicted = 0;
  for (const uuid of fresh) {
    const f = forecast(await db.history(uuid));
    if (!f) continue;
    const made_at = now();
    const { observed_at, hash } = predictionItem({ t1: f.t1, t2: f.t2, now: made_at });
    await db.addPrediction({ stream_uuid: uuid, made_at, model: f.model, t1: f.t1, t2: f.t2, phi: f.phi, weight: f.weight,
      observed_at, hash });
    predicted++;
  }
  const poll = { at, streams: rows.length, new: fresh.length, predicted };
  await db.set('central_last_poll', poll);
  const sent = await submit(db, central, now);
  await db.checkpoint();
  return { poll, submit: sent };
}

/**
 * One cycle: poll → store → forecast new rows → submit. Never throws: a failed
 * poll or a local failure (the database) is the poll's error; a failed
 * submission keeps the queue.
 * @returns {Promise<{poll: object, submit: object | null}>}
 */
export async function cycle({ db, central, forecast = engineForecast, now = nowS }) {
  const at = now();
  try {
    return await pollAndSubmit(db, central, forecast, now, at);
  } catch (err) {
    console.error('[satori] cycle failed', err);
    const poll = { at, error: errorText(err) };
    await db.set('central_last_poll', poll).catch(() => {});
    return { poll, submit: null };
  }
}

/** Lite's start delay: uniform whole seconds in 5–30 min. */
export const startJitter = (rand = Math.random) =>
  FIRST_POLL_S[0] + Math.floor(rand() * (FIRST_POLL_S[1] - FIRST_POLL_S[0] + 1));

/**
 * When the first poll after a (re)load is due: a stored time still ahead (by
 * at most 11 h) is kept, so a reload doesn't reset the schedule; otherwise now
 * plus Lite's start jitter.
 */
export function firstPollAt(stored, now, rand) {
  return typeof stored === 'number' && stored > now && stored <= now + POLL_EVERY_S ? stored : now + startJitter(rand);
}

/**
 * The schedule: start() arms the first poll (meta.next_poll_at); each poll,
 * from the timer or poll(), runs `run` and arms the next one 11 h after it
 * ends, whatever the result. One run at a time: poll() during a run returns
 * it. onChange({ next, running }) follows both.
 */
export function createPoller(run, { db, now = nowS, rand = Math.random, setTimeout: st = setTimeout,
  clearTimeout: ct = clearTimeout, onChange = () => {} }) {
  let timer = null;
  let next = null;
  let running = null;
  const changed = () => onChange({ next, running: !!running });

  async function arm(at) {
    next = at;
    ct(timer);
    timer = st(() => void poll().catch((err) => console.error('[satori] poll', err)), Math.max(0, (at - now()) * 1000));
    changed();
    try {
      await db.set('next_poll_at', at);
      await db.checkpoint(); // OPFS keeps what is checkpointed; a tab may close at any time
    } catch (err) {
      console.error('[satori] saving the next poll time', err);
    }
  }

  function poll() {
    if (!running) {
      ct(timer);
      running = Promise.resolve().then(run).finally(async () => {
        running = null;
        await arm(now() + POLL_EVERY_S);
      });
      changed();
    }
    return running;
  }

  return {
    start: async () => arm(firstPollAt(await db.get('next_poll_at'), now(), rand)),
    poll,
    get next() { return next; },
    get running() { return !!running; },
  };
}

/**
 * Holds a Web Lock for the life of the tab so only one tab opens the database.
 * @returns {Promise<boolean>} false when another tab holds it
 */
export function claimTab(name = 'satori-neuron', locks = globalThis.navigator?.locks) {
  if (!locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    locks.request(name, { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      return lock ? new Promise(() => {}) : undefined;
    });
  });
}
