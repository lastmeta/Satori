// Specs and evolution for central's streams (docs/design/engine.md#bvar-a-model-per-central-stream-unique-to-each-neuron):
// each target has one champion spec { companions, lambda1, lambda2 }, drawn
// from the identity, and after each poll one mutation is proposed and kept
// only if it beats the champion on the same backtest by the margin. Pure.
//
//   runModels({ fresh, histories, specs, seed }) → { forecasts: Map(uuid → forecast), specs: Map(uuid → row) }
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { STEP_S, MIN_EXTRA_ROWS, MIN_SAMPLES, HOLDOUT, forecast as bar1, median } from './index.js';
import { prepare, backtestOf, errorsAt, forecastSpec, inPool } from './bvar.js';

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
 * @returns {{forecasts: Map<string, object>, specs: Map<string, {spec, score, generation, accepted}>}}
 */
export function runModels({ fresh, histories, specs = new Map(), seed, step = STEP_S, margin = MARGIN, window = HOLDOUT }) {
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
    const { aligned, pool } = poolFor(target, T, histories, series);
    const row = specs.get(target) ?? { spec: drawSpec(seeded(seed, target, 'draw'), pool), generation: 0, accepted: 0 };
    let { generation, accepted } = row;
    // companions out of the pool are replaced before scoring (seeded, so a neuron's path stays reproducible)
    let spec = repair(row.spec, seeded(seed, target, generation, 'repair'), aligned);
    const repaired = spec !== row.spec;
    const bt = backtestOf(T, window);
    const errorsOf = (s) => (s.companions.length && s.companions.every(series)
      ? errorsAt([T, ...s.companions.map(series)], s, bt) : { errors: bt.base, acc: null });
    let run = errorsOf(spec);
    let score = bt.origins.length >= MIN_SAMPLES ? median(run.errors) : null;
    let proposal = null;
    if (score !== null) {
      const m = mutate(spec, seeded(seed, target, generation), pool);
      const challenger = errorsOf(m.spec);
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
    const recent = (xs) => xs.filter((_, i) => bt.origins[i].recent); // the fade: bar1's last HOLDOUT origins
    const f = forecastSpec(T, spec.companions.map(series), spec, run.acc, recent(run.errors), recent(bt.persist))
      ?? bar1(histories.get(target), { step });
    if (f) forecasts.set(target, { ...f, proposal, repaired });
    out.set(target, { spec, score, generation, accepted });
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
