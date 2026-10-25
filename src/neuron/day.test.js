import { describe, expect, test } from 'vitest';
import { callResult, dayOf, dayRange, networkMark } from './day.js';

const D = 86400;

describe('a network prediction against no change', () => {
  const obs = [{ ts: 0, value: 100 }, { ts: 3600, value: 101 }, { ts: D + 3600, value: 110 }];
  test('its 24 h forecast nearer the value 24 h on than no change: better; farther: worse; within 5 %: tie', () => {
    expect(networkMark({ made_at: 3600, t2: 109 }, obs)).toBe('better');
    expect(networkMark({ made_at: 3600, t2: 90 }, obs)).toBe('worse');
    expect(networkMark({ made_at: 3600, t2: 101.2 }, obs)).toBe('tie');
  });
  test('no value 24 h on (yet, or a day late): not scored', () => {
    expect(networkMark({ made_at: 7200, t2: 109 }, obs)).toBeNull();
    expect(networkMark({ made_at: 3600, t2: 109 }, [...obs.slice(0, 2), { ts: 2 * D + 7200, value: 110 }])).toBeNull();
  });
  test('no change was exact: a forecast that moved is worse, one that did not a tie', () => {
    const flat = [{ ts: 0, value: 5 }, { ts: D, value: 5 }];
    expect(networkMark({ made_at: 0, t2: 6 }, flat)).toBe('worse');
    expect(networkMark({ made_at: 0, t2: 5 }, flat)).toBe('tie');
  });
});

describe('a contract call, as the engine scores it', () => {
  const hourly = [{ hour: 99, value: 10n }, { hour: 100, value: 12n }, { hour: 110, value: 11n }, { hour: 124, value: 15n }];
  test('hourly: the value at the call\'s hour against the first 24 h on; strictly', () => {
    expect(callResult({ hour: 100, direction: 'up', cadenceMinutes: 60 }, hourly)).toBe('right');
    expect(callResult({ hour: 100, direction: 'down', cadenceMinutes: 60 }, hourly)).toBe('wrong');
    expect(callResult({ hour: 100, direction: 'up', cadenceMinutes: 60 }, hourly.slice(0, 3))).toBeNull();
    const flat = [{ hour: 100, value: 12n }, { hour: 124, value: 12n }];
    expect(callResult({ hour: 100, direction: 'up', cadenceMinutes: 60 }, flat)).toBe('wrong');
    expect(callResult({ hour: 100, direction: 'down', cadenceMinutes: 60 }, flat)).toBe('wrong');
  });
  test('daily: the first two values after the call\'s hour', () => {
    const daily = [{ hour: 96, value: 1n }, { hour: 120, value: 5n }, { hour: 144, value: 3n }];
    expect(callResult({ hour: 100, direction: 'down', cadenceMinutes: 1440 }, daily)).toBe('right');
    expect(callResult({ hour: 100, direction: 'down', cadenceMinutes: 1440 }, daily.slice(0, 2))).toBeNull();
  });
});

test('a day: its network predictions with their marks, its batches with their calls, else why there was none', () => {
  const [a] = dayRange('2026-10-20');
  const rows = [
    { kind: 'open', at: a - 100, until: a + 5000 },
    { kind: 'base', level: 'warn', at: a + 60, until: a + 3600, data: { skipped: 'gas above the ceiling: …' } },
    { kind: 'base', level: 'ok', at: a + 7200, data: { games: [1, 2], calls: [{ streamId: 1, direction: 'up' }] } },
    { kind: 'base', level: 'ok', at: a + D + 60, data: { games: [1] } }, // the next day
  ];
  const predictions = [{ made_at: a + 100, mark: 'better' }, { made_at: a + 200, mark: 'worse' }, { made_at: a + 300, mark: null },
    { made_at: a - 1, mark: 'better' }];
  const d = dayOf({ date: '2026-10-20', rows, predictions });
  expect(d.network).toEqual({ sent: 3, first: a + 100, last: a + 300, marks: { better: 1, tie: 0, worse: 1, waiting: 1 } });
  expect(d.contract).toEqual({ batches: [{ at: a + 7200, games: 2, calls: [{ streamId: 1, direction: 'up' }] }], skipped: null });
  expect(d.open).toBe(true);
  expect(dayOf({ date: '2026-10-20', rows: rows.slice(0, 2), predictions: [] }).contract).toEqual({ batches: [], skipped: 'gas above the ceiling: …' });
  expect(dayOf({ date: '2026-10-25', rows, predictions }).open).toBe(false);
});
