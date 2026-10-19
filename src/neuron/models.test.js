// The Models tab's data (docs/design/models.md): quality against no change, the list from what the app holds, the
// engine's status, sort and filter, and one model's drill-in recomputed from the stored history and spec.
import { describe, expect, test } from 'vitest';
import {
  qualityOf, qualityOfAll, centralModels, nostrModels, baseModels, modelsOf, summaryOf, sortModels, filterModels, toggleDest, DESTS, engineStatus,
  modelDetail, TIE,
} from './models.js';
import { runModels } from '../engine/evolve.js';
import { explainForecast, STEP_S } from '../engine/index.js';
import { UP, DOWN } from '../chain/index.js';

const T0 = Date.UTC(2026, 8, 1) / 1000;
const grid = (values, start = 0, step = STEP_S) => values.map((value, k) => ({ ts: T0 + (start + k + 1) * step - 1, value }));
const ID = '02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a';

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
/** 'gold' follows 0.6 × lead's last 12 h return; the rest are noise. */
function market(n, names, seed) {
  const normal = rng(seed);
  const out = Object.fromEntries(names.map((k) => [k, [100]]));
  let lead = 0;
  for (let k = 1; k < n; k++) {
    const r = Object.fromEntries(names.map((name) => [name, 0.02 * normal()]));
    r.gold = 0.6 * lead + 0.01 * normal();
    lead = r.lead;
    for (const name of names) out[name].push(out[name].at(-1) * (1 + r[name]));
  }
  return out;
}

describe('quality: the model\'s backtest error against no change\'s, on the same origins', () => {
  test(`better below ${(1 - TIE) * 100} % of no change's error, worse above ${(1 + TIE) * 100} %, else a tie`, () => {
    expect(TIE).toBe(0.05); // evolution's margin
    expect(qualityOf({ kind: 'bvar', score: 0.009, persist: 0.01 })).toEqual({ mark: 'better', ratio: expect.closeTo(0.9, 12), error: 0.009, noChange: 0.01,
      text: '10% better' });
    expect(qualityOf({ kind: 'bvar', score: 0.0112, persist: 0.01 }).text).toBe('12% worse');
    expect(qualityOf({ kind: 'bvar', score: 0.0104, persist: 0.01 }).text).toBe('Same as no change');
    expect(qualityOf({ kind: 'bar1', score: 0.0094, persist: 0.01 }).mark).toBe('better');
    expect(qualityOf({ kind: 'bar1', score: 0.0096, persist: 0.01 }).mark).toBe('tie');
    expect(qualityOf({ kind: 'bvar', score: 0.0104, persist: 0.01 }).mark).toBe('tie');
    expect(qualityOf({ kind: 'bvar', score: 0.0106, persist: 0.01 }).mark).toBe('worse');
    expect(qualityOf({ kind: 'bar1d', score: 3, persist: 2 })).toMatchObject({ mark: 'worse', ratio: 1.5 });
  });

  test('naive is no change: a tie by construction; no backtest yet: not scored; a perfect no change', () => {
    expect(qualityOf({ kind: 'naive', score: null, persist: null })).toEqual({ mark: 'tie', ratio: 1, error: null, noChange: null, text: 'Same as no change' });
    expect(qualityOf({ kind: 'bvar', score: null, persist: null })).toEqual({ mark: null, ratio: null, error: null, noChange: null, text: 'Not scored yet' });
    expect(qualityOf({ kind: 'echo' }).mark).toBeNull();
    expect(qualityOf({ kind: 'bar1', score: 0, persist: 0 })).toMatchObject({ mark: 'tie', ratio: 1 });
    expect(qualityOf({ kind: 'bar1', score: 0.1, persist: 0 })).toMatchObject({ mark: 'worse', ratio: null });
  });

  test('a model with several outputs: the median of their ratios', () => {
    const q = (score) => qualityOf({ kind: 'bvar', score, persist: 1 });
    expect(qualityOfAll([q(0.9)])).toEqual(q(0.9));
    expect(qualityOfAll([q(0.8), q(0.9), q(1.2)])).toMatchObject({ mark: 'better', ratio: expect.closeTo(0.9, 12) });
    expect(qualityOfAll([q(null), q(null)])).toMatchObject({ mark: null, text: 'Not scored yet' });
    expect(qualityOfAll([q(0.8), q(0.9), q(1.2)]).text).toBe('10% better');
  });
});

const ROWS = [
  { uuid: 'u-gold', name: 'gold', model: 'bvar', obs_value: 2600, obs_ts: 5000, t1: 2610, t2: 2620, phi: 0.1, weight: 1, made_at: 5010,
    status: 'sent', sent_at: 5020, spec: JSON.stringify({ companions: ['u-eth', 'u-oil'], lambda1: 0.2, lambda2: 0.5 }), score: 0.009,
    persist: 0.01, influence: JSON.stringify([0.2, 0.1, 0.7]), generation: 4, accepted: 1 },
  { uuid: 'u-eth', name: 'eth', model: 'bar1', obs_value: 3000, obs_ts: 5000, t1: 2990, t2: 2980, phi: -0.1, weight: 0.5, made_at: 5010,
    status: 'pending', sent_at: null, spec: JSON.stringify({ companions: ['u-gold'], lambda1: 0.1, lambda2: 1 }), score: 0.03,
    persist: 0.02, influence: null, generation: 0, accepted: 0 },
  { uuid: 'u-oil', name: 'oil', model: 'naive', obs_value: 70, obs_ts: 4000, t1: 70, t2: 70, made_at: 5010, status: 'sent', sent_at: 5020,
    spec: JSON.stringify({ companions: ['u-x'], lambda1: 0.1, lambda2: 1 }), score: null, persist: null, influence: null, generation: 0, accepted: 0 },
  { uuid: 'u-new', name: 'new', model: null, spec: null },
];

describe('the list: every model, named for the stream it predicts', () => {
  test('central: the inputs ranked by influence, quality, the forecast and where it went; the old fields for agents', () => {
    const [gold, eth, oil] = centralModels(ROWS);
    expect(centralModels(ROWS)).toHaveLength(3); // a stream with no forecast yet is no model yet
    expect(gold).toMatchObject({
      id: 'central:u-gold', source: 'central', name: 'gold', kind: 'bvar', trained: 5010,
      // what it is and how it works, in plain words; `algorithms` a list (one today; an ensemble would list several)
      algorithms: ['bvar'], kindLabel: 'Bayesian VAR · reads 3 streams',
      description: 'Learns how this stream moves together with eth and oil, then predicts 24 h ahead.',
      quality: { mark: 'better' },
      inputs: [{ stream: 'u-gold', name: 'gold' }, { stream: 'u-eth', name: 'eth' }, { stream: 'u-oil', name: 'oil' }],
      // as before
      uuid: 'u-gold', model: 'bvar', score: 0.009, generation: 4, accepted: 1,
      spec: { companions: [{ uuid: 'u-eth', name: 'eth' }, { uuid: 'u-oil', name: 'oil' }], lambda1: 0.2, lambda2: 0.5 },
    });
    expect(gold.outputs).toEqual([{
      stream: 'u-gold', name: 'gold', latest: { value: 2600, ts: 5000 },
      forecast: { t1: 2610, t2: 2620, value: 2620, step: STEP_S, horizon: 2 * STEP_S, at: 5010 }, direction: 'up',
      influence: [{ stream: 'u-oil', name: 'oil', share: 0.7 }, { stream: 'u-gold', name: 'gold', share: 0.2 }, { stream: 'u-eth', name: 'eth', share: 0.1 }],
      quality: gold.quality,
      destinations: [{ to: 'network', status: 'accepted', when: 5020, ref: null }],
    }]);
    // bar1 reads the stream alone (its spec waits for aligned rows): all its own
    expect(eth).toMatchObject({ kind: 'bar1', quality: { mark: 'worse', ratio: 1.5 }, inputs: [{ stream: 'u-eth', name: 'eth' }] });
    expect(eth.outputs[0]).toMatchObject({ direction: 'down', influence: [{ stream: 'u-eth', share: 1 }],
      destinations: [{ to: 'network', status: 'pending', when: 5010 }] });
    expect(oil).toMatchObject({ kind: 'naive', quality: { mark: 'tie' }, outputs: [{ direction: 'flat' }],
      kindLabel: 'No change · not enough history yet', description: 'Repeats the latest value until it has 4 days of back-to-back history.' });
    expect(eth).toMatchObject({ kindLabel: 'Single-stream AR (bar1)' });
    // trained: when it was last fit, the poll's forecast or the training pass after it
    expect(centralModels([{ ...ROWS[0], spec_at: 9000 }])[0].trained).toBe(9000);
    expect(centralModels([{ ...ROWS[0], spec_at: 4000 }])[0].trained).toBe(5010);
    // a bvar spec stored before its influence was kept (migration 11): its shares unknown, its inputs still listed
    const old = centralModels([{ ...ROWS[0], influence: null, persist: null }, ...ROWS.slice(1)])[0];
    expect(old.quality.mark).toBeNull();
    expect(old.outputs[0].influence.map((x) => [x.name, x.share])).toEqual([['gold', null], ['eth', null], ['oil', null]]);
  });

  test('Nostr: each subscription\'s `_pred`, a cadence ahead, published to the network', () => {
    const subs = [
      { uuid: 'n-1', stream: 'btc', provider: 'p', name: 'Bitcoin', cadence_seconds: 3600, observation: { seq: 9, ts: 7000, value: 100 },
        prediction: { stream: 'btc_pred', seq: 4, value: '101.5', model: 'bar1', made_at: 7001, relays: 2, score: 0.01, persist: 0.02, tests: 9 } },
      { uuid: 'n-2', stream: 'words', provider: 'p', name: '', cadence_seconds: null, observation: { seq: 1, ts: 7000, value: null },
        prediction: { stream: 'words_pred', seq: 1, value: 'hello', model: 'echo', made_at: 7002, relays: 0 } },
      { uuid: 'n-3', stream: 'quiet', provider: 'p', name: 'Quiet', cadence_seconds: 60, observation: null, prediction: null },
    ];
    const [btc, words] = nostrModels(subs); // the backtest kept with its `_pred`
    expect(nostrModels(subs)).toHaveLength(2); // nothing predicted yet: no model yet
    expect(btc).toMatchObject({ id: 'nostr:n-1', source: 'nostr', name: 'Bitcoin', kind: 'bar1', trained: 7001,
      quality: { mark: 'better', ratio: 0.5 }, inputs: [{ stream: 'n-1', name: 'Bitcoin' }] });
    expect(btc.outputs).toEqual([{ stream: 'n-1', name: 'Bitcoin', as: 'btc_pred', latest: { value: 100, ts: 7000 },
      forecast: { value: 101.5, step: 3600, horizon: 3600, at: 7001 }, direction: 'up', quality: btc.quality,
      influence: [{ stream: 'n-1', name: 'Bitcoin', share: 1 }],
      destinations: [{ to: 'relays', status: 'published', when: 7001, ref: { stream: 'btc_pred', seq: 4, relays: 2 } }] }]);
    expect(words).toMatchObject({ name: 'words', kind: 'echo', quality: { mark: null },
      outputs: [{ forecast: { value: null, horizon: 86_400 }, direction: null, destinations: [{ status: 'waiting' }] }] });
  });

  test('Base: the last batch\'s games (and those left out), each stream\'s forecast at its horizon', () => {
    const batch = { round: 20743, at: 9000, hash: '0xabc', games: [
      { streamId: 1, gameId: 1, named: false, direction: DOWN, model: 'naive', latest: '5', forecast: '5', horizon: 86_400, step: 86_400 },
      { streamId: 3, gameId: 13, named: true, direction: UP, model: 'bar1d', latest: '-2', forecast: '4', horizon: 86_400, step: 43_200,
        score: 1, persist: 2 }],
    dropped: [{ streamId: 4, gameId: 14, named: false, error: 'no history' },
      { streamId: 5, gameId: 15, named: true, direction: UP, model: 'bar1', latest: '1', forecast: '2', horizon: 86_400, step: 43_200,
        error: 'DuplicatePrediction' }] };
    const list = baseModels(batch);
    expect(list.map((m) => [m.id, m.name, m.kind, m.quality.mark])).toEqual([
      ['base:1', 'Stream 1', 'naive', 'tie'], ['base:3', 'Named stream 3', 'bar1d', 'better'], ['base:5', 'Named stream 5', 'bar1', null]]);
    expect(list[1].outputs[0]).toMatchObject({ latest: { value: -2, ts: null }, forecast: { value: 4, step: 43_200, horizon: 86_400, at: 9000 },
      direction: 'up', destinations: [{ to: 'contract', status: 'sent', when: 9000, ref: { round: 20743, game: 13, direction: 'up', tx: '0xabc' } }] });
    expect(list[0].outputs[0].direction).toBe('down'); // a tie is DOWN, as sent
    expect(list[2].outputs[0].destinations[0]).toMatchObject({ status: 'left out', ref: { tx: null, error: 'DuplicatePrediction' } });
    expect(baseModels(null)).toEqual([]);
    // a game from a batch before backtests were kept: the training pass's fit (in memory, by `<hash>:<stream id>`)
    expect(baseModels(batch, new Map([['0xabc:5', { score: 0.5, persist: 1, tests: 9 }]]))[2].quality).toMatchObject({ mark: 'better', ratio: 0.5 });
  });

  test('modelsOf: central, then Base, then Nostr; summaryOf: by kind, by mark, the median against no change', () => {
    const list = modelsOf({ streams: ROWS, subscriptions: [], lastBatch: null });
    expect(list.map((m) => m.id)).toEqual(['central:u-gold', 'central:u-eth', 'central:u-oil']);
    expect(summaryOf(list)).toEqual({ total: 3, kinds: { bvar: 1, bar1: 1, naive: 1 }, marks: { better: 1, tie: 1, worse: 1, unscored: 0 },
      median: expect.closeTo((0.9 + 1.5) / 2, 12), scored: 2, trained: 5010 });
    expect(summaryOf([])).toMatchObject({ total: 0, median: null, trained: null });
  });

  test('sort by quality (best first, not scored last) or by name; filter by where predictions go', () => {
    const list = modelsOf({ streams: ROWS, subscriptions: [], lastBatch: { round: 1, at: 1, hash: '0x1', dropped: [],
      games: [{ streamId: 2, gameId: 2, named: false, direction: UP, model: 'bar1', latest: '1', forecast: '2', horizon: 86_400, step: 43_200 }] } });
    expect(sortModels(list, 'quality').map((m) => m.name)).toEqual(['gold', 'oil', 'eth', 'Stream 2']);
    expect(sortModels(list, 'name').map((m) => m.name)).toEqual(['eth', 'gold', 'oil', 'Stream 2']);
    // by the words people see: the Satori Network, the Satori contract, the Satori relays; independent toggles, a model
    // shown when it goes to any one selected
    expect(DESTS).toEqual(['network', 'contract', 'relays']);
    expect(filterModels(list, ['contract']).map((m) => m.name)).toEqual(['Stream 2']);
    expect(filterModels(list, ['network'])).toHaveLength(3);
    expect(filterModels(list, ['relays'])).toEqual([]);
    expect(filterModels(list, ['network', 'contract'])).toHaveLength(4);
    expect(filterModels(list, ['relays', 'contract']).map((m) => m.name)).toEqual(['Stream 2']);
    expect(filterModels(list, DESTS)).toEqual(list);
  });

  test('toggleDest: a tap turns one destination off or on again; the last one on stays on (never an empty list by filters)', () => {
    expect(toggleDest(DESTS, 'network')).toEqual(['contract', 'relays']);
    expect(toggleDest(['contract', 'relays'], 'network')).toEqual(DESTS); // in the tab's order
    expect(toggleDest(['relays'], 'contract')).toEqual(['contract', 'relays']);
    expect(toggleDest(['relays'], 'relays')).toEqual(['relays']); // the last: nothing happens
    expect(toggleDest(['relays'], 'nope')).toEqual(['relays']);
  });
});

describe('the engine\'s status: working, resting, or needs a look', () => {
  const summary = summaryOf(centralModels(ROWS));
  test('working: the poll\'s step, the same words as Home\'s hero; resting: when it last trained and when it runs next', () => {
    expect(engineStatus({ summary, central: { nextPoll: 5010 + 9 * 3600 }, work: { line: 'Building models · 40 of 82', critical: false }, now: 5100 }))
      .toEqual({ tone: 'working', title: 'Working', line: 'Building models · 40 of 82' });
    expect(engineStatus({ summary, central: {}, work: { line: 'Keep Satori open · Sending 82 predictions…', critical: true }, now: 5100 }).tone).toBe('critical');
    expect(engineStatus({ summary, central: { nextPoll: 5010 + 11 * 3600, lastPoll: { at: 5000 } }, work: null, now: 5010 + 2 * 3600 }))
      .toEqual({ tone: 'idle', title: 'Resting', line: 'Trained 2 h ago · next run in 9 h' });
    expect(engineStatus({ summary: summaryOf([]), central: { nextPoll: 100 }, work: null, now: 50 }))
      .toEqual({ tone: 'idle', title: 'No models yet', line: 'The first poll builds them · in 1 min' });
  });
  test('amber only when the engine itself failed (the last run\'s local error); central\'s own errors are Home\'s', () => {
    expect(engineStatus({ summary, central: { lastPoll: { at: 1, error: 'out of memory', local: true } }, work: null, now: 2 }))
      .toEqual({ tone: 'warn', title: 'Needs a look', line: 'The last run failed: out of memory' });
    expect(engineStatus({ summary, central: { nextPoll: 9000, lastPoll: { at: 1, error: 'central 500' } }, work: null, now: 5010 }).tone).toBe('idle');
  });
});

describe('modelDetail: one model, recomputed from the stored history and spec', () => {
  const names = ['gold', 'lead', 'n1', 'n2'];
  const prices = market(200, names, 5);
  const histories = new Map(names.map((k) => [`u-${k}`, grid(prices[k])]));
  const db = { histories: async (us) => new Map(us.map((u) => [u, histories.get(u) ?? []])),
    relayHistory: async (u) => (u === 'n-1' ? grid(prices.n1, 0, 3600) : []) };

  test('central bvar: In ranked by its fit, the Model, Out as a list with each output\'s recent history and destinations', async () => {
    const { forecasts, specs } = runModels({ fresh: ['u-gold'], histories, seed: ID, specs: new Map([['u-gold',
      { spec: { companions: ['u-n1', 'u-lead'], lambda1: 0.5, lambda2: 1 }, generation: 2, accepted: 1 }]]) });
    const f = forecasts.get('u-gold');
    const row = specs.get('u-gold');
    const last = histories.get('u-gold').at(-1);
    const rows = [{ uuid: 'u-gold', name: 'gold', model: f.model, obs_value: last.value, obs_ts: last.ts, t1: f.t1, t2: f.t2, phi: f.phi,
      weight: f.weight, made_at: last.ts + 60, status: 'sent', sent_at: last.ts + 70, spec: JSON.stringify(row.spec), score: row.score,
      persist: row.persist, influence: JSON.stringify(row.influence), generation: row.generation, accepted: row.accepted },
    ...['lead', 'n1', 'n2'].map((n) => ({ uuid: `u-${n}`, name: n, model: 'bar1' }))];
    const d = await modelDetail({ db, id: 'central:u-gold', streams: rows });
    expect(d).toMatchObject({ id: 'central:u-gold', source: 'central', name: 'gold', kind: 'bvar',
      inputs: [{ stream: 'u-gold', name: 'gold' }, ...row.spec.companions.map((u) => ({ stream: u, name: u.slice(2) }))],
      model: { kind: 'bvar', lambda1: row.spec.lambda1, lambda2: row.spec.lambda2, generation: row.generation, accepted: row.accepted,
        rows: f.rows, tests: 28, step: STEP_S, horizon: 2 * STEP_S, weight: f.weight, trained: last.ts + 60,
        quality: { error: row.score, noChange: row.persist } } });
    expect(d.model.coef).toHaveLength(3);
    expect(d.outputs).toHaveLength(1);
    const [out] = d.outputs;
    expect(out.influence[0].name).toBe('lead'); // it leads gold
    expect(out.influence.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 12);
    expect(out.influence.map((x) => x.share)).toEqual([...out.influence.map((x) => x.share)].sort((a, b) => b - a));
    expect(out).toMatchObject({ stream: 'u-gold', forecast: { t1: f.t1, t2: f.t2, value: f.t2 }, destinations: [{ to: 'network', status: 'accepted' }] });
    // the chart: the last 7 horizons of history before the forecast was made, oldest first
    expect(out.history.at(-1)).toEqual(last);
    expect(out.history[0].ts).toBeGreaterThanOrEqual(last.ts + 60 - 7 * 2 * STEP_S);
    expect(out.history).toHaveLength(14);
    expect(d.ms).toEqual(expect.any(Number));
    expect(d.readMs).toBeLessThanOrEqual(d.ms);
    // by name or bare uuid too
    expect((await modelDetail({ db, id: 'gold', streams: rows })).id).toBe('central:u-gold');
    expect((await modelDetail({ db, id: 'u-gold', streams: rows })).id).toBe('central:u-gold');
    expect(await modelDetail({ db, id: 'central:nope', streams: rows })).toBeNull();
    // Retrain is offered: a Satori Network model with the history to split (docs/design/models.md#retrain)
    expect(d.retrain).toEqual({ available: true, why: null, last: null });
    const last2 = { n: 2, at: 9, outcome: 'found', kept: 'new', ratio: 0.8, was: 1.1, tried: 40 };
    const asked = rows.map((r) => (r.uuid === 'u-gold' ? { ...r, retrain: JSON.stringify({ n: 2, status: 'done', result: last2 }) } : r));
    expect((await modelDetail({ db, id: 'u-gold', streams: asked })).retrain).toEqual({ available: true, why: null, last: last2 });
    // not with less than about four weeks of back-to-back history
    const young = { histories: async (us) => new Map(us.map((u) => [u, (histories.get(u) ?? []).slice(-40)])) };
    expect((await modelDetail({ db: young, id: 'u-gold', streams: rows })).retrain).toEqual({ available: false, why: 'history', last: null });
  });

  test('Nostr: the stream alone at its cadence; Base: from the chain\'s history when it answers, else Out alone', async () => {
    const subs = [{ uuid: 'n-1', stream: 'btc', provider: 'p', name: 'Bitcoin', cadence_seconds: 3600, observation: { seq: 9, ts: 7000, value: 100 },
      prediction: { stream: 'btc_pred', seq: 4, value: '101.5', model: 'bar1', made_at: 7001, relays: 2 } }];
    const n = await modelDetail({ db, id: 'nostr:n-1', subscriptions: subs });
    const x = explainForecast(grid(prices.n1, 0, 3600), { step: 3600, horizon: 3600 });
    expect(n).toMatchObject({ source: 'nostr', name: 'Bitcoin', model: { kind: 'bar1', rows: x.rows, tests: x.tests, step: 3600, horizon: 3600,
      weight: x.weight, quality: { error: x.score, noChange: x.persist } }, outputs: [{ as: 'btc_pred', influence: [{ stream: 'n-1', share: 1 }] }] });

    const batch = { round: 20743, at: 9000, hash: '0xabc', dropped: [], games: [
      { streamId: 3, gameId: 13, named: false, direction: UP, model: 'bar1', latest: '5', forecast: '6', horizon: 86_400, step: 43_200 }] };
    const hist = grid(prices.n2).map(({ ts, value }) => ({ ts, value }));
    const b = await modelDetail({ db, id: 'base:3', lastBatch: batch, baseHistory: async () => hist });
    expect(b).toMatchObject({ source: 'base', name: 'Stream 3', model: { kind: 'bar1', step: 43_200, horizon: 86_400, rows: expect.any(Number) },
      outputs: [{ destinations: [{ to: 'contract', status: 'sent', ref: { round: 20743, tx: '0xabc', direction: 'up' } }] }] });
    expect(b.outputs[0].history.length).toBeGreaterThan(0);
    const offline = await modelDetail({ db, id: 'base:3', lastBatch: batch, baseHistory: async () => { throw new Error('down'); } });
    expect(offline).toMatchObject({ model: { kind: 'bar1', rows: null }, outputs: [{ history: [] }] });
    // no Retrain for Relays and Contract models: they read only their own stream (nothing to search, no spec)
    expect(n.retrain).toEqual({ available: false, why: 'source', last: null });
    expect(b.retrain).toEqual({ available: false, why: 'source', last: null });
  });
});
