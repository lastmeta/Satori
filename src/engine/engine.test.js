import { describe, expect, test } from 'vitest';
import { predict, forecast, MODEL, WINDOW } from './index.js';

const pts = (ys, xs = ys.map((_, i) => i)) => ys.map((y, i) => [xs[i], y]);

test('a straight line is continued exactly', () => {
  expect(predict(pts([1, 2, 3, 4]), 4)).toBe(5);
  expect(predict(pts([10, 8, 6]), 4)).toBe(2);
});
test('noisy data: the least-squares line', () => {
  // fit: slope 1.6, intercept 1.6 → at x = 4: 8
  expect(predict(pts([2, 2, 6, 6]), 4)).toBeCloseTo(8);
});
test('fits on x, not on order: a gap is not one step', () => {
  // y = x with a gap between x = 10 and x = 20: still y = x
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20];
  expect(predict(pts(xs, xs), 21)).toBeCloseTo(21, 9);
  // 19 flat minutes at 80,000, then 82,000 twelve hours later: predict near 82,000 a minute on
  const min = 60_000;
  const t = [...Array(19).keys()].map((i) => 1.7e12 + i * min);
  const y = t.map(() => 80_000);
  t.push(t[18] + 12 * 60 * min);
  y.push(82_000);
  const p = predict(pts(y, t), t[19] + min);
  expect(Math.abs(p - 82_000)).toBeLessThan(10);
});
test('no points → null; one point or one x → the mean', () => {
  expect(predict([], 1)).toBeNull();
  expect(predict([[0, 42]], 5)).toBe(42);
  expect(predict([[3, 1], [3, 3]], 5)).toBe(2);
});
test('a constant series stays constant', () => {
  expect(predict(pts([7, 7, 7, 7, 7]), 5)).toBe(7);
});
test('non-finite inputs are dropped', () => {
  expect(predict(pts([1, NaN, 2, Infinity, 3, null, undefined, -Infinity], [0, 9, 1, 9, 2, 9, 9, 9]), 3)).toBe(4);
  expect(predict(pts([NaN, Infinity]), 2)).toBeNull();
  expect(predict([[NaN, 1]], 2)).toBeNull();
});
test('large prices and epoch-ms times keep precision (centred fit)', () => {
  const t0 = 1.76e12;
  expect(predict(pts([100000.5, 100001.5, 100002.5], [t0, t0 + 60_000, t0 + 120_000]), t0 + 180_000))
    .toBeCloseTo(100003.5, 6);
});
test('a result that overflows is null, not NaN', () => {
  expect(predict(pts([1e308, 1e308, -1e308]), 5)).toBeNull();
  expect(predict(pts([1e308, 1e308]), 2)).toBe(1e308);
});

describe('forecast: the engine interface (step 4 swaps the model)', () => {
  const at = (values) => values.map((value, i) => ({ ts: 1_792_000_000 + i * 3600, value }));
  test('t1 one step on, t2 one step after appending t1 (Lite engine.py:1153-1186)', () => {
    expect(forecast(at([1, 2, 3, 4]))).toEqual({ model: MODEL, t1: 5, t2: 6 });
    expect(forecast(at([10, 8, 6]))).toEqual({ model: MODEL, t1: 4, t2: 2 });
  });
  test('by step, not by time: irregular polls are one step each', () => {
    const pts = [{ ts: 0, value: 1 }, { ts: 10, value: 2 }, { ts: 5000, value: 3 }];
    expect(forecast(pts)).toMatchObject({ t1: 4, t2: 5 });
  });
  test(`the last ${WINDOW} observations only`, () => {
    const values = [...Array(30).keys()].map((i) => (i < 10 ? 1000 : i));
    expect(forecast(at(values)).t1).toBeCloseTo(30);
  });
  test('one observation: that value; none or none finite: null', () => {
    expect(forecast(at([42]))).toEqual({ model: MODEL, t1: 42, t2: 42 });
    expect(forecast([])).toBeNull();
    expect(forecast(at([NaN, Infinity]))).toBeNull();
  });
  test('an overflowing t2 falls back to t1', () => {
    const r = forecast(at([0, 0.8e308])); // t1 = 1.6e308; t2 would be 2.4e308, past the largest double
    expect(r.t1).toBeCloseTo(1.6e308, -300);
    expect(r.t2).toBe(r.t1);
  });
});
