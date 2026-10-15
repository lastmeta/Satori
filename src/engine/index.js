// engine module. Design: docs/design/engine.md
// Pure functions: naive / SES point forecast (t1, t2) and the Base direction rule.
// Per-node diversity comes from a seed derived from the identity key bytes.
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const UP = 1;
export const DOWN = 2;
export const MIN_SES_POINTS = 10;
export const MIN_DIRECTION_POINTS = 5;
const WINDOW = 20; // rolling one-step MAE window
const BAND = 1.01; // candidates within 1% of the best MAE may be picked
const ALPHAS = Array.from({ length: 49 }, (_, i) => (i + 1) / 50); // 0.02 … 0.98

/**
 * Finite numbers from any array-like (Array, Float64Array, Arrow column).
 * Numeric strings are parsed; NaN, ±Infinity, null, booleans and junk are dropped.
 * @returns {number[]}
 */
export function clean(values) {
  const out = [];
  for (const v of values ?? []) {
    const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (Number.isFinite(x)) out.push(x);
  }
  return out;
}

/**
 * uint32 seed from (identity key, stream, purpose). Key: bytes or hex (0x optional).
 * @param {Uint8Array|string} key @param {string} stream @param {string} purpose
 */
export function seedFor(key = new Uint8Array(), stream = '', purpose = '') {
  const k = typeof key === 'string' ? hexToBytes(key.replace(/^0x/, '')) : key;
  const zero = new Uint8Array(1);
  const h = sha256(concatBytes(k, zero, utf8ToBytes(String(stream)), zero, utf8ToBytes(purpose)));
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

/** mulberry32: deterministic uniform [0, 1) from a uint32 seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** SES level after the whole series (initial level = first value). */
export function sesLevel(xs, alpha) {
  let l = xs[0];
  for (let i = 1; i < xs.length; i++) l += alpha * (xs[i] - l);
  return l;
}

/** Mean |one-step error| of SES(alpha) over the last `w` points; alpha 1 = naive. */
function rollingMae(ys, alpha, w) {
  let l = ys[0], sum = 0;
  for (let i = 1; i < ys.length; i++) {
    if (i >= ys.length - w) sum += Math.abs(ys[i] - l);
    l += alpha * (ys[i] - l);
  }
  return sum / w;
}

/** Divide by max |x| so huge values cannot overflow; returns [scaled, scale]. */
function scaled(xs) {
  const s = xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  return [s ? xs.map((x) => x / s) : xs, s || 1];
}

/**
 * Point forecast for one stream. Fewer than 10 points: naive. Otherwise naive and
 * SES at each grid alpha are scored by rolling one-step MAE over the last 20 points;
 * among candidates within 1% of the best, one is picked with the node's seed.
 * t1 = t2 (closed form). Returns null when there is no usable value.
 * @param {ArrayLike<unknown>} values oldest first
 * @param {{key?: Uint8Array|string, stream?: string}} [opts]
 * @returns {null | {model: 'naive'|'ses', t1: number, t2: number, alpha?: number, mae?: number, bestMae?: number}}
 */
export function forecast(values, { key, stream } = {}) {
  const xs = clean(values);
  if (!xs.length) return null;
  const last = xs.at(-1);
  if (xs.length < MIN_SES_POINTS) return { model: 'naive', t1: last, t2: last };
  const [ys, s] = scaled(xs);
  const w = Math.min(WINDOW, ys.length - 1);
  const cands = [{ alpha: 1, mae: rollingMae(ys, 1, w) }, ...ALPHAS.map((alpha) => ({ alpha, mae: rollingMae(ys, alpha, w) }))];
  const bestMae = Math.min(...cands.map((c) => c.mae));
  const band = cands.filter((c) => c.mae <= bestMae * BAND);
  const pick = band[Math.floor(rng(seedFor(key, stream, 'model'))() * band.length)];
  const mae = pick.mae * s, best = bestMae * s;
  if (pick.alpha === 1) return { model: 'naive', t1: last, t2: last, mae, bestMae: best };
  const level = sesLevel(ys, pick.alpha) * s;
  return { model: 'ses', alpha: pick.alpha, t1: level, t2: level, mae, bestMae: best };
}

/**
 * Base direction: sign of the OLS slope over the last k values, k in [5, 20] drawn
 * once per (node, stream). Flat window or fewer than 5 values → seeded coin flip.
 * @param {ArrayLike<unknown>} values oldest first
 * @param {{key?: Uint8Array|string, stream?: string}} [opts]
 * @returns {1|2} UP = 1, DOWN = 2
 */
export function direction(values, { key, stream } = {}) {
  const xs = clean(values);
  const flip = () => (rng(seedFor(key, stream, 'flip'))() < 0.5 ? UP : DOWN);
  if (xs.length < MIN_DIRECTION_POINTS) return flip();
  const k = MIN_DIRECTION_POINTS + Math.floor(rng(seedFor(key, stream, 'window'))() * 16);
  const [ys] = scaled(xs.slice(-k));
  const n = ys.length, tm = (n - 1) / 2, ym = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let t = 0; t < n; t++) {
    num += (t - tm) * (ys[t] - ym);
    den += (t - tm) ** 2;
  }
  const rise = (num / den) * (n - 1); // fitted total change, in units of max |value|
  if (Math.abs(rise) < 1e-12) return flip();
  return rise > 0 ? UP : DOWN;
}
