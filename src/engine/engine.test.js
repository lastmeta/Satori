import { expect, test } from 'vitest';
import { predict } from './index.js';

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
