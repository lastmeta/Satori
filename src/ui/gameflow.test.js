import { expect, test } from 'vitest';
import { queueOf, stepOf, played, favoritesIn, submitEarly, latestText, linePoints, nothingText, opensAgain, againText } from './gameflow.js';

const s = (streamId, weight, o = {}) => ({ streamId, weight: String(weight), blocked: null, named: false, history: [], ...o });

test('queueOf: the playable streams, eligible first (favorites as starred, then by weight), then the ineligible', () => {
  const list = [s(1, 5), s(2, 9), s(3, 1), s(4, 7, { blocked: 'StaleValue' }), s(5, 9), s(6, 2, { blocked: 'AlreadyPredicted' }), s(7, 0), s(8, 0)];
  const ids = (q) => q.queue.map((x) => x.streamId);
  expect(ids(queueOf(list))).toEqual([2, 5, 1, 6, 3, 7, 8]); // already predicted: played as usual
  expect(queueOf(list).split).toBe(5);
  expect(ids(queueOf(list, [3, 4, 8, 1]))).toEqual([3, 1, 2, 5, 6, 8, 7]); // 4 can't be played; 8 leads the ineligible
  expect(favoritesIn(queueOf(list, [3, 4, 1]).queue, [3, 4, 1])).toBe(2);
  expect([played(list[5]), played(s(9, 1, { blocked: 'DuplicatePrediction' })), played(list[3]), played(list[0])]).toEqual([true, true, false, false]);
});

test('stepOf: the eligible, the submit screen, on to the ineligible, the submit screen again; and back', () => {
  const at = (screen, index) => ({ screen, index, length: 4, split: 2 });
  expect(stepOf(at('play', 0), 1)).toEqual({ screen: 'play', index: 1 });
  expect(stepOf(at('play', 1), 1)).toEqual({ screen: 'submit', index: 2 }); // after the eligible
  expect(stepOf(at('submit', 2), 1)).toEqual({ screen: 'play', index: 2 }); // on to the ineligible
  expect(stepOf(at('play', 3), 1)).toEqual({ screen: 'submit', index: 4 }); // after the last
  expect(stepOf(at('submit', 4), 1)).toBe(null); // nothing more
  expect(stepOf(at('submit', 4), -1)).toEqual({ screen: 'play', index: 3 });
  expect(stepOf(at('play', 2), -1)).toEqual({ screen: 'submit', index: 2 }); // back over the submit screen
  expect(stepOf(at('submit', 2), -1)).toEqual({ screen: 'play', index: 1 });
  expect(stepOf(at('play', 0), -1)).toBe(null);
  expect(stepOf({ screen: 'submit', index: 1, length: 4, split: 2 }, 1)).toEqual({ screen: 'play', index: 1 }); // Submit early, then on
  expect(stepOf({ screen: 'play', index: 1, length: 2, split: 2 }, 1)).toEqual({ screen: 'submit', index: 2 }); // all eligible
  expect(stepOf({ screen: 'play', index: 0, length: 2, split: 0 }, 1)).toEqual({ screen: 'play', index: 1 }); // none eligible: no gate
});

test('submitEarly: after more than one favorite, with something predicted', () => {
  expect(submitEarly({ index: 2, favorites: 2, picks: 1 })).toBe(true);
  expect(submitEarly({ index: 1, favorites: 2, picks: 1 })).toBe(false); // still in the favorites
  expect(submitEarly({ index: 1, favorites: 1, picks: 1 })).toBe(false); // one favorite only
  expect(submitEarly({ index: 3, favorites: 2, picks: 0 })).toBe(false); // nothing predicted
  expect(submitEarly({ index: 3, favorites: 0, picks: 1, split: 3 })).toBe(true); // past the submit screen
  expect(submitEarly({ index: 2, favorites: 0, picks: 1, split: 3 })).toBe(false);
});

test('latestText: the latest value, a Sentiment stream too', () => {
  expect(latestText(s(1, 1, { named: true, history: [{ value: '100' }, { value: '90' }] }))).toBe('90');
  expect(latestText(s(1, 1, { history: [{ value: '1234.5' }] }))).toBe('1,234.50');
  expect(latestText(s(1, 1))).toBe('');
  // the adapter's decimals: a Sentiment stream's 18
  expect(latestText(s(1, 1, { named: true, display: { decimals: 18 }, history: [{ value: '999999228392505300' }] }))).toBe('0.999999');
  expect(latestText(s(1, 1, { display: { decimals: 8 }, history: [{ value: '8053494000000' }] }))).toBe('80,534.94');
});

test('linePoints: oldest left, highest at the top, flat when level', () => {
  expect(linePoints([{ value: '0' }, { value: '10' }], 100, 100)).toBe('0,92 100,8');
  expect(linePoints([{ value: '3' }, { value: '3' }], 100, 50)).toBe('0,25 100,25');
  expect(linePoints([{ value: '3' }], 100, 50)).toBe('0,25 100,25');
  expect(linePoints([])).toBe('');
});

test('nothingText: calm, with what to do', () => {
  expect(nothingText([])).toBe('No games on the Satori contract yet.');
  expect(nothingText([s(1, 1, { blocked: 'Delegated' })])).toMatch(/staked with another address/);
  expect(nothingText([s(1, 1, { blocked: 'StaleValue' })])).toBe('Unable to predict right now. Come back later.');
});

test('when the player can predict again: the next round at 00:00 UTC, a Sentiment game too', () => {
  const R = 20754;
  const at = R * 86400 + 14 * 3600 + 1800; // 14:30 UTC
  expect(opensAgain({ round: R, at, calls: [{ streamId: 1 }] })).toBe((R + 1) * 86400);
  expect(opensAgain({ round: R, at })).toBe((R + 1) * 86400);
  expect(againText(1000 + 7 * 3600 + 12 * 60, 1000)).toBe('You can predict again in 7 h 12 min.');
  expect(againText(1000 + 59, 1000)).toBe('You can predict again in 1 min.');
  expect(againText(1000, 1000)).toBe('You can predict again now.');
});
