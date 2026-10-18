// The training pass (docs/design/models.md#the-training-pass, docs/intent/engine.md: never rest with work pending).
// Scoring is part of training: every model the neuron runs keeps a current fit, its backtest against no change and its
// inputs' influence, computed on the history it has now. The poll fits the models it predicts; this pass fits every
// other one that lacks a current fit, from stored history only: on load, after a poll, and whenever a model became
// unscored or stale (new history, a new spec, a changed companion). It never predicts, never submits and never calls
// central. Nothing is queued: what lacks a fit is read from the data each time, so a pass cut off (a closed tab, a
// poll that began) is picked up where it left off by the next.
//
//   fitKey(target, spec, stat) → the key of the data a central model's fit was computed on
//   lacking({ streams, subscriptions, lastBatch, baseFits, tried }) → { central, nostr, base, total }
//   await trainPass({ db, streams, subscriptions, lastBatch, baseHistory, baseFits, tried, report, stop }) → counts
//   createTrainer({ db, work, read, after, baseHistory }) → { run(), last, baseFits }: one pass at a time, as Home's work
import { fitter } from '../engine/evolve.js';
import { explainForecast } from '../engine/index.js';
import { DEFAULT_CADENCE_S } from './nostr.js';

/** Bumped when the engine's scoring changes, so every stored fit is computed again. */
export const FIT_VERSION = 1;

/**
 * What a central model's fit was computed on: the spec's λs and, for the target and each companion in order, its row
 * count and newest time (stat(uuid) → { n, last } | null). The same key: the same data, so the stored fit is current.
 */
export const fitKey = (target, spec, stat) => [`v${FIT_VERSION}`, spec.lambda1, spec.lambda2,
  ...[target, ...spec.companions].map((u) => { const s = stat(u); return s ? `${u}:${s.n}:${s.last}` : `${u}:-`; })].join('|');

/** Each stream's { n, last } from db.streams() rows (observations, obs_ts). */
export function statsOf(streams = []) {
  const m = new Map(streams.filter((r) => r.observations > 0).map((r) => [r.uuid, { n: r.observations, last: r.obs_ts }]));
  return (u) => m.get(u) ?? null;
}
/** The same from the histories read: Map(uuid → [{ts, value}]). */
export const statsFrom = (histories) => (u) => {
  const h = histories.get(u);
  return h?.length ? { n: h.length, last: h.at(-1).ts } : null;
};

const parse = (text) => {
  try { return text == null ? null : JSON.parse(text); } catch { return null; }
};
const UNSCORED = new Set(['naive', 'echo']); // no change itself, or no number: nothing to score
const cadenceOf = (s) => (s.cadence_seconds > 0 ? s.cadence_seconds : DEFAULT_CADENCE_S);

/**
 * The models without a current fit, each with its `id` (tried: the ids attempted this session with the same data,
 * left out, so a fit that cannot be kept is never retried in a loop):
 * - central: a forecast stream whose spec's fit key is not its data's now (null: stored before the pass existed);
 * - Nostr: a `_pred` with no backtest kept (tests null; naive and echo have none);
 * - Base: a game of the last batch, sent or left out after a forecast, with no backtest kept (a batch before they
 *   were always kept: no `tests`, no `score`) and not fit in memory yet (baseFits, by `<hash>:<stream id>`).
 */
export function lacking({ streams = [], subscriptions = [], lastBatch = null, baseFits = new Map(), tried = new Set() } = {}) {
  const stat = statsOf(streams);
  const central = streams.filter((r) => r.model && r.spec).map((r) => {
    const spec = parse(r.spec);
    const key = spec && fitKey(r.uuid, spec, stat);
    return { id: `central:${r.uuid}|${key}`, uuid: r.uuid, text: r.spec, spec, key, current: key === r.fit_key };
  }).filter((x) => x.spec && !x.current && !tried.has(x.id));
  const nostr = subscriptions.filter((s) => s.prediction && !UNSCORED.has(s.prediction.model) && s.prediction.tests == null)
    .map((s) => ({ id: `nostr:${s.uuid}:${s.prediction.seq}`, uuid: s.uuid, seq: s.prediction.seq, cadence: cadenceOf(s) }))
    .filter((x) => !tried.has(x.id));
  const games = lastBatch ? [...lastBatch.games, ...(lastBatch.dropped ?? [])] : [];
  const base = games.filter((g) => g.model && !UNSCORED.has(g.model) && !('tests' in g) && !('score' in g))
    .map((game) => ({ id: `${lastBatch.hash ?? lastBatch.round}:${game.streamId}`, game }))
    .filter((x) => !baseFits.has(x.id));
  return { central, nostr, base, total: central.length + nostr.length + base.length };
}

/** A turn for the page: scheduler.yield where the browser has it (no 4 ms clamp), else a task. */
const turn = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));

/**
 * One pass over what lacks a fit (lacking()), giving the page a turn between models once `sliceMs` of work has passed;
 * report('score', done, total) at the start and after each model (none when nothing lacks one); stop(): checked between
 * models (a poll began: it stops, keeping what it fit). Central's fits are stored where the spec is still the one fit
 * (db.saveFits), Nostr's on its latest `_pred` (db.setRelayFit), Base's in memory (baseFits: its history is the chain's,
 * read once per game as the batch reads it). Never a prediction, never central.
 * @returns {Promise<{central: number, nostr: number, base: number, stopped: boolean, ms: number}>}
 */
export async function trainPass({ db, streams = [], subscriptions = [], lastBatch = null, baseHistory = null, baseFits = new Map(),
  tried = new Set(), report = () => {}, stop = () => false, now = () => Date.now() / 1000, clock = () => performance.now(),
  pause = turn, sliceMs = 10 }) {
  const t0 = clock();
  const todo = lacking({ streams, subscriptions, lastBatch, baseFits, tried });
  const out = { central: 0, nostr: 0, base: 0, stopped: false, ms: 0 };
  if (!todo.total) return out;
  let done = 0;
  let t = clock();
  report('score', 0, todo.total);
  /** After each model: the count, a turn when the slice is used up; false when it must stop. */
  const next = async () => {
    report('score', ++done, todo.total);
    if (clock() - t >= sliceMs) {
      await pause();
      t = clock();
    }
    return !(out.stopped = !!stop());
  };

  if (todo.central.length) {
    const histories = await db.histories([...new Set(todo.central.flatMap((x) => [x.uuid, ...x.spec.companions]))]); // one read
    const fit = fitter({ histories });
    const stat = statsFrom(histories);
    const fits = [];
    for (const x of todo.central) {
      tried.add(x.id);
      const f = fit(x.uuid, x.spec);
      if (f) fits.push({ uuid: x.uuid, spec: x.text, score: f.score, persist: f.persist, influence: f.influence, fit_key: fitKey(x.uuid, x.spec, stat) });
      if (!(await next())) break;
    }
    out.central = await db.saveFits(fits, Math.floor(now()));
  }
  for (const x of out.stopped ? [] : todo.nostr) {
    tried.add(x.id);
    const e = explainForecast(await db.relayHistory(x.uuid), { step: x.cadence, horizon: x.cadence });
    await db.setRelayFit(x.uuid, x.seq, { score: e?.score ?? null, persist: e?.persist ?? null, tests: e?.tests ?? 0 });
    out.nostr++;
    if (!(await next())) break;
  }
  for (const { id, game: g } of out.stopped ? [] : todo.base) {
    try {
      const e = explainForecast(baseHistory ? await baseHistory(g.streamId) : [], { step: g.step ?? g.horizon, horizon: g.horizon });
      baseFits.set(id, { score: e?.score ?? null, persist: e?.persist ?? null, tests: e?.tests ?? 0 });
      out.base++;
    } catch (err) {
      baseFits.set(id, { score: null, persist: null, tests: null, error: String(err?.message ?? err) }); // not asked again this session
    }
    if (!(await next())) break;
  }
  await db.checkpoint();
  out.ms = Math.round(clock() - t0);
  return out;
}

/**
 * The pass as the app runs it: run() (any number of calls: one pass at a time, one more after it when asked during it)
 * reads the state (read() → { streams, subscriptions, lastBatch }), and when something lacks a fit and central's work
 * is not in progress (a poll, its sign-in, the history: their end runs it again), holds the work task `train` (Home's
 * "Scoring models · 12 of 81", src/neuron/work.js) until after(result) (the app's refresh) is done, so the scores show
 * as the status returns to Resting. → the last pass's result, or null when there was nothing to do; `last` keeps it.
 */
export function createTrainer({ db, work, read, after = async () => {}, baseHistory = null, ...options }) {
  const tried = new Set();
  const baseFits = new Map();
  const busy = () => !!work.of('central');
  let running = null;
  let again = false;
  const t = { last: null, baseFits, run };
  async function once() {
    if (busy()) return null;
    const state = await read();
    if (!lacking({ ...state, baseFits, tried }).total) return null;
    const job = work.start('train');
    try {
      const r = await trainPass({ db, ...state, baseHistory, baseFits, tried, report: job.step, stop: busy, ...options });
      t.last = r;
      await after(r);
      return r;
    } finally {
      job.end();
    }
  }
  function run() {
    again = true;
    running ??= (async () => {
      let result = null;
      while (again) {
        again = false;
        result = (await once()) ?? result;
      }
      return result;
    })().catch((err) => {
      console.error('[satori] training pass', err);
      return null;
    }).finally(() => { running = null; });
    return running;
  }
  return t;
}
