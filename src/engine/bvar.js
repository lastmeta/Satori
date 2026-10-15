// `bvar` (docs/design/engine.md#bvar-a-model-per-central-stream-unique-to-each-neuron):
// a Bayesian VAR(1) over a target stream and its 1–3 companions, after
// namaste_club's bvar.py, on 12 h UTC buckets. Pure functions.
//
//   const T = prepare(points)                         // a series on the grid
//   const bt = backtestOf(T)                          // the target's origins, bar1's and persistence's errors
//   errorsAt([T, ...C], spec, bt)                     // the spec's unfaded t2 error at each origin (bar1 where it can't fit)
//   forecastSpec(T, C, spec, errors, bt.persist)      // { model: 'bvar', t1, t2, phi, weight, rows } | null (can't fit)
import {
  STEP_S, LAMBDA1, SIGMA2_FLOOR, MIN_EXTRA_ROWS, HORIZON_STEPS, MAX_STEP_RETURN, HOLDOUT,
  RETURNS, CHANGES, finiteOr0, clamp, firstLag, fadeWeight,
} from './index.js';

export const VAR_FLOOR = 1e-12; // a series' variance in the prior's ratio (bvar.py:171)
export const RATIO_CLIP = [1e-2, 1e2]; // the cross-lag variance ratio (bvar.py:206)

/**
 * A series on the grid: each bucket's last value, its transform (returns when
 * every value is > 0, else changes), the step into each bucket from the one
 * before (none across a gap), and its newest step (bar1's first lag).
 * @param {Iterable<{ts: number, value: number}>} points
 * @returns {object | null} null without a finite point
 */
export function prepare(points, step = STEP_S) {
  const p = Array.from(points).filter((o) => Number.isFinite(o?.ts) && Number.isFinite(o?.value))
    .sort((a, b) => a.ts - b.ts);
  if (!p.length) return null;
  const m = p.every((o) => o.value > 0) ? RETURNS : CHANGES;
  const values = new Map(); // bucket → its last value (models.py:262-264)
  for (const { ts, value } of p) values.set(Math.floor(ts / step), value);
  const b = [...values.keys()];
  const v = [...values.values()];
  const r = new Map(); // bucket → the step into it
  const capUpTo = new Map(); // bucket → the largest |change| up to it (a change series' clamp, no look-ahead)
  let cap = 0;
  for (let i = 1; i < b.length; i++) {
    if (b[i] - b[i - 1] === 1) {
      const x = finiteOr0(m.change(v[i - 1], v[i]));
      r.set(b[i], x);
      cap = Math.max(cap, Math.abs(x));
    }
    capUpTo.set(b[i], cap);
  }
  const pairs = new Set(b.filter((k) => r.has(k) && r.has(k - 1))); // buckets that make a regression row
  return {
    m, b, v, r, pairs, step, last: p.at(-1).value, lastTs: p.at(-1).ts, lag: firstLag(p, step, m),
    cap: m === RETURNS ? MAX_STEP_RETURN : cap,
    capAt: (k) => (m === RETURNS ? MAX_STEP_RETURN : capUpTo.get(k) ?? 0),
  };
}

/** The rows [T, ...companions] share: buckets where every series has a step and the one before. */
export function rowsOf(S) {
  const rows = [];
  for (const k of S[0].b) {
    if (S.every((s) => s.pairs.has(k))) rows.push({ k, x: S.map((s) => s.r.get(k - 1)), y: S.map((s) => s.r.get(k)) });
  }
  return rows;
}

/** How many rows the target and one other series share. */
export const alignedRows = (T, s) => {
  let n = 0;
  for (const k of T.pairs) if (s.pairs.has(k)) n++;
  return n;
};

/** Running sums of the rows: everything the fit needs, so a backtest adds each row once. */
export function sums(n) {
  return { n, N: 0, xx: new Float64Array(n * n), xy: new Float64Array(n * n), sx: new Float64Array(n), sy: new Float64Array(n), syy: new Float64Array(n) };
}
export function addRow(acc, { x, y }) {
  const { n } = acc;
  acc.N++;
  for (let a = 0; a < n; a++) {
    acc.sx[a] += x[a];
    acc.sy[a] += y[a];
    acc.syy[a] += y[a] * y[a];
    for (let c = 0; c < n; c++) {
      acc.xx[a * n + c] += x[a] * x[c];
      acc.xy[a * n + c] += x[a] * y[c]; // Σ x_a·y_c
    }
  }
}

/**
 * Solve A·z = b for a symmetric positive (semi)definite n×n A (LDLᵀ). A pivot
 * that is ~0 (a column dependent on the ones before) gets z = 0: a least-squares
 * solution, whose residuals are the unique ones, as lstsq's.
 */
export function solveSym(A, b, n) {
  const L = new Float64Array(n * n);
  const D = new Float64Array(n);
  let scale = 0;
  for (let k = 0; k < n; k++) scale = Math.max(scale, Math.abs(A[k * n + k]));
  const tol = scale * 1e-12;
  for (let k = 0; k < n; k++) {
    let d = A[k * n + k];
    for (let m = 0; m < k; m++) d -= L[k * n + m] ** 2 * D[m];
    D[k] = d > tol ? d : 0;
    for (let i = k + 1; i < n; i++) {
      if (!D[k]) continue;
      let s = A[i * n + k];
      for (let m = 0; m < k; m++) s -= L[i * n + m] * L[k * n + m] * D[m];
      L[i * n + k] = s / D[k];
    }
  }
  const z = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = b[k];
    for (let m = 0; m < k; m++) s -= L[k * n + m] * z[m];
    z[k] = s;
  }
  for (let k = 0; k < n; k++) z[k] = D[k] ? z[k] / D[k] : 0;
  for (let k = n - 1; k >= 0; k--) {
    if (!D[k]) { z[k] = 0; continue; }
    for (let i = k + 1; i < n; i++) z[k] -= L[i * n + k] * z[i];
  }
  return z;
}

/** The Minnesota prior's variances for equation j (bvar.py:188-207): own lag λ1², another's (λ1·λ2)²·clip(σ_j²/σ_k²). */
export function priorVariances(j, vars, lambda1, lambda2) {
  return vars.map((vk, k) => (k === j ? lambda1 ** 2 : (lambda1 * lambda2) ** 2 * clamp(vars[j] / vk, ...RATIO_CLIP)));
}

/**
 * The posterior mean of every equation (bvar.py:166-229, no time features):
 * coef[j][k] = equation j on series k's lag; with each equation's σ² and prior
 * variances. null below features + 5 rows (bvar.py:157-164).
 */
export function fitSums(acc, lambda1, lambda2) {
  const { n, N } = acc;
  if (N < n + MIN_EXTRA_ROWS) return null;
  const vars = [...acc.sy].map((s, j) => Math.max(acc.syy[j] / N - (s / N) ** 2, VAR_FLOOR)); // np.var(Y_target) (:171)
  const fit = { coef: [], sigma2: [], prior: [] };
  for (let j = 0; j < n; j++) {
    const xy = Float64Array.from({ length: n }, (_, a) => acc.xy[a * n + j]);
    // σ_j² = var(OLS residuals), ddof 0, floored (:177-180): from the sums, as XᵀX·β = Xᵀy at the solution
    const ols = solveSym(acc.xx, xy, n);
    let explained = 0;
    let mean = acc.sy[j];
    for (let a = 0; a < n; a++) {
      explained += ols[a] * xy[a];
      mean -= ols[a] * acc.sx[a];
    }
    const sigma2 = Math.max((acc.syy[j] - explained) / N - (mean / N) ** 2, SIGMA2_FLOOR);
    const prior = priorVariances(j, vars, lambda1, lambda2);
    const A = Float64Array.from(acc.xx, (x) => x / sigma2);
    for (let k = 0; k < n; k++) A[k * n + k] += 1 / prior[k];
    fit.coef.push([...solveSym(A, xy.map((x) => x / sigma2), n)]);
    fit.sigma2.push(sigma2);
    fit.prior.push(prior);
  }
  return fit;
}

/** Iterate the VAR two steps from the lags (bvar.py:316-339), each step clamped per series: [step 1, step 2] of every series. */
export function iterateVar(coef, lag, caps) {
  let x = lag;
  const out = [];
  for (let s = 0; s < HORIZON_STEPS; s++) {
    x = coef.map((c, j) => clamp(finiteOr0(c.reduce((acc, cjk, k) => acc + cjk * x[k], 0)), -caps[j], caps[j]));
    out.push(x);
  }
  return out;
}

/** The target's two steps. */
const targetSteps = (fit, lag, caps) => iterateVar(fit.coef, lag, caps).map((x) => x[0]);

/**
 * The target's backtest origins, as bar1's (index.js backtestWeight): of the last
 * HOLDOUT bucket positions, those with buckets o..o+2 back to back and bar1's
 * 6 pairs up to o. With bar1's unfaded t2 error (the fallback) and persistence's at each.
 */
export function backtestOf(T) {
  const { b, v, m } = T;
  const L = b.length - 1;
  const origins = [];
  const first = Math.max(2, L - 1 - HOLDOUT);
  let pairs = 0;
  for (let o = 0; o + 2 <= L; o++) {
    if (T.pairs.has(b[o])) pairs++;
    if (o < first || b[o + 2] - b[o] !== 2 || pairs < 1 + MIN_EXTRA_ROWS) continue;
    origins.push({ k: b[o], v: v[o], actual: v[o + 2] });
  }
  const bt = { origins, persist: origins.map((o) => m.error(o.v, o.actual)) };
  bt.base = errorsAt([T], { lambda1: LAMBDA1, lambda2: 1 }, bt);
  return bt;
}

/**
 * The unfaded t2 error at each origin of [T, ...companions] with the spec's λ's,
 * fit on the rows up to the origin only; bar1's error where it can't fit.
 */
export function errorsAt(S, { lambda1, lambda2 }, bt) {
  const T = S[0];
  const rows = rowsOf(S);
  const acc = sums(S.length);
  let i = 0;
  return bt.origins.map((o, idx) => {
    while (i < rows.length && rows[i].k <= o.k) addRow(acc, rows[i++]);
    const fit = fitSums(acc, lambda1, lambda2);
    if (!fit) return bt.base[idx];
    const [q1, q2] = targetSteps(fit, S.map((s) => s.r.get(o.k) ?? 0), S.map((s) => s.capAt(o.k)));
    return T.m.error(T.m.raw(o.v, T.m.path(q1, q2)[1]), o.actual);
  });
}

/**
 * The live forecast of a spec on all the rows, faded by its backtest errors.
 * null when it can't fit (the caller falls back to bar1).
 */
export function forecastSpec(T, C, { lambda1, lambda2 }, errors, persist) {
  if (!C.length || C.some((c) => !c)) return null;
  const S = [T, ...C];
  const acc = sums(S.length);
  for (const row of rowsOf(S)) addRow(acc, row);
  const fit = fitSums(acc, lambda1, lambda2);
  if (!fit) return null;
  // a companion whose newest observation is more than a step older than the target's: its step is stale
  const lag = S.map((s, i) => (i && s.lastTs < T.lastTs - T.step ? 0 : s.lag));
  const [x1, x2] = T.m.path(...targetSteps(fit, lag, S.map((s) => s.cap)));
  const weight = fadeWeight(errors, persist);
  return { model: 'bvar', t1: T.m.apply(T.last, x1, weight), t2: T.m.apply(T.last, x2, weight), phi: fit.coef[0][0], weight,
    rows: acc.N };
}
