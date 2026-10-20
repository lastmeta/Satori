// The Streams tab's Prediction streams card (docs/design/track-record.md#ui-streams): its status line, a row, a stream's
// detail and its chart, from records() / record() data.
import { describe, expect, test } from 'vitest';
import { watchText, recordRow, recordDetail, recordChart, recordGroups, firstRows, SHOWN } from './record.js';
import { sparkPath } from './format.js';

const P = 'a'.repeat(60) + 'b1c2';
const E5 = 'e5'.repeat(32);
const rec = (o = {}) => ({
  pubkey: P, stream: 'btc_pred', name: 'Predictions for BTC', mine: false, sameAuthor: false,
  source: { pubkey: E5, stream: 'btc', name: 'Bitcoin', announced: true },
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
    expect(watchText({ streams: 3, at: 5, left: 0 }, list)).toBe('Watching 3 prediction streams · 2 with a record');
    expect(watchText({ streams: 1, at: 5, left: 0 }, [rec({ mark: null })])).toBe('Watching 1 prediction stream · none with a record yet');
    expect(watchText({ streams: 3, at: 5, left: 14 }, list)).toBe('Watching 3 prediction streams (14 more on the relays not watched) · 2 with a record');
  });
  test('the count is the list\'s (the rows shown and "Show all N" say the same); the status\'s before the list is read', () => {
    const list = [rec(), rec({ mark: null })];
    expect(watchText({ streams: 5, at: 5, left: 0 }, list)).toBe('Watching 2 prediction streams · 1 with a record');
    expect(watchText({ streams: 5, at: 5, left: 0 }, [])).toBe('Watching 5 prediction streams · none with a record yet');
  });
});

describe('a row', () => {
  test('the predictor (a short key, or you), the pill (the Models tab\'s), from N, the cadence; its title names the source and its author', () => {
    expect(recordRow(rec())).toEqual({ key: `${P}:btc_pred`, title: 'Predictions for Bitcoin by e5e5e5e5…e5e5', by: 'aaaaaaaa…b1c2',
      byTitle: P, mine: false, own: '', mark: 'better', markText: '12% better', markShort: '12% better', from: 'from 21', cadence: '15 min',
      markTitle: '12% less error than no change, over the last 21 predictions this neuron received before the outcome' });
    expect(recordRow(rec({ mine: true })).by).toBe('you');
    expect(recordRow(rec({ mark: 'tie', ratio: 1.02, markText: 'Same as no change' }))).toMatchObject({ mark: 'tie', markShort: 'Same' });
    expect(recordRow(rec({ source: { pubkey: E5, stream: 'btc', name: null, announced: false } })).title)
      .toBe('Predictions for btc by e5e5e5e5…e5e5 (not announced)');
  });
  test('a predictor whose key is the source\'s author: "predicts its own stream"', () => {
    expect(recordRow(rec({ sameAuthor: true, source: { pubkey: P, stream: 'btc', name: 'Bitcoin', announced: true } })).own).toBe('predicts its own stream');
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

describe('grouped by source (a buyer picks the source first)', () => {
  const F = 'f0'.repeat(32);
  test("one group per source: its name, its author, 'not announced' when so; its prediction streams under it, best first", () => {
    const list = [ // records(): best first
      rec({ pubkey: 'a1'.repeat(32), stream: 'btc_pred', source: { pubkey: F, stream: 'btc', name: 'btc', announced: false }, ratio: 0, markText: '100% better' }),
      rec({ pubkey: 'a2'.repeat(32), ratio: 0.5, markText: '50% better' }),
      rec({ pubkey: 'a3'.repeat(32), stream: 'eth_pred', source: { pubkey: E5, stream: 'eth', name: 'Ether', announced: true }, ratio: 0.7, markText: '30% better' }),
      rec({ pubkey: 'a4'.repeat(32), mark: 'worse', ratio: 1.5, markText: '50% worse' }),
      rec({ pubkey: 'a5'.repeat(32), mark: null, ratio: null, scored: 2, markText: 'Not scored yet' }),
    ];
    const g = recordGroups(list);
    expect(g.map((x) => [x.name, x.by, x.announced, x.note, x.rows.map((r) => r.markText)])).toEqual([
      ['Bitcoin', 'e5e5e5e5…e5e5', true, '', ['50% better', '50% worse', 'Not scored yet']], // its best: 50% better
      ['Ether', 'e5e5e5e5…e5e5', true, '', ['30% better']],
      ['btc', 'f0f0f0f0…f0f0', false, 'not announced', ['100% better']], // a perfect record against an unannounced source: last
    ]);
    expect(g[0]).toMatchObject({ key: `${E5}:btc`, stream: 'btc', byTitle: E5 });
    expect(recordGroups([])).toEqual([]);
  });
  test(`the first ${SHOWN} rows across the groups, a group cut where the limit falls; all on asking`, () => {
    const many = Array.from({ length: 30 }, (_, i) => rec({ pubkey: i.toString(16).padStart(64, '0'),
      source: { pubkey: E5, stream: i < 20 ? 'btc' : 'eth', name: i < 20 ? 'Bitcoin' : 'Ether', announced: true } }));
    const g = recordGroups(many);
    expect(firstRows(g, SHOWN).map((x) => x.rows.length)).toEqual([20, 5]);
    expect(firstRows(g, 10).map((x) => x.rows.length)).toEqual([10]);
    expect(firstRows(g, Infinity)).toEqual(g);
  });
});

describe('a stream\'s detail', () => {
  test('the record in plain words, the direction, since when, and what it counts', () => {
    const d = recordDetail(rec());
    expect(d.title).toBe('Predictions for Bitcoin');
    expect(d.sub).toBe('btc_pred by aaaaaaaa…b1c2 · every 15 min');
    expect(d.source).toBe('Source: Bitcoin (btc) by e5e5e5e5…e5e5');
    expect(d.lines).toEqual([
      '12% less error than no change over the last 21 predictions (median error 0.88; no change 1)',
      'Right way 15 of 20',
    ]);
    expect(d.note).toMatch(/^Seen by this neuron since Oct \d+, \d\d:\d\d\. It counts only predictions this neuron received before the outcome\.$/);
    expect(recordDetail(rec({ mine: true })).sub).toBe('btc_pred by you · every 15 min');
    expect(recordDetail(rec({ direction: { right: 0, total: 0 } })).lines).toHaveLength(1);
  });
  test("the source's author and whether it is announced; a predictor that is the source's author", () => {
    expect(recordDetail(rec({ source: { pubkey: E5, stream: 'btc', name: 'btc', announced: false } })).source)
      .toBe('Source: btc by e5e5e5e5…e5e5, not announced');
    expect(recordDetail(rec({ sameAuthor: true, source: { pubkey: P, stream: 'btc', name: 'Bitcoin', announced: true } })).source)
      .toBe('Source: Bitcoin (btc) by aaaaaaaa…b1c2: it predicts its own stream');
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
