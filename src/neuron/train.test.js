// The training pass (docs/design/models.md#the-training-pass): on load, after a poll and whenever a model became unscored
// or stale, every model the neuron runs gets a current fit (its backtest against no change, its inputs' influence),
// from stored history only. Exactly the models that lack one; never a prediction, never central; resumable.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb } from '../../test/memory-db.js';
import { runModels } from '../engine/evolve.js';
import { explainForecast, STEP_S } from '../engine/index.js';
import { UP } from '../chain/index.js';
import { fitKey, statsOf, lacking, trainPass, createTrainer } from './train.js';
import { createWork } from './work.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // DuckDB's wasm starts in the first beforeEach

const T0 = Date.UTC(2026, 8, 1) / 1000;
const ID = '02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a';
const NAMES = ['gold', 'lead', 'n1', 'n2'];

function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
}
/** 120 buckets of 12 h per stream: 'gold' follows 'lead'; the rest are noise. */
function market(n = 120) {
  const normal = rng(7);
  const out = Object.fromEntries(NAMES.map((k) => [k, [100]]));
  let lead = 0;
  for (let k = 1; k < n; k++) {
    const r = Object.fromEntries(NAMES.map((name) => [name, 0.02 * normal()]));
    r.gold = 0.6 * lead + 0.01 * normal();
    lead = r.lead;
    for (const name of NAMES) out[name].push(out[name].at(-1) * (1 + r[name]));
  }
  return out;
}
const PRICES = market();
const pointsOf = (name, upTo = 120) => PRICES[name].slice(0, upTo).map((value, k) => ({ ts: T0 + (k + 1) * STEP_S - 1, value }));

let db;
beforeEach(async () => { db = await memoryDb(); });

/**
 * A neuron as a poll left it, `upTo` buckets in: every stream stored, specs from runModels with their scores, a
 * prediction each. `old`: the specs as a version before the training pass stored them (no persist, no influence, no key).
 */
async function neuron({ upTo = 120, old = false } = {}) {
  const histories = new Map(NAMES.map((n) => [`u-${n}`, pointsOf(n, upTo)]));
  await db.addObservations(NAMES.flatMap((n) => histories.get(`u-${n}`).map((p) => ({ stream_uuid: `u-${n}`, name: n, meta: null, ...p }))));
  const { forecasts, specs } = runModels({ fresh: [...histories.keys()], histories, seed: ID });
  const stats = statsOf(await db.streams());
  await db.saveSpecs(new Map([...specs].map(([u, row]) => [u, { ...row,
    ...(old ? { persist: null, influence: null } : { fit_key: fitKey(u, row.spec, stats) }) }])), T0);
  await db.addPredictions([...forecasts].map(([u, f]) => ({ stream_uuid: u, made_at: T0 + 1, model: f.model, t1: f.t1, t2: f.t2,
    phi: f.phi, weight: f.weight, observed_at: String(T0 + 1), hash: 'h', obs_ts: histories.get(u).at(-1).ts })));
  return { histories, specs, forecasts };
}

describe('fitKey: the data a fit was computed on', () => {
  test('the spec\'s λs and each input\'s row count and newest time; any change, another key', () => {
    const stat = (u) => ({ 'u-a': { n: 10, last: 500 }, 'u-b': { n: 4, last: 300 } }[u] ?? null);
    const spec = { companions: ['u-b'], lambda1: 0.2, lambda2: 0.5 };
    const k = fitKey('u-a', spec, stat);
    expect(fitKey('u-a', { ...spec }, stat)).toBe(k);
    expect(fitKey('u-a', { ...spec, lambda1: 0.1 }, stat)).not.toBe(k); // a new spec
    expect(fitKey('u-a', { ...spec, companions: ['u-c'] }, stat)).not.toBe(k); // a changed companion
    expect(fitKey('u-a', spec, (u) => (u === 'u-b' ? { n: 5, last: 360 } : stat(u)))).not.toBe(k); // the companion's new row
    expect(fitKey('u-a', spec, (u) => (u === 'u-a' ? { n: 11, last: 400 } : stat(u)))).not.toBe(k); // older history added
    expect(statsOf([{ uuid: 'u-a', observations: 10, obs_ts: 500 }, { uuid: 'u-z', observations: 0, obs_ts: null }])('u-a')).toEqual({ n: 10, last: 500 });
  });
});

describe('lacking: exactly the models without a current fit', () => {
  test('central: a spec never scored by key (stored before), or stale (new history, a companion\'s new row); not the current ones', async () => {
    const { specs } = await neuron();
    let rows = await db.streams();
    expect(lacking({ streams: rows }).total).toBe(0); // as the poll left them: current
    // a spec stored before the key: lacking; a companion's new row: its readers are stale; the rest are current
    const gold = specs.get('u-gold').spec;
    await db.saveFits([{ uuid: 'u-n1', spec: JSON.stringify(specs.get('u-n1').spec), score: 1, persist: 1, influence: null, fit_key: null }], T0);
    const c = gold.companions[0];
    await db.addObservations([{ stream_uuid: c, name: c.slice(2), meta: null, ts: T0 + 500 * STEP_S, value: 101 }]);
    rows = await db.streams();
    const readers = [...specs].filter(([u, r]) => u === c || r.spec.companions.includes(c)).map(([u]) => u);
    expect(lacking({ streams: rows }).central.map((x) => x.uuid).sort()).toEqual([...new Set(['u-n1', ...readers])].sort());
    // tried this session with the same data: not again (a fit that could not be kept never loops)
    const tried = new Set(lacking({ streams: rows }).central.map((x) => x.id));
    expect(lacking({ streams: rows, tried }).total).toBe(0);
    // a stream with no forecast is no model yet: nothing to train
    await db.addObservations([{ stream_uuid: 'u-new', name: 'new', meta: null, ts: T0, value: 1 }]);
    expect(lacking({ streams: await db.streams(), tried }).total).toBe(0);
  });

  test('Nostr: a `_pred` with no backtest kept (naive and echo have none to keep); Base: a game from a batch before backtests were kept', () => {
    const p = (seq, model, tests) => ({ seq, model, tests, score: null, persist: null });
    const subs = [{ uuid: 'n-1', cadence_seconds: 3600, prediction: p(4, 'bar1', null) }, { uuid: 'n-2', prediction: p(1, 'bar1', 12) },
      { uuid: 'n-3', prediction: p(2, 'naive', null) }, { uuid: 'n-4', prediction: p(2, 'echo', null) }, { uuid: 'n-5', prediction: null }];
    const game = (streamId, model, kept) => ({ streamId, gameId: streamId, model, direction: UP, horizon: 86_400, step: 43_200,
      ...(kept ? { score: 1, persist: 1, tests: 9 } : {}) });
    const lastBatch = { round: 9, hash: '0xb', games: [game(1, 'bar1', false), game(2, 'bar1', true), game(3, 'naive', false)],
      dropped: [game(4, 'bar1d', false), { streamId: 5, error: 'no history' }] };
    const todo = lacking({ subscriptions: subs, lastBatch });
    expect(todo.nostr.map((x) => x.uuid)).toEqual(['n-1']);
    expect(todo.base.map((x) => x.game.streamId)).toEqual([1, 4]);
    expect(todo.total).toBe(3);
    expect(lacking({ subscriptions: subs, lastBatch, baseFits: new Map([[todo.base[0].id, { score: 1 }]]) }).base).toHaveLength(1);
  });
});

describe('trainPass: fits what lacks one, from stored history only', () => {
  test('specs stored before the key: each scored as the poll would (score, no change\'s, influence); never a prediction, the specs untouched', async () => {
    const { specs } = await neuron({ old: true });
    const before = await db.specs();
    const preds = await db.predictions('gold', 99);
    const spy = vi.spyOn(db, 'addPredictions');
    const steps = [];
    const r = await trainPass({ db, streams: await db.streams(), now: () => T0 + 99, report: (...a) => steps.push(a) });
    expect(r).toMatchObject({ central: 4, nostr: 0, base: 0, stopped: false, ms: expect.any(Number) });
    expect(steps).toEqual([['score', 0, 4], ['score', 1, 4], ['score', 2, 4], ['score', 3, 4], ['score', 4, 4]]);
    const after = await db.specs();
    for (const [u, row] of specs) {
      expect(after.get(u)).toEqual({ ...before.get(u), score: row.score, persist: row.persist, influence: row.influence,
        fit_key: expect.any(String), updated_at: T0 + 99 }); // the poll's numbers on the same data; the spec as it was
    }
    expect(after.get('u-gold').influence).not.toBeNull(); // bvar: its inputs' shares
    expect(spy).not.toHaveBeenCalled();
    expect(await db.predictions('gold', 99)).toEqual(preds);
    expect(await db.pendingCount()).toBe(4); // the poll's, unsent: the pass sends nothing
    expect(lacking({ streams: await db.streams() }).total).toBe(0);
    // again: nothing to do, nothing reported
    steps.length = 0;
    expect(await trainPass({ db, streams: await db.streams(), report: (...a) => steps.push(a) })).toMatchObject({ central: 0 });
    expect(steps).toEqual([]);
  });

  test('stopped (a poll began) between models: what was fit is kept, the next pass does the rest (resumable, no queue kept)', async () => {
    await neuron({ old: true });
    let n = 0;
    const r = await trainPass({ db, streams: await db.streams(), report: () => { n++; }, stop: () => n >= 3 });
    expect(r).toMatchObject({ central: 2, stopped: true });
    const rest = lacking({ streams: await db.streams() });
    expect(rest.central).toHaveLength(2);
    expect((await trainPass({ db, streams: await db.streams() })).central).toBe(2);
    expect(lacking({ streams: await db.streams() }).total).toBe(0);
  });

  test('a poll that evolved a spec meanwhile wins: the pass never writes back an older spec\'s fit', async () => {
    const { specs } = await neuron({ old: true });
    const streams = await db.streams();
    const evolved = { ...specs.get('u-gold').spec, lambda1: 0.05 };
    await db.saveSpecs(new Map([['u-gold', { ...specs.get('u-gold'), spec: evolved, score: 0.5, fit_key: 'poll' }]]), T0 + 50);
    await trainPass({ db, streams }); // read before the poll's write
    expect((await db.specs()).get('u-gold')).toMatchObject({ spec: evolved, score: 0.5, fit_key: 'poll' });
  });

  test('Nostr: a `_pred` kept before its backtest gets it from the stored history; Base: from the chain\'s, kept in memory', async () => {
    await db.subscribeRelay({ uuid: 'n-1', stream_name: 'rain', provider_pubkey: 'p', name: 'Rain', cadence_seconds: 3600, now: 1 });
    const pts = pointsOf('n2', 60).map((p, i) => ({ ts: T0 + i * 3600, value: p.value }));
    for (const [i, p] of pts.entries()) {
      await db.addRelayObservation({ stream_uuid: 'n-1', seq: i + 1, ts: p.ts, value: p.value, raw: String(p.value), event_id: `e${i}`, received_at: p.ts });
    }
    await db.addRelayPrediction({ stream_uuid: 'n-1', seq: 1, value: '1', model: 'bar1', obs_seq: 60, made_at: T0, event_id: 'p1', relays: 1 });
    const sub = { uuid: 'n-1', cadence_seconds: 3600, prediction: { seq: 1, model: 'bar1', tests: null } };
    const batch = { round: 9, at: T0, hash: '0xb', dropped: [], games: [{ streamId: 3, gameId: 13, model: 'bar1', direction: UP, latest: '1',
      forecast: '2', horizon: 86_400, step: 43_200 }] };
    const hist = pointsOf('n1');
    const baseFits = new Map();
    const baseHistory = vi.fn(async () => hist);
    const r = await trainPass({ db, subscriptions: [sub], lastBatch: batch, baseHistory, baseFits });
    expect(r).toMatchObject({ central: 0, nostr: 1, base: 1 });
    const x = explainForecast(pts, { step: 3600, horizon: 3600 });
    expect(await db.relayStream('n-1')).toMatchObject({ p_score: x.score, p_persist: x.persist, p_tests: x.tests });
    const y = explainForecast(hist, { step: 43_200, horizon: 86_400 });
    expect(baseFits.get('0xb:3')).toEqual({ score: y.score, persist: y.persist, tests: y.tests });
    // the chain down: not scored, and not asked again this session
    const down = new Map();
    await trainPass({ db, lastBatch: batch, baseHistory: async () => { throw new Error('rpc down'); }, baseFits: down });
    expect(down.get('0xb:3')).toMatchObject({ score: null, tests: null, error: 'rpc down' });
    expect(lacking({ lastBatch: batch, baseFits: down }).total).toBe(0);
  });
});

describe('createTrainer: when it runs, and what Home shows', () => {
  test('central\'s work in progress (a poll, its sign-in, the history): it waits, the poll\'s end runs it; nothing lacking: no work shown', async () => {
    await neuron({ old: true });
    const onChange = vi.fn();
    const work = createWork({ onChange });
    const t = createTrainer({ db, work, read: async () => ({ streams: await db.streams() }) });
    const poll = work.start('central');
    poll.step('observations');
    onChange.mockClear();
    expect(await t.run()).toBeNull(); // waits for the poll
    expect(onChange).not.toHaveBeenCalled();
    poll.end();
    expect((await t.run()).central).toBe(4);
    onChange.mockClear();
    expect(await t.run()).toBeNull(); // nothing lacking: nothing shown
    expect(onChange).not.toHaveBeenCalled();
  });

  test('work: "Scoring models · k of n" while it runs (regular, not critical), refreshed before it ends, then nothing', async () => {
    await neuron({ old: true });
    const seen = [];
    const work = createWork({ onChange: () => seen.push(work.of('train') && `${work.of('train').step} ${work.of('train').done}/${work.of('train').total}`) });
    const after = vi.fn(async () => { seen.push(`after:${work.of('train') ? 'held' : 'ended'}`); });
    const t = createTrainer({ db, work, read: async () => ({ streams: await db.streams() }), after });
    const r = await t.run();
    expect(r.central).toBe(4);
    expect(seen).toEqual(['score 0/4', 'score 1/4', 'score 2/4', 'score 3/4', 'score 4/4', 'after:held', null]);
    expect(t.last).toBe(r);
    expect(await t.run()).toBeNull(); // done: nothing left
  });
});
