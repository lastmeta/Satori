// The track record (docs/design/track-record.md): which prediction streams are watched, the follow filters, the
// verified-order scoring and the records, pure; then the watched set over a real (in-memory) db.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryConn } from '../../test/memory-db.js';
import { openDb } from '../db/index.js';
import { signEvent, nostrPubkey } from '../nostr/event.js';
import { announceEvent, tombstoneEvent, observationEvent, catalog, parseObservation, relayUuid } from '../nostr/satori.js';
import {
  sourceOf, selectWatched, watchRows, followFilters, scoreRecord, sortRecords, createWatch,
  WATCH_CAP, WATCH_DROP_S, WATCH_SCAN_S, RECORD_N, RECORD_READ, MIN_SCORED,
} from './records.js';
import { DEFAULT_CADENCE_S, RELAY_WINDOW } from './nostr.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ME = 'dd278564ca11c31ffb929b807c65d07a7cb0fddfd26b2d97a91f84ed0b3086e4';
const ME_PUB = nostrPubkey(ME);
const A = '1'.repeat(63) + '2'; // a predictor
const A_PUB = nostrPubkey(A);
const B = '2'.repeat(63) + '3'; // another
const B_PUB = nostrPubkey(B);
const SRC = '3'.repeat(63) + '1'; // a source provider
const SRC_PUB = nostrPubkey(SRC);

/** A `_pred` announcement as Lite makes it (predMetadata): the source in its tags and its metadata. */
function predAnn(secret, source, { at = 1000, name, cadence = 900, tags = true, meta = true, stream } = {}) {
  const pub = nostrPubkey(secret);
  const m = {
    stream_name: stream ?? `${source.stream}_pred`, nostr_pubkey: pub, name: name ?? `Predictions for ${source.name ?? source.stream}`,
    cadence_seconds: cadence, metadata: meta ? { source_stream_name: source.stream, source_provider_pubkey: source.pubkey, alias_pubkey: '02ab' } : null,
  };
  const e = announceEvent(m, at);
  if (!tags) e.tags = e.tags.filter((t) => !['source_stream', 'source_pubkey'].includes(t[0]));
  else if (!meta) e.tags.push(['source_stream', source.stream], ['source_pubkey', source.pubkey]); // the tags alone
  return signEvent(e, secret);
}
const srcAnn = (stream, { at = 900, name = stream.toUpperCase(), cadence = 900 } = {}) =>
  signEvent(announceEvent({ stream_name: stream, nostr_pubkey: SRC_PUB, name, cadence_seconds: cadence }, at), SRC);
const btc = { pubkey: SRC_PUB, stream: 'btc' };

describe('which prediction streams are watched', () => {
  test("sourceOf: the source_stream and source_pubkey tags (Lite's), else the metadata's; a pubkey of 64 hex", () => {
    const [both] = catalog([predAnn(A, btc)]);
    expect(sourceOf(both)).toEqual({ pubkey: SRC_PUB, stream: 'btc' });
    const [metaOnly] = catalog([predAnn(A, btc, { tags: false })]);
    expect(sourceOf(metaOnly)).toEqual({ pubkey: SRC_PUB, stream: 'btc' });
    const [tagsOnly] = catalog([predAnn(A, { pubkey: SRC_PUB.toUpperCase(), stream: 'btc' }, { meta: false })]);
    expect(sourceOf(tagsOnly)).toEqual({ pubkey: SRC_PUB, stream: 'btc' }); // lowercased
    const [none] = catalog([predAnn(A, btc, { tags: false, meta: false })]);
    expect(sourceOf(none)).toBeNull();
    const [bad] = catalog([predAnn(A, { pubkey: 'e5e6', stream: 'btc' })]);
    expect(sourceOf(bad)).toBeNull();
  });

  test('every `_pred` that names its source, with its source; not a plain stream, not one with no source, not a tombstone', () => {
    const events = [
      srcAnn('btc'), srcAnn('eth'),
      predAnn(A, btc, { at: 1000 }),
      predAnn(B, btc, { at: 1100, tags: false, meta: false }), // no source named
      predAnn(A, { pubkey: SRC_PUB, stream: 'eth' }, { at: 1200 }),
      signEvent(tombstoneEvent('eth_pred', A_PUB, 1300), A), // replaces A's eth_pred: gone
    ];
    const { list, found, left } = selectWatched(catalog(events), { me: ME_PUB });
    expect([found, left]).toEqual([1, 0]);
    expect(list).toEqual([{
      pubkey: A_PUB, stream: 'btc_pred', name: 'Predictions for btc', cadence_seconds: 900, announced_at: 1000, mine: false,
      source: { pubkey: SRC_PUB, stream: 'btc', name: 'BTC', announced: true, cadence_seconds: 900 },
    }]);
  });

  test("the cap: ours first, then the most recently announced; how many it left out", () => {
    const events = [];
    for (let i = 0; i < WATCH_CAP + 3; i++) events.push(predAnn(A, { pubkey: SRC_PUB, stream: `s${i}` }, { at: 2000 + i }));
    events.push(predAnn(ME, btc, { at: 10 })); // ours, announced long ago
    const { list, found, left } = selectWatched(catalog(events), { me: ME_PUB });
    expect([list.length, found, left]).toEqual([WATCH_CAP, WATCH_CAP + 4, 4]);
    expect(list[0]).toMatchObject({ pubkey: ME_PUB, stream: 'btc_pred', mine: true });
    expect(list[1].stream).toBe(`s${WATCH_CAP + 2}_pred`); // the newest
    expect(list.at(-1).stream).toBe('s4_pred'); // s0…s3 left out
    expect(selectWatched(catalog(events), { me: ME_PUB, cap: 2 }).list.map((x) => x.stream)).toEqual(['btc_pred', `s${WATCH_CAP + 2}_pred`]);
    // a stream we buy (docs/design/market.md) is kept ahead of the newcomers, as ours
    expect(selectWatched(catalog(events), { me: ME_PUB, cap: 2, keep: new Set([`${A_PUB}:s0_pred`]) }).list.map((x) => x.stream).sort())
      .toEqual(['btc_pred', 's0_pred']);
  });

  test("cadence: the prediction stream's, else its source's, else a day; a source unannounced takes its prediction stream's", () => {
    const events = [srcAnn('btc', { cadence: 600 }), srcAnn('eth', { cadence: null }),
      predAnn(A, btc, { at: 1, cadence: null }), predAnn(B, btc, { at: 2, cadence: 300 }),
      predAnn(A, { pubkey: SRC_PUB, stream: 'eth' }, { at: 3, cadence: null }),
      predAnn(B, { pubkey: SRC_PUB, stream: 'gold' }, { at: 4, cadence: 1800 })];
    const by = Object.fromEntries(selectWatched(catalog(events)).list.map((x) => [`${x.pubkey === A_PUB ? 'A' : 'B'}:${x.stream}`, x]));
    expect(by['A:btc_pred']).toMatchObject({ cadence_seconds: 600, source: { cadence_seconds: 600 } });
    expect(by['B:btc_pred']).toMatchObject({ cadence_seconds: 300, source: { cadence_seconds: 600 } });
    expect(by['A:eth_pred']).toMatchObject({ cadence_seconds: DEFAULT_CADENCE_S, source: { cadence_seconds: DEFAULT_CADENCE_S } });
    expect(by['B:gold_pred']).toMatchObject({ cadence_seconds: 1800, source: { cadence_seconds: 1800, name: 'gold' } });
  });

  test("a source's name: its own announcement's, else its stream id as is; never the predictor's words; announced or not", () => {
    const events = [srcAnn('btc', { name: 'Bitcoin' }), predAnn(A, btc, { at: 1, name: 'Predictions for BTC/USD' }),
      predAnn(A, { pubkey: SRC_PUB, stream: 'eth' }, { at: 2, name: 'Predictions for Ether' }),
      predAnn(A, { pubkey: SRC_PUB, stream: 'gold' }, { at: 3, name: 'My gold guesses' })];
    const by = Object.fromEntries(selectWatched(catalog(events)).list.map((x) => [x.source.stream, [x.source.name, x.source.announced]]));
    expect(by).toEqual({ btc: ['Bitcoin', true], eth: ['eth', false], gold: ['gold', false] });
  });

  test('a fake source: a stream the predictor controls under another key, unannounced, is named by its id, not the predictor\'s "BTC"', () => {
    const fake = { pubkey: B_PUB, stream: 'btc' }; // the predictor's second key, never announced
    const events = [srcAnn('btc', { name: 'BTC' }), predAnn(A, btc, { at: 1, name: 'Predictions for BTC' }),
      predAnn(ME, fake, { at: 2, name: 'Predictions for BTC' })];
    const [mine, honest] = selectWatched(catalog(events), { me: ME_PUB }).list;
    expect(mine.source).toEqual({ pubkey: B_PUB, stream: 'btc', name: 'btc', announced: false, cadence_seconds: 900 });
    expect(honest.source).toMatchObject({ pubkey: SRC_PUB, name: 'BTC', announced: true });
  });

  test('watchRows: each prediction stream and each source once; a stream that is both is a pred', () => {
    const events = [srcAnn('btc'), predAnn(A, btc, { at: 2 }), predAnn(B, btc, { at: 1 }),
      predAnn(B, { pubkey: A_PUB, stream: 'btc_pred' }, { at: 3, stream: 'btc_pred_pred' })]; // predicts A's btc_pred
    const rows = watchRows(selectWatched(catalog(events)).list, 5000);
    const by = Object.fromEntries(rows.map((r) => [`${r.pubkey === A_PUB ? 'A' : r.pubkey === B_PUB ? 'B' : 'S'}:${r.stream_name}`, r]));
    expect(rows).toHaveLength(4);
    expect(by['A:btc_pred']).toEqual({ uuid: relayUuid(A_PUB, 'btc_pred'), pubkey: A_PUB, stream_name: 'btc_pred', kind: 'pred',
      source_uuid: relayUuid(SRC_PUB, 'btc'), name: 'Predictions for btc', cadence_seconds: 900, meta: JSON.stringify({ announced_at: 2 }), seen_at: 5000 });
    expect(by['S:btc']).toEqual({ uuid: relayUuid(SRC_PUB, 'btc'), pubkey: SRC_PUB, stream_name: 'btc', kind: 'source', source_uuid: null,
      name: 'BTC', cadence_seconds: 900, meta: JSON.stringify({ announced: true }), seen_at: 5000 });
    expect(by['B:btc_pred_pred']).toMatchObject({ kind: 'pred', source_uuid: relayUuid(A_PUB, 'btc_pred') });
  });

  test('followFilters: one filter per author (sorted), its streams in one sorted #d list, each once', () => {
    expect(followFilters([[B_PUB, 'x'], [A_PUB, 'b'], [A_PUB, 'a'], [B_PUB, 'x'], [A_PUB, 'b']])).toEqual([
      { kinds: [34601], authors: [A_PUB < B_PUB ? A_PUB : B_PUB], '#d': A_PUB < B_PUB ? ['a', 'b'] : ['x'] },
      { kinds: [34601], authors: [A_PUB < B_PUB ? B_PUB : A_PUB], '#d': A_PUB < B_PUB ? ['x'] : ['a', 'b'] },
    ]);
    expect(followFilters([])).toEqual([]);
  });
});

describe('the verified-order rule', () => {
  // the source every 900 s from t = 10,000 (seq k at 10,000 + 900k, value 100 + k, received 1 s after its time); a
  // prediction 1 s after each source observation, received 2 s after it
  const T0 = 10_000;
  const C = 900;
  const obs = (k, value = 100 + k, o = {}) => ({ seq: k, ts: T0 + C * k, value, received_at: T0 + C * k + 1, ...o });
  const series = (n, f = (k) => 100 + k) => Array.from({ length: n }, (_, k) => obs(k, f(k)));
  const pred = (k, value, o = {}) => ({ seq: k + 1, ts: T0 + C * k + 1, value, received_at: T0 + C * k + 2, ...o });

  test('a prediction received before its outcome is scored against the next observation, its baseline the one before', () => {
    const r = scoreRecord({ predictions: [pred(0, 101.5)], observations: series(3) });
    expect(r.pairs).toEqual([{ ts: T0 + C, predicted: 101.5, actual: 101, baseline: 100 }]);
  });

  test('a backdated prediction received after its outcome is not scored; nor is one with no baseline', () => {
    const late = pred(0, 101, { received_at: T0 + C + 5 }); // claims t0 + 1, arrived after the outcome at t0 + 900
    const atOutcome = pred(1, 102, { received_at: T0 + 2 * C }); // arrived the second the outcome happened: not before it
    const early = pred(-1, 99, { ts: T0 - 10, received_at: T0 - 9 }); // before the source's first observation: no baseline
    const r = scoreRecord({ predictions: [late, atOutcome, early, pred(2, 103)], observations: series(4) });
    expect(r.pairs).toEqual([{ ts: T0 + 3 * C, predicted: 103, actual: 103, baseline: 102 }]);
  });

  test("a stored prediction the relay hands over late is scored against the outcome still to come", () => {
    // made at t0 + 1, received only at t0 + 600 (a page opened then, the baseline handed over with it): the outcome at
    // t0 + 900 was still to come
    const o = series(2);
    o[0] = { ...o[0], received_at: T0 + 600 };
    expect(scoreRecord({ predictions: [pred(0, 101, { received_at: T0 + 600 })], observations: o }).pairs).toHaveLength(1);
  });

  test('it must arrive here before the outcome arrived here, not only before the outcome\'s time (a source clock ahead of ours)', () => {
    // the source stamps each outcome 2 s ahead of our clock (or ours runs 2 s behind): a copier publishes the outcome's
    // value as soon as it sees it; the copy reaches us 1 s after the outcome did, still before the outcome's time on our clock
    const o = [];
    const p = [];
    for (let k = 0; k < 6; k++) {
      const base = 100_000 + k * 2 * C;
      o.push({ seq: 2 * k + 1, ts: base, value: 100 + k, received_at: base - 2 + 1 },
        { seq: 2 * k + 2, ts: base + C, value: 110 + k, received_at: base + C - 2 + 1 });
      p.push({ seq: k + 1, ts: base + 5, value: 110 + k, received_at: base + C - 2 + 2 }); // after the outcome arrived
    }
    expect(scoreRecord({ predictions: p, observations: o })).toMatchObject({ scored: 0, mark: null });
    // the same second as the outcome's arrival: not before it either
    const same = p.map((x) => ({ ...x, received_at: x.received_at - 1 }));
    expect(scoreRecord({ predictions: same, observations: o }).scored).toBe(0);
    // a moment earlier: scored
    const before = p.map((x) => ({ ...x, received_at: x.ts + 5 }));
    expect(scoreRecord({ predictions: before, observations: o }).scored).toBe(6);
  });

  test('the lead: it must arrive within the first half of the interval after its baseline arrived here', () => {
    // a nowcast: published 3 s before each outcome is stamped, from the source's own upstream (no forecast at all)
    const o = series(12);
    const nowcast = Array.from({ length: 11 }, (_, k) => pred(k, 100 + k + 1, { ts: T0 + C * (k + 1) - 3, received_at: T0 + C * (k + 1) - 2 }));
    expect(scoreRecord({ predictions: nowcast, observations: o })).toMatchObject({ scored: 0, mark: null });
    // r_p − r_b ≤ (o.ts − b.ts) / 2: at the half, scored; a second later, not
    const half = (k, d) => pred(k, 100 + k + 1, { received_at: T0 + C * k + 1 + C / 2 + d });
    expect(scoreRecord({ predictions: [half(0, 0), half(1, 1)], observations: o }).pairs.map((x) => x.ts)).toEqual([T0 + C]);
    // the baseline handed over late (a page opened then) moves the lead with it
    const late = series(3);
    late[1] = { ...late[1], received_at: T0 + C + 800 };
    expect(scoreRecord({ predictions: [pred(1, 102, { received_at: T0 + C + 805 })], observations: late }).scored).toBe(1);
  });

  test('a prediction without an arrival, or an outcome or baseline without one, is not scored', () => {
    const o = series(3);
    expect(scoreRecord({ predictions: [pred(0, 101, { received_at: null })], observations: o }).scored).toBe(0);
    expect(scoreRecord({ predictions: [pred(0, 101)], observations: [o[0], { ...o[1], received_at: null }] }).scored).toBe(0);
    expect(scoreRecord({ predictions: [pred(0, 101)], observations: [{ ...o[0], received_at: undefined }, o[1]] }).scored).toBe(0);
  });

  test('the baseline is the latest observation at or before the prediction\'s time (the same second counts)', () => {
    const p = { seq: 1, ts: T0 + C, value: 102.5, received_at: T0 + C + 1 }; // in the second of seq 1
    expect(scoreRecord({ predictions: [p], observations: series(3) }).pairs).toEqual([{ ts: T0 + 2 * C, predicted: 102.5, actual: 102, baseline: 101 }]);
  });

  test("an observation missed between the baseline and the outcome (the tab was closed): not scored", () => {
    const seen = series(6).filter((o) => o.seq !== 2); // seq 2 never arrived here
    const r = scoreRecord({ predictions: [pred(0, 1), pred(1, 1), pred(3, 1), pred(4, 1)], observations: seen });
    expect(r.pairs.map((x) => x.ts)).toEqual([T0 + C, T0 + 4 * C, T0 + 5 * C]); // pred(1) would be judged two ahead
  });

  test('a prediction or an outcome without a number is skipped; observations without a time are ignored', () => {
    const o = series(5);
    o[3] = { ...o[3], value: null };
    o.push({ seq: 99, ts: null, value: 5 });
    const r = scoreRecord({ predictions: [pred(0, null), pred(1, 102), pred(2, 103), pred(3, 104)], observations: o });
    expect(r.pairs.map((x) => x.ts)).toEqual([T0 + 2 * C]); // pred(2)'s outcome and pred(3)'s baseline have no number
  });

  test('error and no change are the medians of the last 28; the ratio and the mark are the Models tab\'s', () => {
    const n = 40;
    // the source steps by +1 or −1; the predictor is right half a step off every time, no change a whole step off
    const step = (k) => (k % 3 ? 1 : -1);
    const values = [100];
    for (let k = 1; k <= n; k++) values.push(values[k - 1] + step(k));
    const o = values.map((v, k) => obs(k, v));
    const p = values.slice(0, n).map((v, k) => pred(k, v + step(k + 1) * 0.5));
    const r = scoreRecord({ predictions: p, observations: o });
    expect(r.scored).toBe(RECORD_N);
    expect(r.pairs).toHaveLength(RECORD_N);
    expect(r.pairs[0].ts).toBe(T0 + C * (n - RECORD_N + 1)); // the last 28
    expect(r).toMatchObject({ error: 0.5, noChange: 1, ratio: 0.5, mark: 'better', markText: '50% better' });
    expect(r.since).toBe(T0 + C); // the first scored outcome still held
  });

  test('worse, a tie, and no change perfect (0): "Worse" with any error, the same with none', () => {
    const o = series(8);
    const r = (f) => scoreRecord({ predictions: Array.from({ length: 7 }, (_, k) => pred(k, f(k))), observations: o });
    expect(r((k) => 100 + k + 1 + 1.2)).toMatchObject({ mark: 'worse', markText: '20% worse', ratio: expect.closeTo(1.2) }); // 1.2 vs 1
    expect(r((k) => 100 + k + 1 + 1.03)).toMatchObject({ mark: 'tie', markText: 'Same as no change' });
    const flat = Array.from({ length: 8 }, (_, k) => obs(k, 50));
    const r0 = (v) => scoreRecord({ predictions: Array.from({ length: 7 }, (_, k) => pred(k, v)), observations: flat });
    expect(r0(51)).toMatchObject({ error: 1, noChange: 0, ratio: null, mark: 'worse', markText: 'Worse' });
    expect(r0(50)).toMatchObject({ error: 0, noChange: 0, ratio: 1, mark: 'tie', markText: 'Same as no change' });
  });

  test(`fewer than ${MIN_SCORED} scored: "Not scored yet", and no numbers`, () => {
    const r = scoreRecord({ predictions: [0, 1, 2, 3].map((k) => pred(k, 100 + k + 1)), observations: series(6) });
    expect(r).toMatchObject({ scored: 4, error: null, noChange: null, ratio: null, mark: null, markText: 'Not scored yet' });
    expect(r.pairs).toHaveLength(4);
    expect(scoreRecord({ predictions: [], observations: [] })).toMatchObject({ scored: 0, mark: null, since: null, pairs: [],
      direction: { right: 0, total: 0 } });
  });

  test('direction: right when the prediction and the outcome go the same way from the baseline; ties left out', () => {
    // outcomes from baseline 100: up, up, down, flat, up; predictions: up, down, down, up, flat
    const o = [100, 101, 100, 102, 101, 101, 103].map((v, k) => obs(k, v)); // baselines 100, 101, 100, 102, 101, 101
    const p = [102, 99, 101, 103, 101, 101].map((v, k) => pred(k, v));
    // pairs: (b100 → 101, p102 up/up ✓), (b101 → 100, p99 down/down ✓), (b100 → 102, p101 up/up ✓),
    // (b102 → 101, p103 up/down ✗), (b101 → 101: flat, left out), (b101 → 103, p101: flat, left out)
    expect(scoreRecord({ predictions: p, observations: o }).direction).toEqual({ right: 3, total: 4 });
  });

  test('predictions in any order; one per outcome: the earliest received that qualifies', () => {
    const p = [pred(1, 102), { ...pred(0, 100.5), seq: 50, ts: T0 + 5, received_at: T0 + 6 }, pred(0, 101),
      { ...pred(0, 999), seq: 51, ts: T0 + 3, received_at: T0 + 1 }]; // received first: it is the one counted
    expect(scoreRecord({ predictions: p, observations: series(3).reverse() }).pairs.map((x) => [x.ts, x.predicted]))
      .toEqual([[T0 + C, 999], [T0 + 2 * C, 102]]);
    // the earliest that qualifies: one without a number does not take the outcome from the next
    const q = [{ ...pred(0, null), received_at: T0 + 1 }, pred(0, 101)];
    expect(scoreRecord({ predictions: q, observations: series(2) }).pairs.map((x) => x.predicted)).toEqual([101]);
  });

  test('many predictions before one outcome make one scored, not "from 5"', () => {
    const p = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, ts: T0 + 1 + i, value: 101, received_at: T0 + 2 + i }));
    expect(scoreRecord({ predictions: p, observations: series(2) })).toMatchObject({ scored: 1, mark: null, markText: 'Not scored yet' });
    // a predictor publishing three times a cadence: from N counts the outcomes
    const o = series(9);
    const many = Array.from({ length: 8 }, (_, k) => [0, 100, 200].map((d, i) => pred(k, 100 + k + 1, { seq: 3 * k + i + 1,
      ts: T0 + C * k + 1 + d, received_at: T0 + C * k + 2 + d }))).flat();
    const r = scoreRecord({ predictions: many, observations: o });
    expect([r.scored, new Set(r.pairs.map((x) => x.ts)).size]).toEqual([8, 8]);
  });

  test('huge values never give Infinity or NaN: a pair whose error is not a finite number is not scored', () => {
    const o = Array.from({ length: 7 }, (_, k) => obs(k, k % 2 ? 1e308 : 0));
    const huge = Array.from({ length: 6 }, (_, k) => pred(k, -1e308));
    const h = scoreRecord({ predictions: huge, observations: o }); // the three outcomes of 1e308: |−1e308 − 1e308| is Infinity
    expect(h).toMatchObject({ scored: 3, error: null, noChange: null, ratio: null, mark: null });
    expect(h.pairs.every((x) => x.actual === 0)).toBe(true);
    // finite errors whose median of two would overflow: still a number
    const big = Array.from({ length: 7 }, (_, k) => obs(k, k % 2 ? 1.7e308 : 0));
    const r = scoreRecord({ predictions: Array.from({ length: 6 }, (_, k) => pred(k, 0)), observations: big });
    expect([r.error, r.noChange].every(Number.isFinite)).toBe(true);
    expect(r.markText).not.toMatch(/Infinity|NaN/);
  });
});

test('sortRecords: a record before "not scored yet", by ratio (no change perfect last among them), then by how many are scored', () => {
  const r = (stream, o) => ({ stream, name: stream, mark: null, ratio: null, scored: 0, received: 0, ...o });
  const list = [r('none-few', { scored: 2 }), r('worse', { mark: 'worse', ratio: 1.2, scored: 10 }), r('perfect-nc', { mark: 'worse', ratio: null, scored: 9 }),
    r('better', { mark: 'better', ratio: 0.5, scored: 6 }), r('none-more', { scored: 4 }), r('tie', { mark: 'tie', ratio: 1, scored: 28 }),
    r('better2', { mark: 'better', ratio: 0.5, scored: 20 })];
  expect(sortRecords(list).map((x) => x.stream)).toEqual(['better2', 'better', 'tie', 'worse', 'perfect-nc', 'none-more', 'none-few']);
});

describe('the watched set (createWatch) over the db', () => {
  let db;
  let clock;
  let changes;
  let watch;
  let connection;
  const conn = () => connection; // the db's own connection: a test's bulk rows in one statement
  const now = () => clock;
  beforeEach(async () => {
    connection = await memoryConn();
    db = await openDb(connection);
    clock = 1_792_000_000;
    changes = 0;
    watch = createWatch({ db, me: ME_PUB, now, onChange: () => changes++ });
    await watch.load();
  });
  const obsEvent = (secret, stream, value, seq, timestamp) => signEvent(observationEvent({ stream, value, seq, timestamp, now: timestamp }), secret);
  const take = (e) => {
    const o = parseObservation(e);
    return watch.intake(relayUuid(o.provider, o.stream_name), o, e);
  };

  test('apply: the selection kept (preds and sources), the follow pairs; a second apply with the same set changes nothing', async () => {
    const cat = catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 }), predAnn(ME, btc, { at: 1 })]);
    expect(await watch.apply(cat)).toEqual({ found: 2, left: 0, changed: true });
    expect(watch.count()).toEqual({ streams: 2, sources: 1 });
    expect(watch.has(relayUuid(A_PUB, 'btc_pred'))).toBe(true);
    expect(watch.has(relayUuid(SRC_PUB, 'btc'))).toBe(true);
    expect(watch.pairs().map(([p, s]) => `${p === A_PUB ? 'A' : p === ME_PUB ? 'me' : 'S'}:${s}`).sort()).toEqual(['A:btc_pred', 'S:btc', 'me:btc_pred']);
    clock += 3600;
    expect(await watch.apply(cat)).toEqual({ found: 2, left: 0, changed: false });
    expect((await db.watchStreams()).map((r) => r.seen_at)).toEqual([clock, clock, clock]);
    expect((await db.watchStreams()).map((r) => r.added_at)).toEqual([clock - 3600, clock - 3600, clock - 3600]);
  });

  test('intake: each observation once (the first copy and its arrival kept), rounded up to the second; records follow', async () => {
    await watch.apply(catalog([srcAnn('btc', { cadence: 60 }), predAnn(A, btc, { at: 2, cadence: 60 })]));
    const t0 = clock - 600;
    for (let k = 0; k < 8; k++) {
      clock = t0 + 60 * k + 0.25;
      await take(obsEvent(SRC, 'btc', String(100 + k), k + 1, t0 + 60 * k));
      clock += 0.5;
      const e = obsEvent(A, 'btc_pred', String(100 + k + 1), k + 1, t0 + 60 * k + 1); // right every time
      expect(await take(e)).toBe(true);
      expect(await take(e)).toBe(false); // a second copy (another relay): ignored
    }
    expect(changes).toBe(16);
    const [rec] = await watch.list();
    expect(rec).toEqual({ pubkey: A_PUB, stream: 'btc_pred', name: 'Predictions for btc', mine: false, sameAuthor: false,
      source: { pubkey: SRC_PUB, stream: 'btc', name: 'BTC', announced: true }, cadence_seconds: 60, received: 8, scored: 7,
      error: 0, noChange: 1, ratio: 0, mark: 'better', markText: '100% better', direction: { right: 7, total: 7 },
      since: t0 + 60, last: { value: 108, received_at: Math.ceil(t0 + 60 * 7 + 0.75) } });
    const one = await watch.one(A_PUB, 'btc_pred');
    expect(one.pairs).toHaveLength(7);
    expect(one.pairs[0]).toEqual({ ts: t0 + 60, predicted: 101, actual: 101, baseline: 100 });
    expect(await watch.one(B_PUB, 'btc_pred')).toBeNull();
    // stored with when it arrived, rounded up (never earlier than it did)
    const rows = (await db.watchObservations([relayUuid(A_PUB, 'btc_pred')])).get(relayUuid(A_PUB, 'btc_pred'));
    expect(rows[0]).toEqual({ seq: 1, ts: t0 + 1, value: 101, received_at: Math.ceil(t0 + 0.75) });
  });

  test("records name each source by its own announcement, show its author and whether it is announced, and say when the predictor is the source's author", async () => {
    const fake = { pubkey: B_PUB, stream: 'btc' }; // A's second key: never announced
    await watch.apply(catalog([srcAnn('btc'), predAnn(A, btc, { at: 2, name: 'Predictions for BTC' }),
      predAnn(A, fake, { at: 3, name: 'Predictions for BTC', stream: 'btc2_pred' }),
      predAnn(SRC, btc, { at: 4, name: 'Predictions for BTC' })])); // the source's author predicts its own stream
    const by = Object.fromEntries((await watch.list()).map((r) => [`${r.pubkey === A_PUB ? 'A' : 'S'}:${r.stream}`, r]));
    expect(by['A:btc_pred']).toMatchObject({ sameAuthor: false, source: { pubkey: SRC_PUB, stream: 'btc', name: 'BTC', announced: true } });
    expect(by['A:btc2_pred']).toMatchObject({ sameAuthor: false, source: { pubkey: B_PUB, stream: 'btc', name: 'btc', announced: false } });
    expect(by['S:btc_pred']).toMatchObject({ sameAuthor: true, source: { pubkey: SRC_PUB, name: 'BTC', announced: true } });
    expect((await watch.one(A_PUB, 'btc2_pred')).source).toEqual({ pubkey: B_PUB, stream: 'btc', name: 'btc', announced: false });
  });

  test('a record is computed again only when its stream or its source got something new', async () => {
    await watch.apply(catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 }), srcAnn('eth'), predAnn(B, { pubkey: SRC_PUB, stream: 'eth' }, { at: 3 })]));
    const spy = vi.spyOn(db, 'watchObservations');
    await watch.list();
    expect(spy).toHaveBeenCalledTimes(1); // both, in one read
    await watch.list();
    expect(spy).toHaveBeenCalledTimes(1); // nothing new
    await take(obsEvent(SRC, 'eth', '5', 1, clock - 10));
    await watch.list();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0].sort()).toEqual([relayUuid(B_PUB, 'eth_pred'), relayUuid(SRC_PUB, 'eth')].sort()); // eth's pred and eth
  });

  test("a stream no scan has selected for 7 days goes, with its observations; its source with it", async () => {
    await watch.apply(catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 }), srcAnn('eth'), predAnn(B, { pubkey: SRC_PUB, stream: 'eth' }, { at: 3 })]));
    await take(obsEvent(B, 'eth_pred', '5', 1, clock - 10));
    await take(obsEvent(SRC, 'eth', '5', 1, clock - 10));
    clock += WATCH_DROP_S - 1;
    const onlyBtc = catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 })]);
    expect((await watch.apply(onlyBtc)).changed).toBe(false); // eth's still watched: 7 days not yet
    expect(watch.count()).toEqual({ streams: 2, sources: 2 });
    clock += 2;
    expect((await watch.apply(onlyBtc)).changed).toBe(true);
    expect(watch.count()).toEqual({ streams: 1, sources: 1 });
    expect((await db.watchObservations([relayUuid(B_PUB, 'eth_pred'), relayUuid(SRC_PUB, 'eth')])).get(relayUuid(SRC_PUB, 'eth'))).toEqual([]);
    expect((await watch.list()).map((r) => r.stream)).toEqual(['btc_pred']);
  });

  test("prune: each watched stream's observations older than its window (RELAY_WINDOW of its cadences) go", async () => {
    await watch.apply(catalog([srcAnn('btc', { cadence: 60 }), predAnn(A, btc, { at: 2, cadence: 60 })]));
    const t0 = clock - 60 * (RELAY_WINDOW + 10);
    for (let k = 0; k < 12; k++) await take(obsEvent(SRC, 'btc', '1', k + 1, t0 + 60 * k));
    await take(obsEvent(SRC, 'btc', '1', 500, clock)); // the newest
    expect(await watch.prune()).toBe(10); // t0 … t0 + 540 are more than 400 cadences before it
    expect((await db.watchObservations([relayUuid(SRC_PUB, 'btc')])).get(relayUuid(SRC_PUB, 'btc')).map((o) => o.seq)).toEqual([11, 12, 500]);
  });

  test('the cap holds for the stored set across scans: watched ones still announced stay ahead of newcomers (no hourly churn)', async () => {
    const keys = Array.from({ length: 300 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
    // scan 1: keys 0…199 announced most recently; scan 2, 6 h later: 100…299 (Lite announces again on each connection)
    const scanAt = (order, only = () => true) => catalog([srcAnn('btc', { at: clock - 5000 }),
      ...keys.filter((_, i) => only(i)).map((k, i) => predAnn(k, btc, { at: clock - 1000 - order(i) }))]);
    const preds = async () => new Set((await db.watchStreams()).filter((r) => r.kind === 'pred').map((r) => r.pubkey));
    expect(await watch.apply(scanAt((i) => i))).toMatchObject({ found: 300, left: 100 });
    const first = await preds();
    expect(watch.count()).toEqual({ streams: 200, sources: 1 });
    clock += 6 * 3600;
    expect(await watch.apply(scanAt((i) => 299 - i))).toEqual({ found: 300, left: 100, changed: false });
    expect(watch.count()).toEqual({ streams: 200, sources: 1 });
    expect(await preds()).toEqual(first);
    expect((await watch.list())).toHaveLength(200);
    // 50 of them missing from a scan (a relay down, an announcement lost): they keep their place for 7 days, ahead of newcomers
    const k0 = new Set([...first].slice(0, 50));
    clock += 6 * 3600;
    const without = catalog([srcAnn('btc', { at: clock - 5000 }),
      ...keys.filter((k) => !k0.has(nostrPubkey(k))).map((k, i) => predAnn(k, btc, { at: clock - 1000 - i }))]);
    expect(await watch.apply(without)).toMatchObject({ found: 250, left: 100, changed: false });
    expect(watch.count()).toEqual({ streams: 200, sources: 1 });
    clock += WATCH_DROP_S;
    expect(await watch.apply(without)).toMatchObject({ found: 250, left: 50, changed: true }); // gone after 7 days; 50 newcomers in
    expect(watch.count()).toEqual({ streams: 200, sources: 1 });
    expect([...(await preds())].some((p) => k0.has(p))).toBe(false);
  }, 120_000);

  test('a tombstoned prediction stream seen by a scan goes at once, with its source when nothing else names it', async () => {
    await watch.apply(catalog([srcAnn('btc'), srcAnn('eth'), predAnn(A, btc, { at: 2 }), predAnn(B, { pubkey: SRC_PUB, stream: 'eth' }, { at: 3 })]));
    await take(obsEvent(B, 'eth_pred', '5', 1, clock - 10));
    const r = await watch.apply(catalog([srcAnn('btc'), srcAnn('eth'), predAnn(A, btc, { at: 2 }), signEvent(tombstoneEvent('eth_pred', B_PUB, 4), B)]),
      { gone: new Set([`${B_PUB}:eth_pred`]) });
    expect(r).toMatchObject({ found: 1, changed: true });
    expect(watch.count()).toEqual({ streams: 1, sources: 1 });
    expect(watch.has(relayUuid(SRC_PUB, 'eth'))).toBe(false);
    expect((await db.watchObservations([relayUuid(B_PUB, 'eth_pred')])).get(relayUuid(B_PUB, 'eth_pred'))).toEqual([]);
  });

  test('drop(): a prediction stream leaves at once (our own, unsubscribed), its source too when nothing else names it', async () => {
    await watch.apply(catalog([srcAnn('btc'), predAnn(ME, btc, { at: 2 }), predAnn(A, btc, { at: 3 }), srcAnn('eth'),
      predAnn(ME, { pubkey: SRC_PUB, stream: 'eth' }, { at: 4 })]));
    expect(watch.count()).toEqual({ streams: 3, sources: 2 });
    expect(await watch.drop([[ME_PUB, 'eth_pred']])).toBe(true);
    expect(watch.count()).toEqual({ streams: 2, sources: 1 });
    expect(await watch.drop([[ME_PUB, 'btc_pred']])).toBe(true);
    expect(watch.count()).toEqual({ streams: 1, sources: 1 }); // btc stays: A's names it
    expect(await watch.drop([[ME_PUB, 'btc_pred']])).toBe(false);
    // a scan with our old announcement still on a relay (the tombstone not there yet) does not bring it back when named gone
    await watch.apply(catalog([srcAnn('btc'), predAnn(ME, btc, { at: 2 }), predAnn(A, btc, { at: 3 })]), { gone: new Set([`${ME_PUB}:btc_pred`]) });
    expect(watch.count()).toEqual({ streams: 1, sources: 1 });
  });

  test('intake: an observation without a numeric timestamp is not kept (it could never be pruned)', async () => {
    await watch.apply(catalog([srcAnn('iso', { cadence: 60 }), predAnn(A, { pubkey: SRC_PUB, stream: 'iso' }, { at: 2, cadence: 60 })]));
    for (const timestamp of ['2026-10-20T00:00:00Z', null, 'soon', 5]) { // 5: 1970, outside 2000–2100
      expect(await take(signEvent(observationEvent({ stream: 'iso', value: '1', seq: 1, timestamp, now: clock }), SRC))).toBe(false);
    }
    expect((await db.watchObservations([relayUuid(SRC_PUB, 'iso')])).get(relayUuid(SRC_PUB, 'iso'))).toEqual([]);
    expect(changes).toBe(0);
  });

  test('intake: a timestamp more than max(cadence, 300 s) ahead of its arrival is not kept', async () => {
    await watch.apply(catalog([srcAnn('btc', { cadence: 60 }), predAnn(A, btc, { at: 2, cadence: 3600 })]));
    expect(await take(obsEvent(SRC, 'btc', '1', 1, clock + 301))).toBe(false); // cadence 60: 300 s is the limit
    expect(await take(obsEvent(SRC, 'btc', '1', 2, clock + 299))).toBe(true);
    expect(await take(obsEvent(A, 'btc_pred', '1', 1, clock + 3601))).toBe(false); // cadence 1 h: an hour is the limit
    expect(await take(obsEvent(A, 'btc_pred', '1', 2, clock + 3500))).toBe(true);
    expect(await take(obsEvent(SRC, 'btc', '1', 3, 4_000_000_000))).toBe(false); // 2096
  });

  test('prune: a far-future observation (stored before the guard) neither wipes the history nor stays', async () => {
    await watch.apply(catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 })]));
    const t0 = clock - 900 * 40;
    for (let k = 0; k < 40; k++) {
      clock = t0 + 900 * k;
      await take(obsEvent(SRC, 'btc', String(100 + (k % 3)), k + 1, clock));
      clock += 5;
      await take(obsEvent(A, 'btc_pred', String(100 + ((k + 1) % 3)), k + 1, clock - 1));
    }
    const before = (await watch.list())[0];
    expect(before).toMatchObject({ scored: 28, markText: '100% better' });
    await db.addWatchObservation({ stream_uuid: relayUuid(SRC_PUB, 'btc'), seq: 41, ts: 4_000_000_000, value: 1, received_at: clock, event_id: 'f' });
    expect(await watch.prune()).toBe(1);
    expect((await db.watchObservations([relayUuid(SRC_PUB, 'btc')])).get(relayUuid(SRC_PUB, 'btc'))).toHaveLength(40);
  });

  test('an observation arriving while apply() drops its stream is not kept after the drop', async () => {
    await watch.apply(catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 })]));
    const uuid = relayUuid(A_PUB, 'btc_pred');
    const retain = db.retainWatch;
    let late;
    db.retainWatch = (...args) => {
      const p = retain(...args);
      late = take(obsEvent(A, 'btc_pred', '5', 1, clock - 10)); // its insert queued right after the drop, while the stream still shows as watched
      return p;
    };
    await watch.apply(catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 })]), { gone: new Set([`${A_PUB}:btc_pred`]) });
    expect(await late).toBe(false);
    expect((await db.watchObservations([uuid])).get(uuid)).toEqual([]);
  });

  test('records read only the last 60 observations of each stream; a scan or a Discover with nothing new reads nothing again', async () => {
    const cat = catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 })]);
    await watch.apply(cat);
    const spy = vi.spyOn(db, 'watchObservations');
    await watch.list();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ last: RECORD_READ });
    expect(RECORD_READ).toBe(60);
    clock += WATCH_SCAN_S;
    await watch.apply(cat); // the next scan: the same set
    await watch.list();
    expect(spy).toHaveBeenCalledTimes(1);
    await watch.apply(catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 }), predAnn(B, btc, { at: 3 })])); // a newcomer
    await watch.list();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0].sort()).toEqual([relayUuid(B_PUB, 'btc_pred'), relayUuid(SRC_PUB, 'btc')].sort()); // only it and its source
    // received: every prediction held, though only the last 60 are read
    await conn().query(`INSERT INTO watch_observations SELECT '${relayUuid(A_PUB, 'btc_pred')}', k + 1, ${clock} - 900 * (100 - k), 1, ${clock}, 'x' || k FROM range(100) t(k)`);
    await take(obsEvent(A, 'btc_pred', '1', 500, clock - 5));
    expect((await watch.one(A_PUB, 'btc_pred')).received).toBe(101);
  });

  test('load: the watched set read back from the db (a reload)', async () => {
    await watch.apply(catalog([srcAnn('btc'), predAnn(A, btc, { at: 2 })]));
    const again = createWatch({ db, me: ME_PUB, now });
    expect(again.count()).toEqual({ streams: 0, sources: 0 });
    await again.load();
    expect(again.count()).toEqual({ streams: 1, sources: 1 });
    expect((await again.list()).map((r) => r.mark)).toEqual([null]);
  });
});
