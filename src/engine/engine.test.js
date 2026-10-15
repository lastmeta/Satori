import { expect, test } from 'vitest';
import { predict } from './index.js';

test('a straight line is continued exactly', () => {
  expect(predict([1, 2, 3, 4])).toBe(5);
  expect(predict([10, 8, 6], 2)).toBe(2);
});
test('noisy data: the least-squares line', () => {
  // fit: slope 1.6, intercept 1.6 → at x = 4: 8
  expect(predict([2, 2, 6, 6])).toBeCloseTo(8);
});
test('no points → null; one point → that value', () => {
  expect(predict([])).toBeNull();
  expect(predict([42])).toBe(42);
});
test('a constant series stays constant', () => {
  expect(predict([7, 7, 7, 7, 7])).toBe(7);
});
test('non-finite inputs are dropped', () => {
  expect(predict([1, NaN, 2, Infinity, 3, null, undefined, -Infinity])).toBe(4);
  expect(predict([NaN, Infinity])).toBeNull();
});
test('large prices keep precision (centred fit)', () => {
  expect(predict([100000.5, 100001.5, 100002.5])).toBeCloseTo(100003.5, 9);
});
test('accepts typed arrays', () => {
  expect(predict(Float64Array.of(3, 5))).toBe(7);
});
