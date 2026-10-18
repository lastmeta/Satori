import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { forecast, fadeWeight, STEP_S, LAMBDA1, HOLDOUT } from './index.js';
import {
  prepare, rowsOf, sums, addRow, fitSums, iterateVar, priorVariances, solveSym, backtestOf, errorsAt, forecastSpec, influence,
} from './bvar.js';

const parity = JSON.parse(readFileSync(new URL('../../test/fixtures/bvar-parity.json', import.meta.url)));
const bar1Parity = JSON.parse(readFileSync(new URL('../../test/fixtures/engine-parity.json', import.meta.url)));

// Points at each 12 h bucket's boundary − 1 s from 2026-09-01 UTC.
const T0 = Date.UTC(2026, 8, 1) / 1000;
const grid = (values, start = 0) => values.map((value, k) => ({ ts: T0 + (start + k + 1) * STEP_S - 1, value }));

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
/** Two price series: the companion's 12 h returns are noise, the target's follow b × the companion's last one. */
function leader(n, b, seed, sd = 0.02) {
  const { normal } = rng(seed);
  const target = [100];
  const comp = [50];
  let rc = 0;
  for (let k = 1; k < n; k++) {
    const rt = b * rc + sd * normal();
    rc = sd * normal();
    target.push(target.at(-1) * (1 + rt));
    comp.push(comp.at(-1) * (1 + rc));
  }
  return { target, comp };
}
const sumsOf = (rows, n) => {
  const acc = sums(n);
  for (const r of rows) addRow(acc, r);
  return acc;
};

describe('the fit, against namaste_club\'s bvar.py (scripts/bvar_parity.py)', () => {
  for (const c of parity.cases) {
    test(c.name, () => {
      const n = c.returns[0].length;
      const rows = c.returns.slice(1).map((y, t) => ({ x: c.returns[t], y }));
      const fit = fitSums(sumsOf(rows, n), c.lambda1, c.lambda2);
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < n; k++) {
          expect(fit.prior[j][k]).toBeCloseTo(c.expected.prior[j][k], 12); // bvar.py:188-207
          expect(fit.coef[j][k]).toBeCloseTo(c.expected.coef[j][k], 9); // the posterior mean, :215-229
        }
        expect(fit.sigma2[j] / c.expected.sigma2[j]).toBeCloseTo(1, 9); // :177-180
      }
      // iterate_forecast: each series' growth after one and two steps, clamped to ±50 % (bvar.py:316-339)
      const [x1, x2] = iterateVar(fit.coef, c.lag, Array(n).fill(0.5));
      for (let j = 0; j < n; j++) {
        expect(1 + x1[j]).toBeCloseTo(c.expected.g1[j], 9);
        expect((1 + x1[j]) * (1 + x2[j])).toBeCloseTo(c.expected.g2[j], 9);
      }
    });
  }

  test('the prior: own lag λ1², another series (λ1·λ2)²·clip(σ_j²/σ_k², 1e-2, 1e2)', () => {
    const close = (a, b) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 15));
    close(priorVariances(0, [4e-4, 1e-4, 1], 0.2, 0.5), [0.04, 0.01 * 4, 0.01 * 0.01]);
    close(priorVariances(1, [4e-4, 1e-4, 1e-12], 0.1, 1), [0.01 * 0.25, 0.01, 0.01 * 100]);
  });

  test('below features + 5 rows there is no fit (bvar.py:157-164)', () => {
    const rows = (k) => Array.from({ length: k }, (_, i) => ({ x: [i / 100, -i / 200, 0.01], y: [i / 50, 0.003, -i / 300] }));
    expect(fitSums(sumsOf(rows(7), 3), 0.2, 0.5)).toBeNull();
    expect(fitSums(sumsOf(rows(8), 3), 0.2, 0.5)).not.toBeNull();
  });

  test('a singular system is solved as least squares, as lstsq', () => {
    expect([...solveSym([4, 2, 2, 1], [2, 1], 2)]).toEqual([0.5, 0]); // column 2 = column 1 / 2
    expect([...solveSym([2, 0, 0, 0], [4, 0], 2)]).toEqual([2, 0]);
  });
});

describe('with no companions it is bar1', () => {
  for (const c of bar1Parity.cases.filter((x) => x.expected.model === 'bar1')) {
    test(c.name, () => {
      const points = c.points.map(([ts, value]) => ({ ts, value }));
      const f = forecast(points);
      const T = prepare(points);
      const bt = backtestOf(T);
      const fit = fitSums(sumsOf(rowsOf([T]), 1), LAMBDA1, 1);
      const w = fadeWeight(bt.base, bt.persist);
      const [q1, q2] = iterateVar(fit.coef, [T.lag], [T.cap]).map((x) => x[0]);
      const [x1, x2] = T.m.path(q1, q2);
      expect(fit.coef[0][0]).toBeCloseTo(f.phi, 12);
      expect(w).toBeCloseTo(f.weight, 12);
      expect(T.m.apply(T.last, x1, w)).toBeCloseTo(f.t1, 9);
      expect(T.m.apply(T.last, x2, w)).toBeCloseTo(f.t2, 9);
      expect(bt.origins.length).toBe(c.expected.samples);
    });
  }
});

describe('the model on series', () => {
  test('it learns a companion that leads the target, and beats bar1 on it', () => {
    const { target, comp } = leader(400, 0.6, 7);
    const T = prepare(grid(target));
    const C = prepare(grid(comp));
    const fit = fitSums(sumsOf(rowsOf([T, C]), 2), 0.5, 1);
    expect(fit.coef[0][1]).toBeGreaterThan(0.45);
    expect(fit.coef[0][1]).toBeLessThan(0.75);
    expect(Math.abs(fit.coef[0][0])).toBeLessThan(0.15);
    const bt = backtestOf(T);
    expect(bt.origins).toHaveLength(HOLDOUT);
    const { errors, acc } = errorsAt([T, C], { lambda1: 0.5, lambda2: 1 }, bt);
    const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
    expect(median(errors)).toBeLessThan(median(bt.base) * 0.9);
    const f = forecastSpec(T, [C], { lambda1: 0.5, lambda2: 1 }, acc, errors, bt.persist);
    expect(f).toMatchObject({ model: 'bvar', rows: 398, weight: 1, horizon: 2 * STEP_S });
    expect(f.value).toBe(f.t2);
    expect(f.phi).toBe(fit.coef[0][0]);
  });

  test('the cross-lag prior shrinks a companion: λ2 → 0 leaves about bar1\'s own coefficient', () => {
    const { target, comp } = leader(300, 0.6, 8);
    const T = prepare(grid(target));
    const C = prepare(grid(comp));
    const tight = fitSums(sumsOf(rowsOf([T, C]), 2), LAMBDA1, 1e-6);
    expect(Math.abs(tight.coef[0][1])).toBeLessThan(1e-6);
    expect(tight.coef[0][0]).toBeCloseTo(forecast(grid(target)).phi, 2); // σ² comes from the two-regressor OLS
  });

  test('rows need every series in three back-to-back buckets: gaps break the chain', () => {
    const T = prepare(grid([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const C = prepare(grid([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]).filter((_, k) => k !== 4)); // bucket 4 missing
    expect(rowsOf([T]).map((r) => r.k - rowsOf([T])[0].k)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(rowsOf([T, C])).toHaveLength(8 - 3); // buckets 4, 5 and 6 need bucket 4
  });

  test('each series has its own transform: changes for a series with a value ≤ 0', () => {
    const T = prepare(grid([100, 101, 102]));
    const C = prepare(grid([-1, 0, 2]));
    expect(T.m.model).toBe('bar1');
    expect(C.m.model).toBe('bar1d');
    const [row, ...more] = rowsOf([T, C]);
    expect(more).toEqual([]);
    expect(row.k).toBe(T.b[2]);
    [[row.x, [0.01, 1]], [row.y, [1 / 101, 2]]].forEach(([got, want]) => got.forEach((x, i) => expect(x).toBeCloseTo(want[i], 15)));
    expect(C.cap).toBe(2);
    expect(C.capAt(C.b[1])).toBe(1); // the clamp at an origin looks at nothing after it
  });

  test('a spec that can\'t fit gives null (the caller falls back to bar1)', () => {
    const T = prepare(grid([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const C = prepare(grid([1, 2, 3, 4, 5, 6, 7, 8]));
    const bt = backtestOf(T);
    const spec = { lambda1: 0.2, lambda2: 0.5 };
    const { acc } = errorsAt([T, C], spec, bt);
    expect(acc.N).toBe(6);
    expect(forecastSpec(T, [C], spec, acc, bt.base, bt.persist)).toBeNull(); // 6 rows < 2 + 5
    expect(forecastSpec(T, [], spec, acc, bt.base, bt.persist)).toBeNull();
    expect(forecastSpec(T, [null], spec, acc, bt.base, bt.persist)).toBeNull();
  });

  test('a stale companion\'s first step is 0', () => {
    const { target, comp } = leader(60, 0.6, 9);
    const pts = grid(target);
    const T = prepare(pts);
    const fresh = prepare(grid(comp));
    const stale = prepare(grid(comp).slice(0, -2)); // its newest observation a day before the target's
    expect(stale.lag).not.toBe(0);
    const bt = backtestOf(T);
    const spec = { lambda1: 0.5, lambda2: 1 };
    const a = forecastSpec(T, [fresh], spec, errorsAt([T, fresh], spec, bt).acc, bt.base, bt.persist);
    const b = forecastSpec(T, [stale], spec, errorsAt([T, stale], spec, bt).acc, bt.base, bt.persist);
    // the same fit would give another forecast with the stale lag; with 0 it is the own lag alone
    const fit = fitSums(sumsOf(rowsOf([T, stale]), 2), 0.5, 1);
    const [q1] = iterateVar(fit.coef, [T.lag, 0], [0.5, 0.5]).map((x) => x[0]);
    expect(b.t1).toBeCloseTo(T.last * (1 + q1 * b.weight), 9);
    expect(a.t1).not.toBe(b.t1);
  });
});

describe('the backtest', () => {
  test('no look-ahead: changing everything after an origin\'s actual leaves its error', () => {
    const { target, comp } = leader(120, 0.5, 11);
    const spec = { lambda1: 0.5, lambda2: 1 };
    const errs = (t, c) => {
      const T = prepare(grid(t));
      const bt = backtestOf(T);
      return { bt, base: bt.base, e: errorsAt([T, prepare(grid(c))], spec, bt).errors };
    };
    const a = errs(target, comp);
    const cut = a.bt.origins[10].k + 2; // origin 10's actual; nothing later may matter to it
    const k0 = Math.floor(grid([0])[0].ts / STEP_S);
    const shake = (xs) => xs.map((x, i) => (k0 + i > cut ? x * (1.3 + 0.1 * Math.sin(i)) : x));
    const b = errs(shake(target), shake(comp));
    expect(b.bt.origins.map((o) => o.k)).toEqual(a.bt.origins.map((o) => o.k));
    expect(b.e.slice(0, 11)).toEqual(a.e.slice(0, 11));
    expect(b.base.slice(0, 11)).toEqual(a.base.slice(0, 11));
    expect(b.e.slice(11)).not.toEqual(a.e.slice(11));
  });

  test('a late value ≤ 0: the target is scored only from it on; a companion\'s gives bar1\'s error before it', () => {
    const { target, comp } = leader(90, 0.5, 13);
    const late = (xs, at) => xs.map((x, k) => (k === at ? 0 : k > at ? x - 200 : x));
    const T = prepare(grid(late(target, 75)));
    const bt = backtestOf(T);
    expect(T.m.model).toBe('bar1d');
    expect(bt.origins.length).toBeGreaterThan(5);
    expect(bt.origins.every((o) => o.k >= T.b[75])).toBe(true); // returns as known before it: not scored
    const P = prepare(grid(target));
    const btP = backtestOf(P);
    const C = prepare(grid(late(comp, 80)));
    const e = errorsAt([P, C], { lambda1: 0.5, lambda2: 1 }, btP).errors;
    const before = btP.origins.map((o) => o.k < C.b[80]);
    expect(before.some(Boolean) && before.some((x) => !x)).toBe(true);
    e.forEach((x, i) => (before[i] ? expect(x).toBe(btP.base[i]) : expect(x).not.toBe(btP.base[i])));
  });

  test('where the spec can\'t fit at an origin, bar1\'s error stands in', () => {
    const { target, comp } = leader(60, 0.5, 12);
    const T = prepare(grid(target));
    const C = prepare(grid(comp, 40)); // the companion starts 40 buckets late
    const bt = backtestOf(T);
    const e = errorsAt([T, C], { lambda1: 0.2, lambda2: 0.5 }, bt).errors;
    const n = bt.origins.filter((o) => o.k < C.b[0] + 8).length; // rows from its bucket +2; 7 rows need bucket +8
    expect(n).toBeGreaterThan(0);
    expect(e.slice(0, n)).toEqual(bt.base.slice(0, n));
    expect(e.slice(n)).not.toEqual(bt.base.slice(n));
  });
});

describe('influence: how much each input moves the target\'s forecast (docs/design/models.md)', () => {
  /** Three price series: `driver`'s and `noise`'s 12 h returns are noise; the target's follow 0.6 × driver's last. */
  function three(n, seed) {
    const { normal } = rng(seed);
    const s = { target: [100], driver: [50], noise: [20] };
    let rd = 0;
    for (let k = 1; k < n; k++) {
      const r = { target: 0.6 * rd + 0.005 * normal(), driver: 0.02 * normal(), noise: 0.02 * normal() };
      rd = r.driver;
      for (const key of Object.keys(s)) s[key].push(s[key].at(-1) * (1 + r[key]));
    }
    return s;
  }

  test('a fit where one companion drives the target ranks it first, and the shares sum to 100%', () => {
    for (const seed of [1, 2, 3]) {
      const s = three(300, seed);
      // the noise companion second in the spec, the driver last: the ranking comes from the fit, not the order
      const S = [prepare(grid(s.target)), prepare(grid(s.noise)), prepare(grid(s.driver))];
      const acc = sumsOf(rowsOf(S), 3);
      const fit = fitSums(acc, 0.5, 1);
      const shares = influence(fit, acc);
      expect(shares).toHaveLength(3);
      expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(shares.every((x) => x >= 0)).toBe(true);
      expect(shares[2]).toBeGreaterThan(0.6); // the driver
      expect(shares[2]).toBeGreaterThan(shares[0]);
      expect(shares[2]).toBeGreaterThan(shares[1]);
    }
  });

  test('|coefficient| × the input\'s standard deviation over the rows, normalized; none at all → the stream itself', () => {
    const acc = sums(2);
    for (const [x0, x1] of [[0.01, 0.1], [-0.01, -0.1], [0.03, 0.3], [-0.03, -0.3]]) addRow(acc, { x: [x0, x1], y: [0, 0] });
    // σ(x0) = 0.02236…, σ(x1) = 10 × that: equal coefficients give 1 : 10
    expect(influence({ coef: [[0.5, 0.5], [0, 0]] }, acc).map((x) => +x.toFixed(9))).toEqual([+(1 / 11).toFixed(9), +(10 / 11).toFixed(9)]);
    expect(influence({ coef: [[0.5, -0.05], [0, 0]] }, acc).map((x) => +x.toFixed(9))).toEqual([0.5, 0.5]); // the sign does not count
    expect(influence({ coef: [[0, 0], [1, 1]] }, acc)).toEqual([1, 0]); // the forecast is the last value: all its own
  });
});
