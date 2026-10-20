// The Streams tab's Prediction streams card (docs/design/track-record.md#ui-streams): its status line, a row, a stream's
// detail and its chart, from records() / record() data.
import { describe, expect, test } from 'vitest';
import { watchText, recordRow, recordDetail, recordChart, SHOWN } from './record.js';
import { sparkPath } from './format.js';

const P = 'a'.repeat(60) + 'b1c2';
const rec = (o = {}) => ({
  pubkey: P, stream: 'btc_pred', name: 'Predictions for BTC', mine: false, source: { pubkey: 'e5'.repeat(32), stream: 'btc', name: 'Bitcoin' },
  cadence_seconds: 900, received: 30, scored: 21, error: 0.88, noChange: 1, ratio: 0.88, mark: 'better', markText: '12% better',
  direction: { right: 15, total: 20 }, since: 1_792_000_000, last: { value: 101.5, received_at: 1_792_100_000 }, ...o,
});

describe('the status line', () => {
  test('before the first scan: finding them (or why not yet); then how many are watched and how many have a record', () => {
    expect(watchText({ streams: 0, at: null, error: null }, [])).toBe('Finding prediction streams…');
    expect(watchText({ streams: 0, at: null, error: 'No relay is connected. Check the relays under Settings.' }, []))
      .toBe('Not watching yet: No relay is connected. Check the relays under Settings.');
    expect(watchText({ streams: 0, at: 5, error: null }, [])).toBe('No prediction streams on the relays yet.');
    const list = [rec(), rec({ mark: null }), rec({ mark: 'worse' })];
    expect(watchText({ streams: 112, at: 5, left: 0 }, list)).toBe('Watching 112 prediction streams · 2 with a record');
    expect(watchText({ streams: 1, at: 5, left: 0 }, [rec({ mark: null })])).toBe('Watching 1 prediction stream · none with a record yet');
    expect(watchText({ streams: 200, at: 5, left: 14 }, list)).toBe('Watching 200 prediction streams (the newest announced; 14 more not watched) · 2 with a record');
  });
});

describe('a row', () => {
  test('"Predictions for" the source, the predictor (a short key, or you), the pill (the Models tab\'s), from N, the cadence', () => {
    expect(recordRow(rec())).toEqual({ key: `${P}:btc_pred`, title: 'Predictions for Bitcoin', by: 'aaaaaaaa…b1c2', byTitle: P, mine: false,
      mark: 'better', markText: '12% better', markShort: '12% better', from: 'from 21', cadence: '15 min',
      markTitle: '12% less error than no change, over the last 21 predictions this neuron received before the outcome' });
    expect(recordRow(rec({ mine: true })).by).toBe('you');
    expect(recordRow(rec({ mark: 'tie', ratio: 1.02, markText: 'Same as no change' }))).toMatchObject({ mark: 'tie', markShort: 'Same' });
    expect(recordRow(rec({ source: { pubkey: 'x', stream: 'btc', name: null } })).title).toBe('Predictions for btc');
  });
  test('not scored yet: how far it is (3 of 5), or nothing yet; its title says what it waits for', () => {
    const r = recordRow(rec({ mark: null, ratio: null, error: null, noChange: null, scored: 3, markText: 'Not scored yet' }));
    expect(r).toMatchObject({ mark: 'none', markText: 'Not scored yet', from: '3 of 5' });
    expect(r.markTitle).toBe('Not scored yet: 3 of the 5 predictions it needs, received before their outcomes');
    expect(recordRow(rec({ mark: null, scored: 0, markText: 'Not scored yet' })).from).toBe('');
    expect(recordRow(rec({ mark: 'worse', ratio: null, markText: 'Worse' })).markTitle).toMatch(/^More error than no change/);
  });
  test(`the list shows the first ${SHOWN}, then all on asking`, () => {
    expect(SHOWN).toBe(25);
  });
});

describe('a stream\'s detail', () => {
  test('the record in plain words, the direction, since when, and what it counts', () => {
    const d = recordDetail(rec());
    expect(d.title).toBe('Predictions for Bitcoin');
    expect(d.sub).toBe('btc_pred by aaaaaaaa…b1c2 · every 15 min');
    expect(d.lines).toEqual([
      '12% less error than no change over the last 21 predictions (median error 0.88; no change 1)',
      'Right way 15 of 20',
    ]);
    expect(d.note).toMatch(/^Seen by this neuron since Oct \d+, \d\d:\d\d\. It counts only predictions this neuron received before the outcome\.$/);
    expect(recordDetail(rec({ mine: true })).sub).toBe('btc_pred by you · every 15 min');
    expect(recordDetail(rec({ direction: { right: 0, total: 0 } })).lines).toHaveLength(1);
  });
  test('not scored yet, and nothing seen yet', () => {
    const d = recordDetail(rec({ mark: null, ratio: null, error: null, noChange: null, scored: 2, since: 1_792_000_000, markText: 'Not scored yet' }));
    expect(d.lines[0]).toBe('Not scored yet: 2 of the 5 predictions it needs');
    const none = recordDetail(rec({ mark: null, scored: 0, since: null, received: 0, direction: { right: 0, total: 0 }, markText: 'Not scored yet' }));
    expect(none.lines).toEqual(['Not scored yet: no prediction received before its outcome so far']);
    expect(none.note).toBe('It counts only predictions this neuron received before the outcome.');
  });
  test('the chart: the outcomes as a line and the predictions dashed, on one scale; its top and bottom values', () => {
    const pairs = [{ ts: 1, predicted: 101, actual: 100, baseline: 99 }, { ts: 2, predicted: 104, actual: 102, baseline: 100 },
      { ts: 3, predicted: 101, actual: 103, baseline: 102 }];
    const c = recordChart(pairs, { w: 300, h: 80 });
    expect(c.actual).toBe(sparkPath([100, 102, 103], 300, 80, [100, 104]));
    expect(c.predicted).toBe(sparkPath([101, 104, 101], 300, 80, [100, 104]));
    expect([c.top, c.bottom, c.n]).toEqual(['104', '100', 3]);
    expect(recordChart(pairs.slice(0, 1))).toBeNull(); // a line needs two
    expect(recordChart([])).toBeNull();
  });
});
