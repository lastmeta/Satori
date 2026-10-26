import { describe, expect, it } from 'vitest';
import { outcomePairs } from './outcomes.js';

const H = 100;

describe('outcomePairs', () => {
  it('pairs each forecast with the first value at or after its time, oldest first', () => {
    const history = [{ ts: 0, value: 1 }, { ts: 100, value: 2 }, { ts: 200, value: 3 }, { ts: 300, value: 4 }];
    expect(outcomePairs([{ at: 100, value: 2.5 }, { at: 0, value: 1.5 }], history, H)).toEqual([
      { ts: 100, predicted: 1.5, actual: 2 }, { ts: 200, predicted: 2.5, actual: 3 }]);
  });

  it('leaves out forecasts whose time has not come, and outcomes too late after it', () => {
    const history = [{ ts: 0, value: 1 }, { ts: 260, value: 5 }];
    expect(outcomePairs([{ at: 0, value: 2 }, { at: 300, value: 9 }], history, H)).toEqual([]); // 260 is 160 past 100
    expect(outcomePairs([{ at: 120, value: 2 }], history, H)).toEqual([{ ts: 260, predicted: 2, actual: 5 }]);
  });

  it('an outcome forecast twice keeps the latest forecast', () => {
    const history = [{ ts: 100, value: 7 }];
    expect(outcomePairs([{ at: -10, value: 1 }, { at: 0, value: 2 }], history, H)).toEqual([{ ts: 100, predicted: 2, actual: 7 }]);
  });

  it('keeps the last n, and skips values that are not numbers', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ ts: (i + 1) * H, value: i }));
    const forecasts = Array.from({ length: 10 }, (_, i) => ({ at: i * H, value: i + 0.5 })).concat([{ at: 5, value: NaN }]);
    const pairs = outcomePairs(forecasts, history, H, 3);
    expect(pairs.map((p) => p.ts)).toEqual([800, 900, 1000]);
  });
});
