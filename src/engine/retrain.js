// Retrain (docs/design/models.md#retrain): a focused search for one central target's spec, from stored history only,
// until a candidate beats no change on recent origins it was never chosen on. Pure: it never predicts or stores.
//
//   canRetrain({ target, histories }) → { ok, search, held, heldEnd }      enough history to split?
//   const r = retrainer({ target, histories, champion, seed, n, from })    from: a persisted state(), to resume
//   r.step() → null while it runs, else the result (one try per call)      r.end('stopped') → the result now (Stop)
//   r.progress() → { tried, best, checks }   r.state() → plain JSON to persist
//
// The split: the held-out origins are the tab's own (the last HOLDOUT bucket positions: their median ratio is the
// quality the tab shows); the search scores candidates only on the older origins whose actual came before the first
// held-out origin. The held-out origins are looked at once per retrain: the best must beat no change there by the
// tab's rule as a whole, and by 10 % in each half (each of the last two weeks).
import { seeded, drawSpec, isAlone, ALONE, LAMBDA1_GRID, LAMBDA2_GRID, MAX_COMPANIONS, MARGIN, seriesOf, poolFor, errorsOf } from './evolve.js';
import { backtestOf } from './bvar.js';
import { STEP_S, HORIZON_STEPS, MIN_SAMPLES, median } from './index.js';

/** Better than no change: the tab's rule (median error ratio below 0.95, evolution's margin). */
export const GOAL = 1 - MARGIN;
/** The fewest older origins the search scores on (a week of 12 h buckets); fewer: Retrain is not offered. */
export const MIN_SEARCH = 14;
/**
 * Tries without a better search score before it stops (b): more than every neighbour of a three-companion spec in an
 * 83-stream pool (3 × 80 swaps + 2 drops + 4 λ steps + 1 = 247), so a stalled climb has tried them all.
 */
export const PATIENCE = 400;
/** Tries in all, at most (b): about 10 s in Chrome on central's 83 streams. */
export const MAX_TRIES = 3000;
/** Looks at the held-out origins per retrain: one, so nothing the search saw leaks into the check. */
export const MAX_CHECKS = 1;
/**
 * The bar in each half of the held-out origins (each of the last two weeks): 10 % less error than no change. On
 * simulated random walks the look passes by luck 1–2 times in 100 at any pool size; at the tab's 5 % in each week 1.5–5,
 * and with the tab's rule alone over the 28, 15–19 (docs/design/models.md#retrain).
 */
export const WEEK_BAR = 0.9;

/** A spec's identity in the search: its companions as a set and its λ's; every single-stream spec is one. */
export const keyOf = (s) => (isAlone(s) ? ALONE : `${[...s.companions].sort().join(',')}|${s.lambda1}|${s.lambda2}`);
const bvar = (companions, lambda1, lambda2) => ({ companions, lambda1, lambda2 });
const alone = ({ lambda1, lambda2 }) => ({ companions: [], lambda1, lambda2, algorithm: ALONE });

/** One grid step either way (an off-grid value: its nearest, and that one's steps). */
function gridSteps(grid, x) {
  let i = grid.indexOf(x);
  const off = i < 0;
  if (off) i = grid.reduce((best, g, j) => (Math.abs(g - x) < Math.abs(grid[best] - x) ? j : best), 0);
  return [...(off ? [grid[i]] : []), grid[i - 1], grid[i + 1]].filter((g) => g !== undefined);
}

/**
 * Every spec one change away: swap a companion for another from the pool, add one (fewer than 3), drop one (more than
 * 1), move λ1 or λ2 one grid step, or the single-stream AR; from the single-stream AR, add any one companion back.
 */
export function neighbours(spec, pool) {
  const { lambda1, lambda2 } = spec;
  const C = isAlone(spec) ? [] : spec.companions;
  const others = [...pool].filter((u) => !C.includes(u)).sort();
  if (isAlone(spec)) return others.map((u) => bvar([u], lambda1, lambda2));
  const out = [];
  C.forEach((_, i) => others.forEach((u) => out.push(bvar(C.map((x, j) => (j === i ? u : x)), lambda1, lambda2))));
  if (C.length < MAX_COMPANIONS) others.forEach((u) => out.push(bvar([...C, u], lambda1, lambda2)));
  if (C.length > 1) C.forEach((_, i) => out.push(bvar(C.filter((__, j) => j !== i), lambda1, lambda2)));
  for (const l1 of gridSteps(LAMBDA1_GRID, lambda1)) out.push(bvar(C, l1, lambda2));
  for (const l2 of gridSteps(LAMBDA2_GRID, lambda2)) out.push(bvar(C, lambda1, l2));
  out.push(alone(spec));
  return out;
}

const choose = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1); return c; };
/** How many specs there are for a pool of p streams: 1–3 companions × the λ grids, and the single-stream AR. */
export const spaceSize = (p) => [1, 2, 3].filter((k) => k <= p).reduce((n, k) => n + choose(p, k), 0)
  * LAMBDA1_GRID.length * LAMBDA2_GRID.length + 1;
const inSpace = (s, pool) => isAlone(s) || (s.companions.length >= 1 && s.companions.length <= MAX_COMPANIONS
  && s.companions.every((u) => pool.includes(u)) && LAMBDA1_GRID.includes(s.lambda1) && LAMBDA2_GRID.includes(s.lambda2));

/** A seeded shuffle (Fisher–Yates). */
function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The target's backtest origins split in two: `held`, the tab's (the last HOLDOUT positions: `recent`), and `search`,
 * the older ones whose actual (HORIZON_STEPS buckets on) came before the first held-out origin, so nothing the search
 * scores on overlaps what it is checked on. Indices into bt.origins; heldEnd: the newest held-out origin's bucket.
 */
export function splitOf(T) {
  const bt = backtestOf(T, Infinity);
  const first = bt.origins.find((o) => o.recent)?.k;
  const held = [];
  const search = [];
  bt.origins.forEach((o, i) => {
    if (o.recent) held.push(i);
    else if (first != null && o.k + HORIZON_STEPS <= first) search.push(i);
  });
  return { bt, held, search, heldEnd: held.length ? bt.origins[held.at(-1)].k : null };
}

/** The median error over no change's on the same origins (no change perfect: 1 if the model is too, else Infinity). */
export function ratioOn(errors, persist, idx) {
  const e = median(idx.map((i) => errors[i]));
  const p = median(idx.map((i) => persist[i]));
  return p > 0 ? e / p : e > 0 ? Infinity : 1;
}

const enough = (split) => split.search.length >= MIN_SEARCH && split.held.length >= 2 * MIN_SAMPLES;

/** Whether a target has the history to retrain: MIN_SEARCH older origins, and the held-out ones. → { ok, search, held, heldEnd } */
export function canRetrain({ target, histories, step = STEP_S }) {
  const T = seriesOf(histories, step)(target);
  if (!T) return { ok: false, search: 0, held: 0, heldEnd: null };
  const split = splitOf(T);
  return { ok: enough(split), search: split.search.length, held: split.held.length, heldEnd: split.heldEnd };
}

/**
 * The search: a hill-climb over neighbours() in a seeded order (the first candidate with a better search score moves
 * it), from the champion, with a seeded random restart (drawSpec) at each local optimum. Seeded by identity + target +
 * `n` (the target's retrain counter), so a retrain is reproducible. The held-out origins are looked at once: at the
 * first local optimum that is the best so far and beats no change on the search origins, or when the search ends.
 * The best is accepted ('found') when it beats no change there (beats(): by the tab's margin over them all, by WEEK_BAR
 * in each half) and, when the champion already does, the champion by the same test. Otherwise it ends (b): the look
 * used ('checked'), `patience` tries without a better search score or `maxTries` in all ('budget'), every spec tried
 * ('exhausted'), and the best is kept only if it beats the champion by the same test; or (c) end('stopped'), which keeps
 * the champion. looked: the held-out origins were read for a candidate (so the next retrain waits for new data).
 * @param {{target: string, histories: Map, champion: object, seed: string, n?: number, from?: object, step?: number,
 *   patience?: number, maxTries?: number}} o from: a state() to resume (the data may be newer by then)
 * @returns the search, or { ok: false } without the history to split
 */
export function retrainer({ target, histories, champion, seed, n = 1, from = null, step = STEP_S, patience = PATIENCE,
  maxTries = MAX_TRIES }) {
  const series = seriesOf(histories, step);
  const T = series(target);
  const split = T && splitOf(T);
  if (!split || !enough(split)) return { ok: false, search: split?.search.length ?? 0, held: split?.held.length ?? 0 };
  const { bt, search, held, heldEnd } = split;
  const halves = [held.slice(0, held.length >> 1), held.slice(held.length >> 1)];
  const { aligned } = poolFor(target, T, histories, series);
  const space = spaceSize(aligned.length);
  const cache = new Map(); // key → { s: the search ratio, errors }
  const visited = new Set();
  const scored = (spec) => {
    const k = keyOf(spec);
    let c = cache.get(k);
    if (!c) {
      const { errors } = errorsOf(T, spec, series, bt);
      c = { s: ratioOn(errors, bt.persist, search), errors };
      cache.set(k, c);
    }
    return c;
  };
  /** A ratio on held-out origins: read only in the look and the keep rule, and for the champion (the tab's own number). */
  const heldOn = (spec, idx = held) => ratioOn(scored(spec).errors, bt.persist, idx);
  const h0 = heldOn(champion);
  /**
   * The held-out test: `spec` beats `ref` (null: no change) by the tab's margin over the held-out origins and by
   * WEEK_BAR in each half (each of the last two weeks). Against the champion: its errors over the champion's.
   */
  const beats = (spec, ref = null) => [held, ...halves].every((idx, i) =>
    heldOn(spec, idx) < (i ? WEEK_BAR : GOAL) * (ref ? heldOn(ref, idx) : 1));
  const st = { tried: 0, idle: 0, moves: 0, j: 0, checks: 0, current: champion, best: champion, ...(from ?? {}) };
  let order = null;
  let result = null;
  const rand = (...parts) => seeded(seed, target, 'retrain', n, ...parts);
  const isBest = (spec) => keyOf(spec) === keyOf(st.best);

  function finish(outcome, spec = null) {
    // (b): the best only if it beats the champion where it was never chosen, by the same test (a look); (c) Stop: none
    const keep = !spec && outcome !== 'stopped' && !isBest(champion);
    if (keep && beats(st.best, champion)) spec = st.best;
    result = { outcome, kept: spec ? 'new' : 'current', spec: spec ?? champion, ratio: heldOn(spec ?? champion), was: h0,
      search: scored(st.best).s, tried: st.tried, checks: st.checks, heldEnd, looked: st.checks > 0 || keep };
    return result;
  }

  /** The one look, for the best when it beats no change on the search origins: → the result when it passes, else null. */
  function look() {
    if (st.checks >= MAX_CHECKS || isBest(champion) || !(scored(st.best).s < GOAL)) return null;
    st.checks++;
    return beats(st.best) && (h0 >= GOAL || beats(st.best, champion)) ? finish('found', st.best) : null;
  }
  const ends = (outcome) => look() ?? finish(outcome);

  /** One candidate tried: the climb moves on a better search score (a restart: `jump`). */
  function consider(spec, jump = false) {
    st.tried++;
    st.idle++;
    if (inSpace(spec, aligned)) visited.add(keyOf(spec));
    const c = scored(spec);
    if (jump || c.s < scored(st.current).s) {
      st.current = spec;
      st.moves++;
      st.j = 0;
      order = null;
    }
    if (c.s < scored(st.best).s) {
      st.best = spec;
      st.idle = 0;
    }
    if (st.idle >= patience || st.tried >= maxTries) return ends('budget');
    if (visited.size >= space) return ends('exhausted');
    return null;
  }

  return {
    ok: true, search: search.length, held: held.length, heldEnd, space,
    /** One try; null while it runs, else the result (the same one from then on). */
    step() {
      if (result) return result;
      order ??= shuffle(neighbours(st.current, aligned), rand('order', st.moves));
      if (st.j >= order.length) { // a local optimum: every neighbour tried; the look if it is the best, then a restart
        if (isBest(st.current)) {
          const r = look();
          if (r) return r;
        }
        if (st.checks >= MAX_CHECKS) return finish('checked');
        return consider(drawSpec(rand('restart', st.moves), aligned), true);
      }
      return consider(order[st.j++]);
    },
    /** (c): it ends now (Stop) and keeps the champion: nothing looked at. */
    end: (outcome = 'stopped') => result ?? finish(outcome),
    /** For the progress line: tries so far, and the best's ratio on the search origins (what the search sees). */
    progress: () => ({ tried: st.tried, best: scored(st.best).s, checks: st.checks }),
    /** What to persist to resume: plain JSON. */
    state: () => ({ tried: st.tried, idle: st.idle, moves: st.moves, j: st.j, checks: st.checks, current: st.current, best: st.best }),
    get result() { return result; },
  };
}
