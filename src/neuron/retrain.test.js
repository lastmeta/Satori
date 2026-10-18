// Retrain as the app runs it (docs/design/models.md#retrain): the request kept with the spec, one at a time, from stored
// history only (never a prediction, never central), paced, paused while a poll runs, resumed after a reload, stopped.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb } from '../../test/memory-db.js';
import { STEP_S } from '../engine/index.js';
import { fitter } from '../engine/evolve.js';
import { retrainer } from '../engine/retrain.js';
import { fitKey, statsOf, lacking } from './train.js';
import { createRetrain, RetrainError } from './retrain.js';
import { createWork } from './work.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // DuckDB's wasm starts in the first beforeEach

const T0 = Date.UTC(2026, 8, 1) / 1000;
const ID = '02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a';
const NAMES = ['gold', 'lead', 'n0', 'n1', 'n2', 'n3', 'n4'];
const TIGHT = { companions: ['n0'], lambda1: 0.05, lambda2: 0.25 }; // close to no change, without the leader

function normals(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
}
/** 83 buckets of 12 h (central's ~41 days): 'gold' trails 'lead' by one step; the rest are random walks. */
function market(seed = 3, n = 83) {
  const normal = normals(seed);
  const out = Object.fromEntries(NAMES.map((k) => [k, [100]]));
  let last = 0;
  for (let k = 1; k < n; k++) {
    const r = Object.fromEntries(NAMES.map((x) => [x, 0.015 * normal()]));
    r.gold = last + 0.003 * normal();
    last = r.lead;
    for (const x of NAMES) out[x].push(out[x].at(-1) * (1 + r[x]));
  }
  return out;
}
const PRICES = market();
const pointsOf = (name, upTo = 83) => PRICES[name].slice(0, upTo).map((value, k) => ({ ts: T0 + (k + 1) * STEP_S - 1, value }));

let db;
let work;
beforeEach(async () => {
  db = await memoryDb();
  work = createWork();
});

/** A neuron with every stream's history, a prediction each, and the champions given (gold: TIGHT). */
async function neuron({ upTo = 83, specs = { gold: TIGHT, n1: { companions: ['n2'], lambda1: 0.05, lambda2: 0.25 } } } = {}) {
  await db.addObservations(NAMES.flatMap((n) => pointsOf(n, upTo).map((p) => ({ stream_uuid: n, name: n, meta: null, ...p }))));
  const stat = statsOf(await db.streams());
  const histories = await db.centralHistories();
  await db.saveSpecs(new Map(Object.entries(specs).map(([u, spec]) => {
    const f = fitter({ histories })(u, spec);
    return [u, { spec, score: f.score, persist: f.persist, influence: f.influence, generation: 5, accepted: 1, fit_key: fitKey(u, spec, stat) }];
  })), T0);
  await db.addPredictions(Object.keys(specs).map((u) => ({ stream_uuid: u, made_at: T0 + 1, model: 'bvar', t1: 1, t2: 1, phi: null, weight: 1,
    observed_at: String(T0 + 1), hash: 'h', obs_ts: T0 + upTo * STEP_S - 1 })));
  return histories;
}

/** A retrain runner over the test db: every try its own slice (the page's turn after each), no throttles. */
const runner = (o = {}) => createRetrain({ db, work, seed: () => ID, nameOf: (u) => u.toUpperCase(), sliceMs: 0, showMs: 0, saveMs: 0,
  pause: async () => {}, ...o });

describe('Retrain', () => {
  test('a planted leader: found, stored as the champion (its fit, generation + 1, the summary); never a prediction', async () => {
    await neuron();
    const preds = await db.predictions('gold', 99);
    const spy = vi.spyOn(db, 'addPredictions');
    const steps = [];
    work = createWork({ onChange: () => { const e = work.of('retrain'); if (e) steps.push(`${e.name}:${e.done}`); } });
    const after = vi.fn(async () => {});
    const rt = runner({ after });
    const asked = await rt.start('gold');
    expect(asked).toMatchObject({ running: true, result: null });
    expect((await db.specs()).get('gold').retrain).toMatchObject({ n: 1, status: 'running', state: null });
    const result = await rt.done('gold');
    expect(result).toMatchObject({ n: 1, outcome: 'found', kept: 'new', checks: 1, looked: true, from: TIGHT });
    expect(result.spec.companions).toContain('lead');
    expect(result.ratio).toBeLessThan(0.95);
    // the same as the pure search on the same data and seed
    const pure = retrainer({ target: 'gold', histories: await db.centralHistories(), champion: TIGHT, seed: ID, n: 1 });
    let res;
    while (!(res = pure.step()));
    expect(result).toMatchObject({ spec: res.spec, ratio: res.ratio, tried: res.tried });
    // stored as evolution stores a champion: the poll's fit of it, its key (current: nothing for the training pass)
    const row = (await db.specs()).get('gold');
    const f = fitter({ histories: await db.centralHistories() })('gold', result.spec);
    expect(row).toMatchObject({ spec: result.spec, score: f.score, persist: f.persist, influence: f.influence, generation: 6, accepted: 2,
      retrain: { n: 1, status: 'done', result } });
    expect(row.score / row.persist).toBeCloseTo(result.ratio, 12);
    expect(lacking({ streams: await db.streams() }).central.map((x) => x.uuid)).not.toContain('gold');
    // the work: "Retraining GOLD…", then its count
    expect(steps[0]).toBe('GOLD:0');
    expect(steps.some((x) => /^GOLD:[1-9]/.test(x))).toBe(true);
    expect(work.of('retrain')).toBeNull();
    expect(after).toHaveBeenCalledWith('gold', result);
    expect(rt.status('gold')).toEqual({ running: false, waiting: null, after: null, tried: result.tried, best: expect.any(Number), result });
    // never a prediction: none made, none queued
    expect(spy).not.toHaveBeenCalled();
    expect(await db.predictions('gold', 99)).toEqual(preds);
    expect(await db.pendingCount()).toBe(2); // the two the neuron had
  });

  test('Stop: it ends at its next try and keeps the current champion, without a look at the held-out origins', async () => {
    await neuron();
    let gate = null;
    let pauses = 0;
    const rt = runner({ pause: () => (++pauses === 3 ? new Promise((r) => { gate = r; }) : Promise.resolve()) });
    await rt.start('n1');
    await vi.waitFor(() => expect(gate).not.toBeNull());
    expect(rt.status('n1')).toMatchObject({ running: true, tried: 3 });
    expect(rt.stop('n1')).toMatchObject({ running: true });
    gate();
    const result = await rt.done('n1');
    expect(result).toMatchObject({ outcome: 'stopped', kept: 'current', tried: 3, looked: false }); // no look: a retrain can follow at once
    expect((await db.specs()).get('n1')).toMatchObject({ spec: { companions: ['n2'] }, generation: 5, retrain: { status: 'done', result } });
  });

  test('resumes after a reload: the request and the search\'s place are kept; it continues to the same result', async () => {
    await neuron();
    const whole = await (async () => {
      const rt = runner();
      await rt.start('gold');
      return rt.done('gold');
    })();
    // the same request on a fresh copy of the neuron, cut off after 7 tries (a closed tab: its pause never returns)
    db = await memoryDb();
    await neuron();
    let pauses = 0;
    const closed = runner({ pause: () => (++pauses >= 7 ? new Promise(() => {}) : Promise.resolve()) });
    await closed.start('gold');
    await vi.waitFor(async () => expect((await db.specs()).get('gold').retrain.state?.tried).toBe(7));
    // reopened: it continues where it was, without being asked again
    const steps = [];
    work = createWork({ onChange: () => { const e = work.of('retrain'); if (e) steps.push(e.done); } });
    const rt = runner();
    expect(await rt.resume()).toBe(1);
    expect(rt.status('gold')).toMatchObject({ running: true, tried: 7 });
    const result = await rt.done('gold');
    expect(steps[0]).toBe(7);
    expect(result).toMatchObject({ outcome: whole.outcome, kept: whole.kept, spec: whole.spec, ratio: whole.ratio, tried: whole.tried, n: 1 });
    expect((await db.specs()).get('gold')).toMatchObject({ spec: whole.spec, retrain: { status: 'done' } });
    expect(await rt.resume()).toBe(0); // nothing left
  });

  test('it waits while central\'s work runs: no try before the poll ends; mid-search it pauses, then goes on with the new champion', async () => {
    await neuron();
    let polling = true;
    let pauses = 0;
    const reads = vi.spyOn(db, 'centralHistories');
    // a poll begins during the page's 4th turn
    const rt = runner({ busy: () => polling, pause: async () => { if (++pauses === 4) polling = true; } });
    await rt.start('gold');
    await new Promise((r) => setTimeout(r, 30));
    expect(rt.status('gold')).toMatchObject({ running: true, waiting: 'poll', tried: 0 });
    expect(reads).not.toHaveBeenCalled(); // not even its data read
    expect(work.of('retrain')).toBeNull(); // the poll leads; nothing of the retrain's is shown yet
    polling = false;
    rt.wake();
    // mid-search: the poll that began evolves gold's spec meanwhile, then ends
    await vi.waitFor(() => expect(rt.status('gold')).toMatchObject({ waiting: 'poll', tried: 4 }));
    expect((await db.specs()).get('gold').retrain.state.tried).toBe(4); // its place kept
    expect(work.of('retrain')).toBeNull();
    const evolved = { companions: ['n3'], lambda1: 0.05, lambda2: 0.25 };
    const f = fitter({ histories: await db.centralHistories() })('gold', evolved);
    await db.saveSpecs(new Map([['gold', { spec: evolved, score: f.score, persist: f.persist, influence: f.influence, generation: 6, accepted: 1 }]]), T0 + 9);
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.status('gold').tried).toBe(4); // nothing while it runs
    polling = false;
    rt.wake();
    const result = await rt.done('gold');
    expect(result.tried).toBeGreaterThan(4);
    expect(result.from).toEqual(evolved); // compared with the champion the poll left
    if (result.kept === 'new') expect((await db.specs()).get('gold')).toMatchObject({ spec: result.spec, generation: 7 });
    else expect((await db.specs()).get('gold')).toMatchObject({ spec: evolved, generation: 6 });
  });

  test('one look per observation: a second retrain on the same data is refused with a note; after a new observation, it runs', async () => {
    await neuron();
    const rt = runner();
    await rt.start('gold');
    const first = await rt.done('gold');
    expect(first.looked).toBe(true);
    expect(await rt.start('gold')).toMatchObject({ running: false, result: { ...first, note: 'same-data' } });
    expect((await db.specs()).get('gold').retrain).toMatchObject({ n: 1, status: 'done' }); // not asked again
    // the next observation of gold: new recent data, a new look
    await db.addObservations([{ stream_uuid: 'gold', name: 'gold', meta: null, ts: T0 + 84 * STEP_S - 1, value: PRICES.gold.at(-1) * 1.01 }]);
    expect(await rt.start('gold')).toMatchObject({ running: true });
    expect((await db.specs()).get('gold').retrain).toMatchObject({ n: 2, status: 'running' });
    expect((await rt.done('gold')).n).toBe(2);
  });

  test('one at a time, in the order asked: the second waits behind the first; refused without a spec or the history', async () => {
    await neuron();
    const order = [];
    const rt = runner({ after: async (u) => { order.push(u); } });
    await rt.start('gold');
    await rt.start('n1');
    expect(rt.status('n1')).toMatchObject({ running: true, waiting: 'queue', after: 'GOLD' });
    expect(rt.all()).toMatchObject({ gold: { running: true }, n1: { running: true, waiting: 'queue' } });
    await rt.done('n1');
    expect(order).toEqual(['gold', 'n1']);
    await expect(rt.start('lead')).rejects.toThrow(RetrainError); // no spec: it has not predicted
    await expect(rt.start('lead')).rejects.toThrow(/has not predicted yet/);
  });

  test('refused without four weeks of history (52 back-to-back buckets)', async () => {
    await neuron({ upTo: 50 });
    await expect(runner().start('gold')).rejects.toThrow('Retrain needs about four weeks of this stream\'s history.');
    expect((await db.specs()).get('gold').retrain).toBeNull();
  });
});
