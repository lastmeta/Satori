import { expect, test } from 'vitest';
import { queueOf, favoritesIn, submitEarly, leanLabel, latestText, linePoints, nothingText } from './gameflow.js';

const s = (streamId, weight, o = {}) => ({ streamId, weight: String(weight), blocked: null, named: false, history: [], ...o });

test('queueOf: the playable streams, favorites first as starred, then by weight', () => {
  const list = [s(1, 5), s(2, 9), s(3, 1), s(4, 7, { blocked: 'DuplicatePrediction' }), s(5, 9)];
  expect(queueOf(list).map((x) => x.streamId)).toEqual([2, 5, 1, 3]);
  expect(queueOf(list, [3, 4, 1]).map((x) => x.streamId)).toEqual([3, 1, 2, 5]); // 4 is blocked
  expect(favoritesIn(queueOf(list, [3, 4, 1]), [3, 4, 1])).toBe(2);
});

test('submitEarly: after more than one favorite, with something predicted', () => {
  expect(submitEarly({ index: 2, favorites: 2, picks: 1 })).toBe(true);
  expect(submitEarly({ index: 1, favorites: 2, picks: 1 })).toBe(false); // still in the favorites
  expect(submitEarly({ index: 1, favorites: 1, picks: 1 })).toBe(false); // one favorite only
  expect(submitEarly({ index: 3, favorites: 2, picks: 0 })).toBe(false); // nothing predicted
});

test('leanLabel and latestText: a Sentiment stream leans, others show the number', () => {
  expect(leanLabel(110, 100)).toBe('▲ +10.0%');
  expect(leanLabel(-110, -100)).toBe('▼ −10.0%'); // signed: divided by |prev|
  expect(leanLabel(5, undefined)).toBe('▲ up');
  expect(latestText(s(1, 1, { named: true, history: [{ value: '100' }, { value: '90' }] }))).toBe('▼ −10.0%');
  expect(latestText(s(1, 1, { history: [{ value: '1234.5' }] }))).toBe('1,234.50');
  expect(latestText(s(1, 1))).toBe('');
});

test('linePoints: oldest left, highest at the top, flat when level', () => {
  expect(linePoints([{ value: '0' }, { value: '10' }], 100, 100)).toBe('0,92 100,8');
  expect(linePoints([{ value: '3' }, { value: '3' }], 100, 50)).toBe('0,25 100,25');
  expect(linePoints([{ value: '3' }], 100, 50)).toBe('0,25 100,25');
  expect(linePoints([])).toBe('');
});

test('nothingText: calm, with what to do', () => {
  expect(nothingText([], 'alias')).toBe('No games on the Satori contract yet.');
  expect(nothingText([s(1, 1, { blocked: 'DuplicatePrediction' })], 'alias'))
    .toBe('Unable to predict right now: this app already predicted in the last 24 hours. Come back later.');
  expect(nothingText([s(1, 1, { blocked: 'Delegated' })], 'wallet')).toMatch(/staked with another address/);
  expect(nothingText([s(1, 1, { blocked: 'StaleValue' })], 'wallet')).toBe('Unable to predict right now. Come back later.');
});
