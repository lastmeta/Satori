// The neuron's flow, once per stream interval:
//   source ──fetch──▶ observation ──▶ engine ──▶ prediction ──sign──▶ store ──▶ publish
import { predict } from '../engine/index.js';

export const WINDOW = 20;
export const MODEL = `ols-${WINDOW}`;
export const FETCH_TIMEOUT_MS = 15_000;
export const MIN_INTERVAL_S = 10;
export const MAX_INTERVAL_S = 86_400; // timers overflow past ~24.8 days
export const DEFAULT_STREAM = {
  name: 'BTC-USD',
  url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
  path: 'data.amount',
  interval_s: 60,
};

/** Read a dotted path ('data.amount', 'items.0.price'); '' is the whole document. */
export function readPath(doc, path) {
  return path.split('.').filter(Boolean).reduce((v, k) => (v == null ? undefined : v[k]), doc);
}

/** Why a stream can't be added, or null when it can. */
export function streamError({ name, url, path, interval_s }) {
  if (!name) return 'Give the stream a name.';
  if (!/^https:\/\//.test(url)) return 'The source URL must start with https://';
  if (!path) return 'Give the path to the number.';
  if (!(interval_s >= MIN_INTERVAL_S)) return `Use an interval of at least ${MIN_INTERVAL_S} seconds.`;
  if (!(interval_s <= MAX_INTERVAL_S)) return 'Use an interval of at most 1 day (86400 seconds).';
  return null;
}

/** The exact text that is signed: fixed key order, no whitespace. */
export function canonical({ stream, ts, target_ts, value, model, address }) {
  return JSON.stringify({ stream, ts, target_ts, value, model, address });
}

/** Step 1 publisher: marks the prediction published. A central or Nostr
 *  publisher later has the same shape: (prediction with id) → Promise. */
export const localPublisher = (db) => async (p) => db.markPublished(p.id);

async function observe(stream, fetchFn, now, signal) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetchFn(stream.url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from source`);
  const raw = readPath(await res.json(), stream.path);
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`no number at "${stream.path}" (got ${JSON.stringify(raw)?.slice(0, 40)})`);
  }
  return { ts: now(), value };
}

/**
 * One tick for one stream. Never throws: a failure is stored as the stream's
 * last error and returned. A success clears the last error. Once `signal` is
 * aborted (Lock, Remove) or the identity is locked, nothing more is stored.
 * @returns {Promise<{ok: true, observation, prediction} | {ok: false, error: string}>}
 */
export async function tick(stream, { db, identity, publish, signal, fetch: fetchFn = globalThis.fetch, now = Date.now }) {
  try {
    const obs = await observe(stream, fetchFn, now, signal);
    if (signal?.aborted) return { ok: false, error: 'stopped' };
    if (identity.locked) return { ok: false, error: 'Locked' };
    await db.addObservation(stream.name, obs.ts, obs.value);
    const target_ts = obs.ts + stream.interval_s * 1000;
    const value = predict((await db.recent(stream.name, WINDOW)).map((o) => [o.ts, o.value]), target_ts);
    if (value === null) throw new Error('engine produced no value');
    if (identity.locked) return { ok: false, error: 'Locked' };
    const p = { stream: stream.name, ts: obs.ts, target_ts, value, model: MODEL, address: identity.address };
    p.message = canonical(p);
    p.signature = identity.sign(p.message);
    p.id = await db.addPrediction(p);
    await publish(p);
    await db.setError(stream.name, null);
    await db.checkpoint();
    return { ok: true, observation: obs, prediction: p };
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: 'stopped' };
    const error = err?.name === 'TimeoutError' ? 'source timed out' : String(err?.message ?? err);
    await db.setError(stream.name, error, now()).catch(() => {});
    return { ok: false, error };
  }
}

/**
 * Runs `run(stream, signal)` for each started stream right away, then once per
 * interval (measured from the start of the last run). A failing run never stops
 * the others or the schedule. stop(name) aborts `signal` and returns the run in
 * flight, so a caller can wait for it before deleting the stream's data.
 */
export function createScheduler(run, { setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
  const jobs = new Map();

  async function stop(name) {
    const job = jobs.get(name);
    if (!job) return;
    job.ctl.abort();
    ct(job.timer);
    jobs.delete(name);
    await job.running;
  }

  function start(stream) {
    stop(stream.name);
    const job = { ctl: new AbortController(), timer: null, running: null };
    jobs.set(stream.name, job);
    const loop = async () => {
      const started = Date.now();
      job.running = Promise.resolve().then(() => run(stream, job.ctl.signal)).catch(() => {}); // run reports its own errors
      await job.running;
      if (job.ctl.signal.aborted) return;
      job.timer = st(loop, Math.max(0, stream.interval_s * 1000 - (Date.now() - started)));
    };
    loop();
  }

  return {
    start,
    stop,
    stopAll: () => Promise.all([...jobs.keys()].map(stop)),
    get running() { return [...jobs.keys()]; },
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
