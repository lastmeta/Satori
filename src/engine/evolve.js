// Specs and evolution for central's streams (docs/design/engine.md#bvar-a-model-per-central-stream-unique-to-each-neuron):
// each target has one champion spec { companions, lambda1, lambda2 }, drawn
// from the identity, and after each poll one mutation is proposed and kept
// only if it beats the champion on the same backtest by the margin. Pure.
//
//   runModels({ fresh, histories, specs, seed }) → { forecasts: Map(uuid → forecast), specs: Map(uuid → row) }
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { STEP_S, MIN_EXTRA_ROWS, MIN_SAMPLES, forecast as bar1, median } from './index.js';
import { prepare, backtestOf, errorsAt, forecastSpec, alignedRows } from './bvar.js';

export const LAMBDA1_GRID = [0.05, 0.1, 0.2, 0.5]; // namaste_club's tuner (models.py:589)
export const LAMBDA2_GRID = [0.25, 0.5, 1.0]; // models.py:590
export const MAX_COMPANIONS = 3;
export const MARGIN = 0.02; // a challenger must beat the champion's score by 2 %
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

/** Keep the challenger only if it beats the champion by the margin. */
export const accepts = (champion, challenger, margin = MARGIN) => challenger < champion * (1 - margin);

/**
 * One poll's engine for central's streams: for each target with a new row,
 * its champion (drawn on first sight), one proposal when the backtest has an
 * opinion, and the forecast (bvar, else bar1, else naive).
 * @param {{fresh: string[], histories: Map<string, {ts: number, value: number}[]>, specs?: Map<string, object>,
 *   seed: string, step?: number, margin?: number}} o histories: every central stream's; seed: the identity's public key
 * @returns {{forecasts: Map<string, object>, specs: Map<string, {spec, score, generation, accepted}>}}
 */
export function runModels({ fresh, histories, specs = new Map(), seed, step = STEP_S, margin = MARGIN }) {
  const cache = new Map();
  const series = (u) => {
    if (!cache.has(u)) cache.set(u, histories.has(u) ? prepare(histories.get(u), step) : null);
    return cache.get(u);
  };
  const forecasts = new Map();
  const out = new Map();
  for (const target of fresh) {
    const T = series(target);
    if (!T) continue;
    let pool;
    const poolOf = () => (pool ??= poolFor(target, T, histories, series));
    const row = specs.get(target) ?? { spec: drawSpec(seeded(seed, target, 'draw'), poolOf()), generation: 0, accepted: 0 };
    let { spec, generation, accepted } = row;
    const bt = backtestOf(T);
    const errorsOf = (s) => (s.companions.length && s.companions.every(series)
      ? errorsAt([T, ...s.companions.map(series)], s, bt) : bt.base);
    let errors = errorsOf(spec);
    let score = bt.origins.length >= MIN_SAMPLES ? median(errors) : null;
    let proposal = null;
    if (score !== null) {
      const m = mutate(spec, seeded(seed, target, generation), poolOf());
      const e = errorsOf(m.spec);
      const s = median(e);
      generation++;
      proposal = { op: m.op, spec: m.spec, score: s, accepted: accepts(score, s, margin) };
      if (proposal.accepted) {
        ({ spec } = m);
        errors = e;
        score = s;
        accepted++;
      }
    }
    const f = forecastSpec(T, spec.companions.map(series), spec, errors, bt.persist) ?? bar1(histories.get(target), { step });
    if (f) forecasts.set(target, { ...f, proposal });
    out.set(target, { spec, score, generation, accepted });
  }
  return { forecasts, specs: out };
}

/** The other streams with enough aligned history for a one-companion model; all the others while none has. */
function poolFor(target, T, histories, series) {
  const others = [...histories.keys()].filter((u) => u !== target).sort();
  const aligned = others.filter((u) => series(u) && alignedRows(T, series(u)) >= MIN_ALIGNED);
  return aligned.length ? aligned : others;
}
