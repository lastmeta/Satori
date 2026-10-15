import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  forecast, iterate, blend, weightFromErrors, fadeWeight,
  STEP_S, LAMBDA1, MIN_SAMPLES, DEFAULT_WEIGHT, HOLDOUT,
} from './index.js';

const parity = JSON.parse(readFileSync(new URL('../../test/fixtures/engine-parity.json', import.meta.url)));

// Points at each 12 h bucket's boundary − 1 s from 2026-09-01 UTC, as namaste_club's regrid does.
const T0 = Date.UTC(2026, 8, 1) / 1000;
const grid = (values, start = 0) => values.map((value, k) => ({ ts: T0 + (start + k + 1) * STEP_S - 1, value }));
const ZIG = [100, 101, 100, 102, 101, 103, 102, 104, 103, 105];

// A seeded RNG (mulberry32) and normal draws (Box–Muller), for repeatable series.
function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { u, normal: () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()) };
}
/** Prices whose 12 h returns follow r_k = phi·r_{k−1} + N(0, sd). */
function arPrices(n, phi, sd, seed, p0 = 100) {
  const { normal } = rng(seed);
  const out = [];
  let r = 0;
  let p = p0;
  for (let k = 0; k < n; k++) {
    out.push(p);
    r = phi * r + sd * normal();
    p *= 1 + r;
  }
  return out;
}

describe('verbatim from namaste_club (tests/test_engine.py)', () => {
  test('iterate: zero coefficients mean no change (:179-184)', () => {
    expect(iterate(0, 0.1)).toEqual([1, 1]);
  });
  test('iterate: a persistence coefficient compounds (:186-192)', () => {
    const [g1, g2] = iterate(1, 0.1);
    expect(g1).toBeCloseTo(1.1, 12);
    expect(g2).toBeCloseTo(1.1 * 1.1, 12);
  });
  test('iterate: step returns are clamped to ±50% (:194-200)', () => {
    expect(iterate(1000, 0.1)).toEqual([1.5, 1.5 * 1.5]);
    expect(iterate(1000, -0.1)).toEqual([0.5, 0.25]);
    expect(iterate(-1000, 0.1)).toEqual([0.5, 0.75]); // −0.5, then −1000·−0.5 → +0.5
  });
  test('weight rules (:391-399)', () => {
    expect(weightFromErrors(0.03, 0.03)).toBe(1); // as good as persistence: keep it whole
    expect(weightFromErrors(0.01, 0.03)).toBe(1); // clearly better: still whole (capped)
    expect(weightFromErrors(0.045, 0.03)).toBeCloseTo(0.5, 12); // 1.5× worse: half
    expect(weightFromErrors(0.06, 0.03)).toBe(0); // 2× worse: dropped
  });
  test('a constant stream pins to persistence (:401-404)', () => {
    expect(weightFromErrors(0.02, 0)).toBe(0);
    expect(weightFromErrors(0, 0)).toBe(1);
  });
  test('blend endpoints (:406-409)', () => {
    expect(blend(100, 1.1, 1)).toBeCloseTo(110, 12);
    expect(blend(100, 1.1, 0)).toBe(100);
    expect(blend(100, 1.1, 0.5)).toBeCloseTo(105, 12);
  });
  test('weights from error samples (:418-433): 2× worse → 0, better → 1', () => {
    const six = (x) => Array(6).fill(x);
    expect(fadeWeight(six(0.10), six(0.05))).toBe(0);
    expect(fadeWeight(six(0.01), six(0.05))).toBe(1);
  });
  test(`fewer than ${MIN_SAMPLES} samples gives no opinion (:435-439)`, () => {
    expect(fadeWeight([0.5], [0])).toBe(DEFAULT_WEIGHT);
    expect(fadeWeight(Array(MIN_SAMPLES - 1).fill(0.5), Array(MIN_SAMPLES - 1).fill(0.01))).toBe(DEFAULT_WEIGHT);
    expect(fadeWeight(Array(MIN_SAMPLES).fill(0.5), Array(MIN_SAMPLES).fill(0.01))).toBe(0);
  });
  test('blend guards (pool.py:1005-1006,1015-1016): a bad growth is 1, a bad result is last', () => {
    expect(blend(100, NaN, 1)).toBe(100);
    expect(blend(100, -2, 1)).toBe(100);
    expect(blend(100, 0, 1)).toBe(100);
    expect(blend(1e308, 2, 1)).toBe(1e308);
  });
  test('medians: an even count takes the mean of the middle two (statistics.median)', () => {
    expect(fadeWeight([0.01, 0.02, 0.03, 0.04, 0.05, 0.06], [0.02, 0.02, 0.02, 0.02, 0.02, 0.02])).toBeCloseTo(2 - 0.035 / 0.02, 12);
  });
});

describe('the same numbers as namaste_club\'s own code (scripts/engine_parity.py)', () => {
  test.each(parity.cases.map((c) => [c.name, c]))('%s', (_, c) => {
    const f = forecast(c.points.map(([ts, value]) => ({ ts, value })));
    const e = c.expected;
    expect(f.model).toBe(e.model);
    for (const k of ['t1', 't2', 'phi', 'weight']) {
      if (e[k] === undefined) expect(f[k]).toBeUndefined();
      else expect(f[k]).toBeCloseTo(e[k], 9);
    }
  });
  test('golden values, recomputed (zigzag; 1% compounding; a point an hour after the grid)', () => {
    expect(forecast(grid(ZIG))).toEqual({ model: 'bar1', phi: expect.closeTo(-0.705304, 6),
      weight: 1, t1: expect.closeTo(103.56200, 5), t2: expect.closeTo(104.56234, 5) });
    expect(forecast(grid(Array.from({ length: 40 }, (_, k) => 100 * 1.01 ** k)))).toMatchObject({
      model: 'bar1', weight: 1, t1: expect.closeTo(148.87674, 5), t2: expect.closeTo(150.34611, 5) });
    // The first lag skips the point an hour back and uses 104, the newest ≥ 6 h older: r0 = 110/104 − 1.
    const nine = grid(ZIG.slice(0, 9));
    expect(forecast([...nine, { ts: nine.at(-1).ts + 3600, value: 110 }])).toMatchObject({
      t1: expect.closeTo(108.50565, 5), t2: expect.closeTo(108.85275, 5) });
  });
});

describe('the model', () => {
  const recover = (lambda1) => forecast(grid(arPrices(400, 0.5, 0.01, 7)), { lambda1 }).phi;
  test(`recovers a known AR(1) (φ = 0.5, 400 buckets) with a loose prior and with λ1 = ${LAMBDA1}`, () => {
    for (const phi of [recover(0.5), recover(LAMBDA1)]) {
      expect(phi).toBeGreaterThan(0.4);
      expect(phi).toBeLessThan(0.6);
    }
  });
  test('a tight prior shrinks to the random walk', () => {
    expect(Math.abs(recover(1e-4))).toBeLessThan(0.1);
  });
  test('on a random walk it stays near persistence (500 seeds, 8–40 buckets, 1% steps)', () => {
    let sum = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const n = 8 + (seed % 33);
      const p = grid(arPrices(n, 0, 0.01, seed));
      const f = forecast(p);
      expect(f.model).toBe('bar1');
      sum += Math.abs(f.t2 / p.at(-1).value - 1);
    }
    expect(sum / 500).toBeLessThan(0.001); // a tenth of one step's typical move
  });
  test('t1 is the first 12 h step and t2 the second (Lite\'s t2 = predict again with t1 appended)', () => {
    const f = forecast(grid(ZIG), { weight: 1 });
    const [g1, g2] = iterate(f.phi, 105 / 103 - 1);
    expect(f.t1).toBeCloseTo(105 * g1, 9);
    expect(f.t2).toBeCloseTo(105 * g2, 9);
  });
  test('{weight} forces the fade, as MODEL_WEIGHT does (pool.py:1001-1010)', () => {
    expect(forecast(grid(ZIG), { weight: 0 })).toMatchObject({ t1: 105, t2: 105, weight: 0 });
    const full = forecast(grid(ZIG), { weight: 1 });
    const half = forecast(grid(ZIG), { weight: 0.5 });
    expect(half.t2 - 105).toBeCloseTo((full.t2 - 105) / 2, 9);
  });
  test(`the fade comes from the last ${HOLDOUT} backtest origins: a model that loses is faded`, () => {
    // 50 buckets of zigzag, then a steady 1% climb: the fit still expects reversals and loses.
    const v = Array.from({ length: 50 }, (_, k) => (k % 2 ? 102 : 100));
    for (let k = 0; k < 40; k++) v.push(v.at(-1) * 1.01);
    const f = forecast(grid(v));
    expect(f.model).toBe('bar1');
    expect(f.weight).toBeLessThan(1);
    // and one that wins keeps its weight
    expect(forecast(grid(Array.from({ length: 40 }, (_, k) => 100 * 1.01 ** k))).weight).toBe(1);
  });
});

describe('minimum data and guards', () => {
  test('7 buckets → naive (6 pairs needed: lag 1 + 5, bvar.py:158); 8 → bar1', () => {
    expect(forecast(grid(ZIG.slice(0, 7)))).toEqual({ model: 'naive', t1: 102, t2: 102 });
    expect(forecast(grid(ZIG.slice(0, 8))).model).toBe('bar1');
  });
  test('several points in a bucket count once (its last value)', () => {
    const p = grid(ZIG.slice(0, 8)).flatMap((o) => [{ ts: o.ts - 7200, value: o.value * 3 }, o]);
    expect(forecast(p)).toEqual(forecast(grid(ZIG.slice(0, 8))));
    expect(forecast(p.slice(0, -2)).model).toBe('naive');
  });
  test('a constant series: t1 = t2 = last, φ = 0', () => {
    expect(forecast(grid(Array(30).fill(5)))).toEqual({ model: 'bar1', t1: 5, t2: 5, phi: 0, weight: 1 });
  });
  test('a gap breaks the returns: 9 buckets around a missing one → naive', () => {
    const p = [...grid(ZIG.slice(0, 4)), ...grid(ZIG.slice(5, 10), 5)];
    expect(p).toHaveLength(9);
    expect(forecast(p).model).toBe('naive');
    expect(forecast(grid(ZIG.slice(0, 9))).model).toBe('bar1');
  });
  test('a first lag more than 24 h old counts as 0: t1 = t2 = last', () => {
    const p = [...grid(ZIG), { ts: grid(ZIG).at(-1).ts + 3 * 86400, value: 120 }];
    expect(forecast(p)).toMatchObject({ model: 'bar1', t1: 120, t2: 120 });
    const fresh = [...grid(ZIG), { ts: grid(ZIG).at(-1).ts + 86400, value: 120 }];
    expect(forecast(fresh).t1).not.toBe(120);
  });
  test('a series with a value ≤ 0 is modeled on changes (bar1d), not returns: a 0 or a negative is a value, not a gap', () => {
    expect(forecast(grid([...ZIG.slice(0, 9), 0])).model).toBe('bar1d');
    expect(forecast(grid([...ZIG.slice(0, 9), -3])).model).toBe('bar1d');
    expect(forecast(grid([100, -1, ...ZIG])).model).toBe('bar1d');
    expect(forecast(grid([5, 0]))).toEqual({ model: 'naive', t1: 0, t2: 0 }); // too short either way
  });
  test('bar1d: a named stream\'s counter (signed, from 0) rising steadily → t2 above the last (UP)', () => {
    const counter = Array.from({ length: 12 }, (_, k) => -10 + 2 * k); // −10 … 12, every change +2
    const f = forecast(grid(counter));
    expect(f).toMatchObject({ model: 'bar1d', weight: 1 });
    expect(f.phi).toBeCloseTo(1, 5);
    expect(f.t1).toBeCloseTo(14, 5); // last + one step's change (capped at the largest change seen)
    expect(f.t2).toBeCloseTo(16, 5);
    const falling = forecast(grid(counter.map((x) => -x)));
    expect(falling.t2).toBeLessThan(falling.t1);
    expect(falling.t1).toBeLessThan(-12);
  });
  test('bar1d: the same model at any level (a shift moves the forecast by the shift)', () => {
    const { normal } = rng(7);
    let d = 0;
    let v = 0;
    const counter = Array.from({ length: 40 }, () => { d = 0.5 * d + normal(); v += d; return v; });
    const a = forecast(grid(counter));
    const b = forecast(grid(counter.map((x) => x - 1000)));
    expect(a.model).toBe('bar1d');
    expect(b.phi).toBeCloseTo(a.phi, 12);
    expect(b.weight).toBeCloseTo(a.weight, 12);
    expect(b.t2 + 1000).toBeCloseTo(a.t2, 9);
    expect(a.phi).toBeGreaterThan(0.1); // it finds the positive autocorrelation of the changes
  });
  test('bar1d: the first lag is the change from the value ≥ half a step older', () => {
    const p = [...grid(ZIG)];
    p.splice(9, 0, { ts: p[9].ts - 7 * 3600, value: -50 }); // earlier in the last bucket, ≥ 6 h back
    const f = forecast(p);
    expect(f.model).toBe('bar1d');
    expect(Number.isFinite(f.t1) && Number.isFinite(f.t2)).toBe(true);
  });
  test('all positive: unchanged (returns), whatever bar1d does', () => {
    expect(forecast(grid(ZIG)).model).toBe('bar1');
  });
  test('bar1 needs an observation every step (6 lag pairs of back-to-back buckets); once a day stays naive', () => {
    const days = (n, at, value) => Array.from({ length: n }, (_, d) => ({ ts: T0 + d * 86400 + at, value: value(d) }));
    // A daily central stream, e.g. crypto_fear_greed at 00:01 (central/src/scripts/extra_streams.py:27).
    expect(forecast(days(120, 60, (d) => 50 + (d % 7))).model).toBe('naive');
    // A tab open only 9:00–18:00 polls once a day: one bucket of two, never back to back.
    expect(forecast(days(120, 9 * 3600 + 1200, (d) => 100 * 1.001 ** d)).model).toBe('naive');
    // Polls every 11 h: 9 polls fill 8 back-to-back buckets, 6 pairs.
    expect(forecast(ZIG.slice(0, 9).map((value, k) => ({ ts: T0 + 600 + k * 11 * 3600, value }))).model).toBe('bar1');
  });
  test('non-finite points are dropped; none left → null; one → naive', () => {
    const p = [...grid(ZIG), { ts: NaN, value: 1 }, { ts: T0, value: Infinity }, { ts: T0, value: null }];
    expect(forecast(p)).toEqual(forecast(grid(ZIG)));
    expect(forecast([])).toBeNull();
    expect(forecast([{ ts: T0, value: NaN }])).toBeNull();
    expect(forecast([{ ts: T0, value: 42 }])).toEqual({ model: 'naive', t1: 42, t2: 42 });
  });
  test('points in any order', () => {
    expect(forecast([...grid(ZIG)].reverse())).toEqual(forecast(grid(ZIG)));
  });
});

describe('the step (a relay stream forecasts in steps of its cadence)', () => {
  const at = (step) => (values) => values.map((value, k) => ({ ts: T0 + (k + 1) * step - 1, value }));
  test('the same series on a 15 min grid with step 900 gives the same model as on 12 h', () => {
    for (const seed of [1, 2, 3]) {
      const values = arPrices(60, -0.3, 0.02, seed);
      const half = forecast(at(STEP_S)(values));
      expect(half.model).toBe('bar1');
      expect(forecast(at(900)(values), { step: 900 })).toEqual(half);
    }
  });
  test('the first lag needs half a step of spacing; a step-old gap is not a lag at 12 h', () => {
    const values = arPrices(30, -0.3, 0.02, 9);
    const pts = at(900)(values);
    // At the default 12 h step, 15 min points fall in a handful of buckets: naive.
    expect(forecast(pts).model).toBe('naive');
    expect(forecast(pts, { step: 900 }).model).toBe('bar1');
  });
});
