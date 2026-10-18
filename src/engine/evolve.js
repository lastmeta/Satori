// Specs and evolution for central's streams (docs/design/engine.md#bvar-a-model-per-central-stream-unique-to-each-neuron):
// each target has one champion spec { companions, lambda1, lambda2 }, drawn
// from the identity, and after each poll one mutation is proposed and kept
// only if it beats the champion on the same backtest by the margin. Pure.
//
//   runModels({ fresh, histories, specs, seed }) → { forecasts: Map(uuid → forecast), specs: Map(uuid → row) }
//   runModelsAsync({ …, onProgress }): the same, with the page's turns between targets (the poll's)
//   fitter({ histories })(target, spec) → { model, score, persist, influence }: a stored champion scored again on the
//     stored history as the poll scored it, nothing about the spec changed (the training pass's, src/neuron/train.js)
//   explainModel({ target, spec, histories }) → the stored spec's forecast with its fit and backtest (the Models tab's)
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { STEP_S, MIN_EXTRA_ROWS, MIN_SAMPLES, HOLDOUT, forecast as bar1, explainForecast, median } from './index.js';
import { prepare, backtestOf, errorsAt, forecastSpec, fitSums, influence, inPool } from './bvar.js';

export const LAMBDA1_GRID = [0.05, 0.1, 0.2, 0.5]; // namaste_club's tuner (models.py:589)
export const LAMBDA2_GRID = [0.25, 0.5, 1.0]; // models.py:590
export const MAX_COMPANIONS = 3;
// a challenger must beat the champion's score by 5 %: at 2 % the backtest showed churn (7.1 % of proposals kept
// against 1.9 %) and the λ's drifting to the loosest values; accuracy was the same within the neurons' scatter
// (docs/design/engine.md#measured)
export const MARGIN = 0.05;
export const MIN_ALIGNED = 2 + MIN_EXTRA_ROWS; // the rows a one-companion model needs: the pool's bar

/** A deterministic uniform [0, 1) stream: sha256 of the parts and a counter. */
export function seeded(...parts) {
  const key = parts.join('|');
  let i = 0;
  return () => {
    const h = sha256(utf8ToBytes(`${key}|${i++}`));
    return (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) / 2 ** 32;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/** The first spec: 1–3 companions from the pool (sorted, so the draw depends only on the seed), then λ1 and λ2. */
export function drawSpec(rand, pool) {
  const left = [...pool].sort();
  const k = 1 + Math.floor(rand() * MAX_COMPANIONS);
  const companions = [];
  while (companions.length < k && left.length) companions.push(left.splice(Math.floor(rand() * left.length), 1)[0]);
  return { companions, lambda1: pick(rand, LAMBDA1_GRID), lambda2: pick(rand, LAMBDA2_GRID) };
}

/** A neighbouring grid value (an off-grid value moves to its nearest). */
function neighbour(rand, grid, x) {
  let i = grid.indexOf(x);
  if (i < 0) i = grid.reduce((best, g, j) => (Math.abs(g - x) < Math.abs(grid[best] - x) ? j : best), 0);
  return grid[pick(rand, [i - 1, i + 1].filter((j) => j >= 0 && j < grid.length))];
}

/**
 * One mutation, chosen uniformly among those that apply: swap a companion for
 * another from the pool, add one (fewer than 3), drop one (more than 1), or move
 * λ1 or λ2 one grid step. → { spec, op }
 */
export function mutate(spec, rand, pool) {
  const companions = [...spec.companions];
  const others = [...pool].filter((u) => !companions.includes(u)).sort();
  const ops = [];
  if (companions.length && others.length) ops.push('swap');
  if (companions.length < MAX_COMPANIONS && others.length) ops.push('add');
  if (companions.length > 1) ops.push('drop');
  ops.push('lambda1', 'lambda2');
  const op = pick(rand, ops);
  const next = { companions, lambda1: spec.lambda1, lambda2: spec.lambda2 };
  if (op === 'swap') companions[Math.floor(rand() * companions.length)] = pick(rand, others);
  if (op === 'add') companions.push(pick(rand, others));
  if (op === 'drop') companions.splice(Math.floor(rand() * companions.length), 1);
  if (op === 'lambda1') next.lambda1 = neighbour(rand, LAMBDA1_GRID, spec.lambda1);
  if (op === 'lambda2') next.lambda2 = neighbour(rand, LAMBDA2_GRID, spec.lambda2);
  return { spec: next, op };
}

/**
 * Replace each companion that is not in the target's aligned pool (a stream that
 * stopped, one that never aligns, one drawn blind before there was history) by
 * one drawn from the pool, in its place; when the pool has none left, drop it.
 * With no aligned stream at all (no history yet) the spec stays as drawn.
 */
export function repair(spec, rand, aligned) {
  if (!aligned.length) return spec;
  const ok = spec.companions.filter((u) => aligned.includes(u));
  if (ok.length && ok.length === spec.companions.length) return spec;
  const left = aligned.filter((u) => !ok.includes(u)).sort();
  const draw = () => (left.length ? left.splice(Math.floor(rand() * left.length), 1)[0] : null);
  const companions = spec.companions.length
    ? spec.companions.map((u) => (aligned.includes(u) ? u : draw())).filter(Boolean) : [draw()];
  return { ...spec, companions };
}

/** Keep the challenger only if it beats the champion by the margin. */
export const accepts = (champion, challenger, margin = MARGIN) => challenger < champion * (1 - margin);

/**
 * One poll's engine for central's streams: for each target with a new row,
 * its champion (drawn on first sight), one proposal when the backtest has an
 * opinion, and the forecast (bvar, else bar1, else naive).
 * @param {{fresh: string[], histories: Map<string, {ts: number, value: number}[]>, specs?: Map<string, object>,
 *   seed: string, step?: number, margin?: number, window?: number}} o histories: every central stream's; seed: the
 *   identity's public key; window: the backtest origins a spec is scored on (the fade uses the last HOLDOUT of them)
 * @returns {{forecasts: Map<string, object>, specs: Map<string, {spec, score, persist, influence, generation, accepted}>}}
 *   score: the champion's median backtest error; persist: no change's on the same origins (both null below 5);
 *   influence: for a bvar forecast, each input's share of it, [target, ...companions] (else null)
 */
export function runModels(o) {
  const run = models(o);
  let r = run.next();
  while (!r.done) r = run.next();
  return r.value;
}

/**
 * runModels, the same result, giving the page a turn (pause) every `sliceMs` of work so it can draw;
 * onProgress(done, total): 0 at the start, then after each target (the hero's "Building models · 40 of 82").
 */
export async function runModelsAsync({ onProgress = () => {}, sliceMs = 30, clock = () => performance.now(),
  pause = () => new Promise((r) => setTimeout(r, 0)), ...o }) {
  const run = models(o);
  const total = o.fresh.length;
  let done = 0;
  let t = clock();
  onProgress(0, total);
  for (let r = run.next(); ; r = run.next()) {
    if (r.done) return r.value;
    onProgress(++done, total);
    if (clock() - t >= sliceMs) {
      await pause();
      t = clock();
    }
  }
}

/** Each stream's prepared series, once (null: no history). */
function seriesOf(histories, step) {
  const cache = new Map();
  return (u) => {
    if (!cache.has(u)) cache.set(u, histories.has(u) ? prepare(histories.get(u), step) : null);
    return cache.get(u);
  };
}

/** A spec's errors at the backtest's origins: bvar's where its companions have history, else bar1's (bt.base). */
const errorsOf = (T, s, series, bt) => (s.companions.length && s.companions.every(series)
  ? errorsAt([T, ...s.companions.map(series)], s, bt) : { errors: bt.base, acc: null });

/** The champion's forecast and what is stored with it: persist (no change's median) and, for bvar, its inputs' influence. */
function finish({ T, target, spec, run, score, bt, series, histories, step }) {
  const recent = (xs) => xs.filter((_, i) => bt.origins[i].recent); // the fade: bar1's last HOLDOUT origins
  const f = forecastSpec(T, spec.companions.map(series), spec, run.acc, recent(run.errors), recent(bt.persist))
    ?? bar1(histories.get(target), { step });
  const persist = score === null ? null : median(bt.persist);
  const shares = f?.model === 'bvar' ? influence(fitSums(run.acc, spec.lambda1, spec.lambda2), run.acc) : null;
  return { f, persist, influence: shares };
}

/**
 * The training pass's fit (src/neuron/train.js, docs/design/models.md#the-training-pass): a stored champion scored on
 * the stored history exactly as the poll scored it, with no repair and no proposal, so nothing about the spec changes.
 * → (target, spec) → { model, score, persist, influence } (null: the target has no history)
 */
export function fitter({ histories, step = STEP_S, window = HOLDOUT }) {
  const series = seriesOf(histories, step);
  return (target, spec) => {
    const T = series(target);
    if (!T) return null;
    const bt = backtestOf(T, window);
    const run = errorsOf(T, spec, series, bt);
    const score = bt.origins.length >= MIN_SAMPLES ? median(run.errors) : null;
    const { f, persist, influence: shares } = finish({ T, target, spec, run, score, bt, series, histories, step });
    return { model: f?.model ?? null, score, persist, influence: shares };
  };
}

/** runModels as a generator: it yields after each target. */
function* models({ fresh, histories, specs = new Map(), seed, step = STEP_S, margin = MARGIN, window = HOLDOUT }) {
  const series = seriesOf(histories, step);
  const forecasts = new Map();
  const out = new Map();
  const one = (target) => {
    const T = series(target);
    if (!T) return;
    const { aligned, pool } = poolFor(target, T, histories, series);
    const row = specs.get(target) ?? { spec: drawSpec(seeded(seed, target, 'draw'), pool), generation: 0, accepted: 0 };
    let { generation, accepted } = row;
    // companions out of the pool are replaced before scoring (seeded, so a neuron's path stays reproducible)
    let spec = repair(row.spec, seeded(seed, target, generation, 'repair'), aligned);
    const repaired = spec !== row.spec;
    const bt = backtestOf(T, window);
    let run = errorsOf(T, spec, series, bt);
    let score = bt.origins.length >= MIN_SAMPLES ? median(run.errors) : null;
    let proposal = null;
    if (score !== null) {
      const m = mutate(spec, seeded(seed, target, generation), pool);
      const challenger = errorsOf(T, m.spec, series, bt);
      const s = median(challenger.errors);
      generation++;
      proposal = { op: m.op, spec: m.spec, score: s, accepted: accepts(score, s, margin) };
      if (proposal.accepted) {
        ({ spec } = m);
        run = challenger;
        score = s;
        accepted++;
      }
    }
    const { f, persist, influence: shares } = finish({ T, target, spec, run, score, bt, series, histories, step });
    if (f) forecasts.set(target, { ...f, proposal, repaired });
    out.set(target, { spec, score, persist, influence: shares, generation, accepted });
  };
  for (const target of fresh) {
    one(target);
    yield;
  }
  return { forecasts, specs: out };
}

/**
 * The target's pool: `aligned`, the other streams recently aligned with it and with
 * enough rows for a one-companion model (inPool); `pool`, those, or every other
 * stream while none is (a young neuron without history draws blind, repaired later).
 */
function poolFor(target, T, histories, series) {
  const others = [...histories.keys()].filter((u) => u !== target).sort();
  const aligned = others.filter((u) => series(u) && inPool(T, series(u), MIN_ALIGNED));
  return { aligned, pool: aligned.length ? aligned : others };
}

/**
 * A model as the poll made it, again, from the stored spec and history (the Models tab's drill-in,
 * docs/design/models.md): the forecast (bvar, else bar1 on the stream alone, else naive), with `inputs`
 * ([target, ...companions], or [target]), each one's `influence` (bvar: its share, influence(); else the stream's
 * own 1), `coef` (the target's equation, bvar), `rows`, `tests`, `score` and `persist` (the backtest's medians, as
 * runModels stores them). No proposal: nothing is changed. null without history.
 */
export function explainModel({ target, spec, histories, step = STEP_S, window = HOLDOUT }) {
  const points = histories.get(target);
  const T = points?.length ? prepare(points, step) : null;
  if (!T) return null;
  const C = (spec?.companions ?? []).map((u) => (histories.get(u)?.length ? prepare(histories.get(u), step) : null));
  if (C.length && C.every(Boolean)) {
    const bt = backtestOf(T, window);
    const { errors, acc } = errorsAt([T, ...C], spec, bt);
    const recent = (xs) => xs.filter((_, i) => bt.origins[i].recent);
    const f = forecastSpec(T, C, spec, acc, recent(errors), recent(bt.persist));
    if (f) {
      const fit = fitSums(acc, spec.lambda1, spec.lambda2);
      const scored = bt.origins.length >= MIN_SAMPLES;
      return { ...f, inputs: [target, ...spec.companions], influence: influence(fit, acc), coef: fit.coef[0],
        tests: errors.length, score: scored ? median(errors) : null, persist: scored ? median(bt.persist) : null };
    }
  }
  return { ...explainForecast(points, { step }), inputs: [target], influence: [1] };
}
