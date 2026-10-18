// `bvar` (docs/design/engine.md#bvar-a-model-per-central-stream-unique-to-each-neuron):
// a Bayesian VAR(1) over a target stream and its 1–3 companions, after
// namaste_club's bvar.py, on 12 h UTC buckets. Pure functions.
//
//   const T = prepare(points)                         // a series on the grid
//   const bt = backtestOf(T)                          // the target's origins, bar1's and persistence's errors
//   const { errors, acc } = errorsAt([T, ...C], spec, bt)   // the spec's unfaded t2 error at each origin (bar1 where it can't fit)
//   forecastSpec(T, C, spec, acc, errors, bt.persist) // { model: 'bvar', t1, t2, value, horizon, phi, weight, rows } | null
//   influence(fitSums(acc, λ1, λ2), acc)              // each series' share of the target's forecast (the Models tab's)
import {
  STEP_S, LAMBDA1, SIGMA2_FLOOR, MIN_EXTRA_ROWS, HORIZON_STEPS, MAX_STEP_RETURN, HOLDOUT,
  RETURNS, CHANGES, finiteOr0, clamp, firstLag, fadeWeight,
} from './index.js';

export const VAR_FLOOR = 1e-12; // a series' variance in the prior's ratio (bvar.py:171)
export const RATIO_CLIP = [1e-2, 1e2]; // the cross-lag variance ratio (bvar.py:206)

/**
 * A series on the grid: each bucket's last value, its transform (returns when
 * every value is > 0, else changes), the step into each bucket from the one
 * before (none across a gap), and its newest step (bar1's first lag). Dense
 * arrays from its first bucket k0: r(k) is the step into bucket k, NaN for none.
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
  const k0 = b[0];
  const len = b.at(-1) - k0 + 1;
  const steps = new Float64Array(len).fill(NaN); // the step into each bucket
  const caps = new Float64Array(len); // the largest |change| up to each bucket (a change series' clamp, no look-ahead)
  for (let i = 1; i < b.length; i++) {
    if (b[i] - b[i - 1] === 1) steps[b[i] - k0] = finiteOr0(m.change(v[i - 1], v[i]));
  }
  for (let i = 1, cap = 0; i < len; i++) {
    if (steps[i] === steps[i]) cap = Math.max(cap, Math.abs(steps[i]));
    caps[i] = cap;
  }
  const r = (k) => (k >= k0 && k < k0 + len ? steps[k - k0] : NaN);
  return {
    m, b, v, step, last: p.at(-1).value, lastTs: p.at(-1).ts, lag: firstLag(p, step, m), r,
    /** The first bucket the transform, as known then, is this one: a change series' first value ≤ 0. */
    since: m === RETURNS ? -Infinity : Math.floor(p.find((o) => !(o.value > 0)).ts / step),
    /** Bucket k makes a regression row: a step into it and into the one before. */
    pair: (k) => r(k) === r(k) && r(k - 1) === r(k - 1),
    cap: m === RETURNS ? MAX_STEP_RETURN : caps[len - 1],
    capAt: (k) => (m === RETURNS ? MAX_STEP_RETURN : caps[Math.min(Math.max(k - k0, 0), len - 1)]),
  };
}

/** The rows [T, ...companions] share: buckets where every series has a step and the one before. */
export function rowsOf(S) {
  const rows = [];
  for (const k of S[0].b) {
    if (S.every((s) => s.pair(k))) rows.push({ k, x: S.map((s) => s.r(k - 1)), y: S.map((s) => s.r(k)) });
  }
  return rows;
}

export const RECENT_BUCKETS = 4; // a pool stream shares a row with the target in the target's last 4 row buckets (2 days)

/**
 * Whether another series belongs in the target's pool: it shares a row with the
 * target within the target's last RECENT_BUCKETS row buckets (counted from the
 * target's newest row, so a closed tab doesn't empty the pool) and `enough` rows
 * in all. A stream that stopped long ago, or one that never has three buckets in
 * a row (a daily stream), is out.
 */
export function inPool(T, s, enough) {
  let newest = null;
  let n = 0;
  let recent = false;
  for (let i = T.b.length - 1; i >= 0 && !(recent && n >= enough); i--) {
    const k = T.b[i];
    if (!T.pair(k)) continue;
    newest ??= k;
    const inWindow = k > newest - RECENT_BUCKETS;
    if (!inWindow && !recent) return false;
    if (s.pair(k)) {
      n++;
      if (inWindow) recent = true;
    }
  }
  return recent && n >= enough;
}

/** How many rows the target and one other series share, counted from the newest and up to `enough`. */
export const alignedRows = (T, s, enough = Infinity) => {
  let n = 0;
  for (let i = T.b.length - 1; i >= 0 && n < enough; i--) if (T.pair(T.b[i]) && s.pair(T.b[i])) n++;
  return n;
};

/** Running sums of the rows: everything the fit needs, so a backtest adds each row once. */
export function sums(n) {
  return { n, N: 0, xx: new Float64Array(n * n), xy: new Float64Array(n * n), sx: new Float64Array(n), sy: new Float64Array(n), syy: new Float64Array(n) };
}
export function addRow(acc, { x, y }) { // x, y: one value per series
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
    for (let m = 0; m < k; m++) d -= L[k * n + m] * L[k * n + m] * D[m];
    D[k] = d > tol ? d : 0;
    if (!D[k]) continue;
    for (let i = k + 1; i < n; i++) {
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
  for (let k = n - 1; k >= 0; k--) {
    if (!D[k]) {
      z[k] = 0;
      continue;
    }
    let s = z[k] / D[k];
    for (let i = k + 1; i < n; i++) s -= L[i * n + k] * z[i];
    z[k] = s;
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
  const vars = new Array(n); // np.var(Y_target), floored (bvar.py:171)
  for (let j = 0; j < n; j++) vars[j] = Math.max(acc.syy[j] / N - (acc.sy[j] / N) ** 2, VAR_FLOOR);
  const fit = { coef: [], sigma2: [], prior: [] };
  const xy = new Float64Array(n);
  const A = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let a = 0; a < n; a++) xy[a] = acc.xy[a * n + j];
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
    for (let i = 0; i < n * n; i++) A[i] = acc.xx[i] / sigma2;
    for (let k = 0; k < n; k++) {
      A[k * n + k] += 1 / prior[k];
      xy[k] /= sigma2;
    }
    fit.coef.push(Array.from(solveSym(A, xy, n)));
    fit.sigma2.push(sigma2);
    fit.prior.push(prior);
  }
  return fit;
}

/**
 * How much each series moves the target's forecast (docs/design/models.md): its standardized coefficient in the
 * target's equation, |coef[0][k]| × the standard deviation of its lag over the rows (how far a typical step of it
 * moves the forecast), as shares that sum to 1, the target's own first. With no effect at all (every coefficient 0:
 * the forecast is the last value), the target's own is 1.
 */
export function influence(fit, acc) {
  const { n, N } = acc;
  const effect = fit.coef[0].map((c, k) => Math.abs(c) * Math.sqrt(Math.max(acc.xx[k * n + k] / N - (acc.sx[k] / N) ** 2, 0)));
  const total = effect.reduce((s, x) => s + x, 0);
  return total > 0 && Number.isFinite(total) ? effect.map((x) => x / total) : effect.map((_, k) => (k ? 0 : 1));
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
 * `window` bucket positions (HOLDOUT, as bar1), those with buckets o..o+2 back to
 * back and bar1's 6 pairs up to o. With bar1's unfaded t2 error (the fallback)
 * and persistence's at each.
 */
export function backtestOf(T, window = HOLDOUT) {
  const { b, v, m } = T;
  const L = b.length - 1;
  const origins = [];
  const first = Math.max(2, L - 1 - window);
  let pairs = 0;
  for (let o = 0; o + 2 <= L; o++) {
    if (T.pair(b[o])) pairs++;
    // origins from the first value ≤ 0 on, for a change series: before it the stream was on returns
    if (o < first || b[o + 2] - b[o] !== 2 || pairs < 1 + MIN_EXTRA_ROWS || b[o] < T.since) continue;
    origins.push({ k: b[o], v: v[o], actual: v[o + 2], recent: o >= L - 1 - HOLDOUT });
  }
  const bt = { origins, persist: origins.map((o) => m.error(o.v, o.actual)) };
  bt.base = errorsAt([T], { lambda1: LAMBDA1, lambda2: 1 }, bt).errors;
  return bt;
}

/**
 * The unfaded t2 error at each origin of [T, ...companions] with the spec's λ's,
 * fit on the rows up to the origin only (bar1's error where it can't fit), and
 * the sums of all the rows, for the live fit.
 * @returns {{errors: number[], acc: object}}
 */
export function errorsAt(S, { lambda1, lambda2 }, bt) {
  const T = S[0];
  const n = S.length;
  const acc = sums(n);
  const row = { x: new Float64Array(n), y: new Float64Array(n) };
  const errors = [];
  let o = 0;
  const score = (origin) => {
    // a companion still on returns at this origin (its first value ≤ 0 came later) can't be read as it is now
    const fit = S.some((s) => origin.k < s.since) ? null : fitSums(acc, lambda1, lambda2);
    if (!fit) return bt.base[errors.length];
    const [q1, q2] = targetSteps(fit, S.map((s) => finiteOr0(s.r(origin.k))), S.map((s) => s.capAt(origin.k)));
    return T.m.error(T.m.raw(origin.v, T.m.path(q1, q2)[1]), origin.actual);
  };
  for (const k of T.b) {
    while (o < bt.origins.length && bt.origins[o].k < k) errors.push(score(bt.origins[o++]));
    if (!S.every((s) => s.pair(k))) continue;
    for (let j = 0; j < n; j++) {
      row.x[j] = S[j].r(k - 1);
      row.y[j] = S[j].r(k);
    }
    addRow(acc, row);
  }
  while (o < bt.origins.length) errors.push(score(bt.origins[o++]));
  return { errors, acc };
}

/**
 * The live forecast of a spec from the sums of all its rows (errorsAt's),
 * faded by its backtest errors. null when it can't fit (the caller falls back to bar1).
 */
export function forecastSpec(T, C, { lambda1, lambda2 }, acc, errors, persist) {
  if (!C.length || C.some((c) => !c) || !acc) return null;
  const S = [T, ...C];
  const fit = fitSums(acc, lambda1, lambda2);
  if (!fit) return null;
  // a companion whose newest observation is more than a step older than the target's: its step is stale
  const lag = S.map((s, i) => (i && s.lastTs < T.lastTs - T.step ? 0 : s.lag));
  const [x1, x2] = T.m.path(...targetSteps(fit, lag, S.map((s) => s.cap)));
  const weight = fadeWeight(errors, persist);
  const t2 = T.m.apply(T.last, x2, weight);
  // central's horizon: two 12 h steps, 24 h (docs/design/engine.md#the-step-and-the-horizon)
  return { model: 'bvar', t1: T.m.apply(T.last, x1, weight), t2, value: t2, horizon: HORIZON_STEPS * T.step,
    phi: fit.coef[0][0], weight, rows: acc.N };
}
