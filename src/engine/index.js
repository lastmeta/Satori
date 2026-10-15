// The engine (docs/design/engine.md): a one-stream, lag-1 cut of namaste_club's
// Bayesian VAR (../namaste_club), in Satori Lite's interface:
//   forecast(points) → { model, t1, t2, phi?, weight? } | null
// points: [{ ts, value }] (ts in unix seconds), all of a stream's history.
// options.step: the bucket and horizon in seconds: 12 h for central's streams,
// a relay stream's cadence (docs/design/nostr.md#the-engines-step).
// `bar1`: a Bayesian AR(1) on 12 h returns, shrunk toward the random walk,
// iterated two 12 h steps (t1, t2), each clamped, then faded toward persistence
// by a weight from a rolling backtest. `naive`: t1 = t2 = the last value.
// Pure functions.

export const STEP_S = 43_200; // 12 h buckets, UTC-aligned (features.py:22, regrid_history.py:39)
export const LAMBDA1 = 0.2; // own-lag prior sd (bvar.py:88)
export const SIGMA2_FLOOR = 1e-6; // bvar.py:180
export const MIN_EXTRA_ROWS = 5; // rows ≥ features + 5 (bvar.py:158)
export const HORIZON_STEPS = 2; // 2 × 12 h = central's 24 h (bvar.py:285)
export const MAX_STEP_RETURN = 0.5; // bvar.py:286
export const MIN_SPACING_S = 6 * 3600; // the first lag's span at 12 h, half a step (pool.py:872)
export const HOLDOUT = 28; // backtest origins (models.py:552)
export const MIN_SAMPLES = 5; // calibration.py:34
export const DEFAULT_WEIGHT = 1; // calibration.py:33

const finiteOr0 = (x) => (Number.isFinite(x) ? x : 0);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * @param {Iterable<{ts: number, value: number}>} points
 * @param {{lambda1?: number, weight?: number, step?: number}} [options] weight forces the fade (namaste_club's
 *   MODEL_WEIGHT); step is the bucket in seconds (t1 is one step ahead, t2 two)
 */
export function forecast(points, { lambda1 = LAMBDA1, weight, step = STEP_S } = {}) {
  const p = Array.from(points).filter((o) => Number.isFinite(o?.ts) && Number.isFinite(o?.value))
    .sort((a, b) => a.ts - b.ts);
  if (!p.length) return null;
  const last = p.at(-1).value;
  const naive = { model: 'naive', t1: last, t2: last };
  if (!(last > 0)) return naive;

  const buckets = new Map(); // bucket → its last value (models.py:262-264)
  for (const { ts, value } of p) buckets.set(Math.floor(ts / step), value);
  const b = [...buckets.keys()];
  const v = [...buckets.values()];
  if (v.some((x) => !(x > 0))) return naive;
  const r = b.map((k, i) => (i && k - b[i - 1] === 1 ? finiteOr0(v[i] / v[i - 1] - 1) : null)); // none across a gap

  const pairs = pairsUpTo(r, b.length - 1);
  if (pairs.length < 1 + MIN_EXTRA_ROWS) return naive;
  const phi = fitPhi(pairs, lambda1);
  const w = weight ?? backtestWeight(b, v, r, lambda1);
  const [g1, g2] = iterate(phi, firstLag(p, step));
  return { model: 'bar1', t1: blend(last, g1, w), t2: blend(last, g2, w), phi, weight: w };
}

/** (r[k−1], r[k]) for k ≤ upTo, both present: the lag-1 regression rows. */
function pairsUpTo(r, upTo) {
  const out = [];
  for (let k = 2; k <= upTo; k++) if (r[k - 1] !== null && r[k] !== null) out.push([r[k - 1], r[k]]);
  return out;
}

/**
 * The posterior mean of y = φ·x + e under φ ~ N(0, λ1²), with σ² the variance
 * of the OLS residuals (bvar.py:177-229 with one regressor).
 */
function fitPhi(pairs, lambda1) {
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sxx += x * x;
    sxy += x * y;
  }
  const ols = sxx > 0 ? sxy / sxx : 0;
  const res = pairs.map(([x, y]) => y - ols * x);
  const mean = res.reduce((s, e) => s + e, 0) / res.length;
  const sigma2 = Math.max(res.reduce((s, e) => s + (e - mean) ** 2, 0) / res.length, SIGMA2_FLOOR);
  return sxy / (sxx + sigma2 / lambda1 ** 2);
}

/**
 * The newest return: last / (the newest value ≥ half a step older, 6 h at 12 h) − 1
 * (pool.py:889-900). 0 when there is none, or when it is more than two steps old (a closed tab).
 */
function firstLag(p, step) {
  const { ts, value } = p.at(-1);
  let j = p.length - 2;
  while (j >= 0 && ts - p[j].ts < MIN_SPACING_S * (step / STEP_S)) j--;
  if (j < 0 || ts - p[j].ts > HORIZON_STEPS * step) return 0;
  return finiteOr0(value / p[j].value - 1);
}

/** Growth after each step: each step's return is the next lag, clamped (bvar.py:316-339). */
export function iterate(phi, r0) {
  const out = [];
  let r = r0;
  let g = 1;
  for (let s = 0; s < HORIZON_STEPS; s++) {
    r = clamp(finiteOr0(phi * r), -MAX_STEP_RETURN, MAX_STEP_RETURN);
    g *= 1 + r;
    out.push(g);
  }
  return out;
}

/** last·(1 + w·(g − 1)), with pool.py's guards (calibration.py:108-119; pool.py:1005-1016). */
export function blend(last, g, w) {
  const growth = Number.isFinite(g) && g > 0 ? g : 1;
  const x = last * (1 + w * (growth - 1));
  return Number.isFinite(x) && x > 0 ? x : last;
}

/** Fade by how badly the model trails persistence (calibration.py:39-50). */
export function weightFromErrors(modelErr, persistErr) {
  if (persistErr <= 0) return modelErr > 0 ? 0 : DEFAULT_WEIGHT;
  return clamp(2 - modelErr / persistErr, 0, 1);
}

/** The weight from error samples: no opinion below MIN_SAMPLES (calibration.py:84-89). */
export function fadeWeight(modelErrs, persistErrs) {
  if (modelErrs.length < MIN_SAMPLES) return DEFAULT_WEIGHT;
  return weightFromErrors(median(modelErrs), median(persistErrs));
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The rolling backtest that sets the fade: at each of the last HOLDOUT origins
 * o with buckets o..o+2 consecutive, fit on the pairs up to o, forecast two
 * steps from v[o] and score against v[o+2], as persistence (v[o]) is scored.
 */
function backtestWeight(b, v, r, lambda1) {
  const me = [];
  const pe = [];
  const L = b.length - 1;
  for (let o = Math.max(2, L - 1 - HOLDOUT); o + 2 <= L; o++) {
    if (b[o + 2] - b[o] !== 2) continue;
    const pairs = pairsUpTo(r, o);
    if (pairs.length < 1 + MIN_EXTRA_ROWS) continue;
    const g2 = iterate(fitPhi(pairs, lambda1), r[o] ?? 0)[1];
    const a = v[o + 2];
    me.push(Math.abs(v[o] * g2 - a) / a);
    pe.push(Math.abs(v[o] - a) / a);
  }
  return fadeWeight(me, pe);
}
