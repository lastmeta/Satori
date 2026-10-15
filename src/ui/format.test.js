import { expect, test } from 'vitest';
import { fmtNum, sparkPoints, pickIndexes } from './format.js';

test('fmtNum', () => {
  expect(fmtNum(67123.456)).toBe('67,123.46');
  expect(fmtNum(100010)).toBe('100,010.00');
  expect(fmtNum(7)).toBe('7');
  expect(fmtNum(1.234567)).toBe('1.2346');
  expect(fmtNum(0.000123456)).toBe('0.000123');
  expect(fmtNum(null)).toBe('–');
  expect(fmtNum(NaN)).toBe('–');
});
test('sparkPoints', () => {
  expect(sparkPoints([1])).toBe('');
  expect(sparkPoints([0, 10], 100, 24)).toBe('0,22 100,2');
  expect(sparkPoints([5, 5, 5], 100, 24)).toBe('0,12 50,12 100,12');
});
test('pickIndexes', () => {
  const ix = pickIndexes(3, 24);
  expect(ix).toHaveLength(3);
  expect(new Set(ix).size).toBe(3);
  expect(ix.every((i) => i >= 0 && i < 24)).toBe(true);
  expect([...ix].sort((a, b) => a - b)).toEqual(ix);
});
