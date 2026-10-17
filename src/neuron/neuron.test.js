import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { memoryDb } from '../../test/memory-db.js';
import { CentralError, predictionItem } from '../central/index.js';
import {
  cycle, register, firstPollAt, createPoller, centralStatus, claimTab, modelsOf, POLL_EVERY_S, BATCH_LIMIT,
} from './index.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // DuckDB's wasm starts in the first beforeEach: slow on a busy box

const T = 1_792_000_000; // seconds
const ID = '02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a'; // the identity's pubkey: the specs' seed
const entry = (uuid, name, observedAt, value) => ({
  id: 1, observed_at: String(observedAt), value: String(value), hash: '', stream_id: 1,
  stream: { id: 1, uuid, name, meta: null }, ts: '2026-10-14T23:00:12.756973', stream_uuid: uuid,
});

/** A fake central: `batch` is what the next poll returns; `results` what each submission returns (or throws). */
function fakeCentral() {
  const c = {
    batch: [],
    results: [],
    sent: [],
    observations: vi.fn(async (limit) => {
      if (c.batch instanceof Error) throw c.batch;
      expect(limit).toBe(BATCH_LIMIT);
      return c.batch;
    }),
    history: vi.fn(async () => { throw new CentralError(404, 'Not Found'); }), // central2 today: no history route
    submitPredictions: vi.fn(async (items) => {
      c.sent.push(items);
      const r = c.results.length ? c.results.shift() : { total_submitted: items.length, successful: items.length, failed: 0, prediction_ids: [], errors: null };
      if (r instanceof Error) throw r;
      return r;
    }),
  };
  return c;
}

let db;
let central;
let clock;
const now = () => clock;
beforeEach(async () => {
  db = await memoryDb();
  central = fakeCentral();
  clock = T + 0.25;
});
const run = (o) => cycle({ db, central, now, seed: ID, ...o });
/** An engine that forecasts each fresh stream with `fn(history)` and keeps no specs. */
const perStream = (fn) => vi.fn(({ fresh, histories }) => ({
  forecasts: new Map(fresh.map((u) => [u, fn(histories.get(u))]).filter(([, f]) => f)), specs: new Map() }));

describe('cycle: poll → store → forecast new rows → submit', () => {
  test('stores the batch, forecasts each stream, and sends Lite\'s payload items', async () => {
    central.batch = [entry('u-btc', 'bitcoin', T - 100.7, '100.0'), entry('u-eth', 'eth', T - 50, '5')];
    const r = await run();
    expect(r.poll).toEqual({ at: T + 0.25, streams: 2, new: 2, predicted: 2, engine_ms: expect.any(Number) });
    expect(r.submit).toMatchObject({ at: T + 0.25, total_submitted: 2, successful: 2, failed: 0 });
    expect(await db.history('u-btc')).toEqual([{ ts: T - 101, value: 100 }]);
    const [items] = central.sent;
    expect(items).toEqual([
      predictionItem({ streamUuid: 'u-btc', streamName: 'bitcoin', t1: 100, t2: 100, now: T + 0.25 }),
      predictionItem({ streamUuid: 'u-eth', streamName: 'eth', t1: 5, t2: 5, now: T + 0.25 }),
    ]);
    expect(items[0]).toMatchObject({ value: '100', t1_value: '100', observed_at: '1792000000.25' });
    expect(await db.pendingCount()).toBe(0);
    expect(await db.predictions('bitcoin')).toMatchObject([{ status: 'sent', sent_at: T + 0.25, model: 'naive', phi: null, weight: null }]);
    expect(await db.get('central_last_poll')).toEqual(r.poll);
    expect(await db.get('central_last_submit')).toEqual(r.submit);
  });

  test('dedupe: a repeated batch adds nothing, forecasts nothing, sends nothing', async () => {
    central.batch = [entry('u-btc', 'bitcoin', T, 1)];
    await run();
    const r = await run();
    expect(r).toEqual({ poll: { at: clock, streams: 1, new: 0, predicted: 0 }, submit: null });
    expect(central.submitPredictions).toHaveBeenCalledTimes(1);
    expect(await db.history('u-btc')).toHaveLength(1);
  });

  test('only streams whose latest observation has no prediction yet are forecast, on their whole history (every central stream\'s history is the pool)', async () => {
    const engine = perStream((points) => ({ model: 'm', t1: points.length, t2: points.length + 0.5 }));
    central.batch = [entry('u-a', 'a', T, 1), entry('u-b', 'b', T, 2)];
    await run({ engine });
    central.batch = [entry('u-a', 'a', T + 3600, 3), entry('u-b', 'b', T, 2)];
    clock += 3600;
    const r = await run({ engine });
    expect(r.poll).toMatchObject({ new: 1, predicted: 1 });
    const [{ fresh, histories, seed }] = engine.mock.lastCall;
    expect([fresh, seed]).toEqual([['u-a'], ID]);
    expect(histories).toEqual(new Map([['u-a', [{ ts: T, value: 1 }, { ts: T + 3600, value: 3 }]], ['u-b', [{ ts: T, value: 2 }]]]));
    expect(central.sent[1]).toEqual([expect.objectContaining({ stream_uuid: 'u-a', value: '2.5', t1_value: '2' })]);
  });

  test("the engine's phi and weight are stored with the prediction; the payload stays Lite's (value = t2, t1_value = t1)", async () => {
    const engine = perStream(() => ({ model: 'bar1', t1: 101, t2: 102.5, phi: -0.2, weight: 0.6 }));
    central.batch = [entry('u-a', 'a', T, 100)];
    await run({ engine });
    expect(await db.predictions('a')).toMatchObject([{ model: 'bar1', t1: 101, t2: 102.5, phi: -0.2, weight: 0.6 }]);
    expect(central.sent[0]).toEqual([predictionItem({ streamUuid: 'u-a', streamName: 'a', t1: 101, t2: 102.5, now: T + 0.25 })]);
    expect(central.sent[0][0]).toMatchObject({ value: '102.5', t1_value: '101' });
  });

  test('no forecast (null) → no prediction; unusable rows are dropped', async () => {
    central.batch = [entry('u-a', 'a', T, 'abc'), { ...entry('u-b', 'b', T, 1), stream: null, stream_uuid: null }, entry('u-c', 'c', T, 1)];
    const r = await run({ engine: perStream(() => null) });
    expect(r).toEqual({ poll: { at: clock, streams: 1, new: 1, predicted: 0, engine_ms: expect.any(Number) }, submit: null });
    // no prediction was made from u-c's observation, so the next poll tries it again
    expect((await run()).poll).toMatchObject({ new: 0, predicted: 1 });
  });

  test('an interrupted poll: rows stored, the page reloaded before the forecasts; the next poll, with nothing new, predicts and sends them', async () => {
    central.batch = [entry('u-btc', 'bitcoin', T - 100, 100), entry('u-eth', 'eth', T - 50, 5)];
    // the reload lands during the history backfill: the rows are committed, and this cycle never goes on
    void run({ backfill: () => new Promise(() => {}) });
    await vi.waitFor(async () => expect((await db.streams()).map((s) => s.observations)).toEqual([1, 1]));
    expect(await db.predictions('bitcoin')).toEqual([]);
    clock += 60; // the next page load polls at once: the same batch, nothing new
    const r = await run();
    expect(r.poll).toMatchObject({ streams: 2, new: 0, predicted: 2 });
    expect(r.submit).toMatchObject({ total_submitted: 2, successful: 2 });
    expect(central.sent).toEqual([[
      predictionItem({ streamUuid: 'u-btc', streamName: 'bitcoin', t1: 100, t2: 100, now: clock }),
      predictionItem({ streamUuid: 'u-eth', streamName: 'eth', t1: 5, t2: 5, now: clock }),
    ]]);
    // Lite's rule stays: an observation is predicted once
    expect(await run()).toEqual({ poll: { at: clock, streams: 2, new: 0, predicted: 0 }, submit: null });
    expect(central.sent).toHaveLength(1);
  });

  test('a cycle that failed after storing (the engine threw): the next poll predicts what it left', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    central.batch = [entry('u-a', 'a', T, 1)];
    expect((await run({ engine: () => { throw new Error('out of memory'); } })).poll).toMatchObject({ local: true });
    expect((await run()).poll).toMatchObject({ new: 0, predicted: 1 });
    expect(central.sent.flat().map((i) => i.stream_uuid)).toEqual(['u-a']);
    error.mockRestore();
  });

  test("a polled row older than the stream's latest (central's latest went back) is stored, not predicted: the latest was", async () => {
    central.batch = [entry('u-a', 'a', T, 1)];
    await run();
    central.batch = [entry('u-a', 'a', T - 3600, 0.5)];
    expect(await run()).toEqual({ poll: { at: clock, streams: 1, new: 1, predicted: 0 }, submit: null });
    expect(await db.history('u-a')).toHaveLength(2);
  });

  test('only streams in this batch are predicted: one central no longer sends is left alone', async () => {
    central.batch = [entry('u-a', 'a', T, 1), entry('u-b', 'b', T, 2)];
    void run({ backfill: () => new Promise(() => {}) }); // interrupted: neither predicted
    await vi.waitFor(async () => expect(await db.streams()).toHaveLength(2));
    central.batch = [entry('u-a', 'a', T, 1)]; // central stopped sending b (its latest is over 48 h old)
    expect((await run()).poll).toMatchObject({ new: 0, predicted: 1 });
    expect(central.sent.flat().map((i) => i.stream_uuid)).toEqual(['u-a']);
  });

  test('kept queue: successful == 0 or an error keeps every prediction; the next poll resends them with its own', async () => {
    central.batch = [entry('u-a', 'a', T, 1)];
    central.results = [{ total_submitted: 1, successful: 0, failed: 1, prediction_ids: [], errors: ['nope'] }];
    expect((await run()).submit).toMatchObject({ successful: 0, errors: ['nope'] });
    expect(await db.pendingCount()).toBe(1);

    central.batch = [entry('u-a', 'a', T + 1, 2)];
    central.results = [new CentralError(0, 'network', 'central unreachable: Failed to fetch')];
    expect((await run()).submit).toEqual({ at: clock, error: 'central unreachable: Failed to fetch', total_submitted: 2 });
    expect(await db.pendingCount()).toBe(2);
    const refused = Object.assign(new CentralError(401, 'Invalid signature'), { login: true });
    central.results = [refused];
    expect((await run()).submit).toEqual({ at: clock, error: 'central 401: Invalid signature', total_submitted: 2, login: true });
    expect(await db.pendingCount()).toBe(2);

    central.batch = [entry('u-a', 'a', T + 2, 3)];
    clock += 10;
    const r = await run(); // the default result accepts all
    expect(central.sent.map((s) => s.length)).toEqual([1, 2, 2, 3]);
    expect(central.sent[3].map((i) => i.t1_value)).toEqual(['1', '2', '3']); // naive: the last value
    expect(r.submit.successful).toBe(3);
    expect(await db.pendingCount()).toBe(0);
  });

  test('a poll with nothing new still resends what is pending', async () => {
    central.batch = [entry('u-a', 'a', T, 1)];
    central.results = [new CentralError(500, 'boom')];
    await run();
    const r = await run();
    expect(r.poll.new).toBe(0);
    expect(r.submit.successful).toBe(1);
    expect(await db.pendingCount()).toBe(0);
  });

  test('a failed poll is recorded; nothing is stored or sent', async () => {
    central.batch = [entry('u-a', 'a', T, 1)];
    central.results = [new CentralError(500, 'boom')];
    await run();
    central.batch = new CentralError(0, 'timeout', 'central timed out (15 s)');
    const r = await run();
    expect(r).toEqual({ poll: { at: clock, error: 'central timed out (15 s)' }, submit: null });
    expect(central.submitPredictions).toHaveBeenCalledTimes(1);
    expect(await db.get('central_last_poll')).toEqual(r.poll);
    expect(await db.pendingCount()).toBe(1);
  });

  test('a local failure (the database) is recorded as the poll\'s error and logged, never thrown', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    central.batch = [entry('u-a', 'a', T, 1)];
    const broken = { ...db, addObservations: async () => { throw new Error('IO Error: Could not write file'); } };
    const r = await cycle({ db: broken, central, now });
    expect(r).toEqual({ poll: { at: clock, error: 'IO Error: Could not write file', local: true }, submit: null }); // health: db-error
    expect(await db.get('central_last_poll')).toEqual(r.poll);
    expect(error).toHaveBeenCalledWith('[satori] cycle failed', expect.any(Error));
    error.mockRestore();
  });

  test(`pending predictions older than ${2 * 11} h are dropped before sending`, async () => {
    central.batch = [entry('u-a', 'a', T, 1), entry('u-b', 'b', T, 2)];
    central.results = [new CentralError(503, 'down')];
    await run();
    expect(await db.pendingCount()).toBe(2);
    clock += 2 * POLL_EVERY_S + 1; // both are now too old
    central.batch = [entry('u-a', 'a', T + 60, 3)];
    const r = await run();
    expect(central.sent.at(-1).map((i) => i.stream_uuid)).toEqual(['u-a']);
    expect(r.submit.successful).toBe(1);
    expect(await db.pendingCount()).toBe(0);
    expect((await db.predictions('b'))).toEqual([]);
  });

  test('the engine: each target\'s spec drawn from the identity, stored, evolved; the prediction says which model made it', async () => {
    const names = ['gold', 'btc', 'eth', 'oil'];
    const price = (n, k) => 100 * (1 + 0.01 * Math.sin(k * (names.indexOf(n) + 1)) + 0.002 * k);
    let r;
    for (let k = 0; k < 40; k++) { // a poll every 12 h: aligned buckets for every stream
      central.batch = names.map((n) => entry(`u-${n}`, n, T + k * 43_200, price(n, k)));
      clock = T + k * 43_200 + 60;
      r = await run();
    }
    expect(r.poll).toMatchObject({ new: 4, predicted: 4, engine_ms: expect.any(Number) });
    const specs = await db.specs();
    expect([...specs.keys()].sort()).toEqual(names.map((n) => `u-${n}`).sort());
    for (const [u, row] of specs) {
      expect(row.spec.companions.length).toBeGreaterThanOrEqual(1);
      expect(row.spec.companions).not.toContain(u);
      expect(row.generation).toBeGreaterThan(10); // one proposal per poll once the backtest has 5 origins
      expect(row.score).toBeGreaterThan(0);
    }
    expect((await db.predictions('gold', 1))[0]).toMatchObject({ model: 'bvar', phi: expect.any(Number), weight: expect.any(Number) });
    expect((await db.predictions('gold', 40)).at(-1).model).toBe('naive'); // the first poll: one observation
    // the first draw: the same identity draws the same specs, another identity others
    const first = async (seed) => {
      const fresh = await memoryDb();
      central.batch = names.map((n) => entry(`u-${n}`, n, T, price(n, 0)));
      await cycle({ db: fresh, central, now, seed });
      return JSON.stringify([...(await fresh.specs())].map(([u, x]) => [u, x.spec]).sort());
    };
    expect(await first(ID)).toBe(await first(ID));
    expect(await first('another identity')).not.toBe(await first(ID));
  });

  test('a batch that is not a list is a failed poll', async () => {
    central.batch = { detail: 'odd' };
    expect((await run()).poll).toEqual({ at: clock, error: 'central sent no list of observations' });
  });
});

describe('register', () => {
  // central's vault_base_address (base-upgrade d8a2085): the Base address it pays this vault's rewards to
  const [v, other] = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url))).vectors;
  const res = { success: true, peer_id: 7, wallet_address: 'w', vault_address: 'v', vault_base_address: v.ethAddress,
    message: 'Peer already registered' };
  const fake = (r) => ({ register: vi.fn(async () => { if (r instanceof Error) throw r; return r; }) });
  const mismatch = async (r) => (await register({ central: fake(r), vaultPubkey: v.pubkey, now })).vaultMismatch;
  test("sends the vault pubkey; central pays this vault: no mismatch; both Base addresses, none of central's other forms", async () => {
    const c = fake(res);
    expect(await register({ central: c, vaultPubkey: v.pubkey, nostrPubkey: 'ee', now })).toEqual({
      at: clock, ok: true, peer_id: 7, message: 'Peer already registered',
      vault: v.ethAddress, vault_base_address: v.ethAddress, vaultMismatch: false,
    });
    expect(c.register).toHaveBeenCalledWith({ vaultPubkey: v.pubkey, nostrPubkey: 'ee' });
  });
  test('the addresses are compared case-insensitively', async () => {
    expect(await mismatch({ ...res, vault_base_address: v.ethAddress.toLowerCase() })).toBe(false);
    expect(await mismatch({ ...res, vault_base_address: `0x${v.ethAddress.slice(2).toUpperCase()}` })).toBe(false);
  });
  test("another Base address ('other'), or none (null: 'none'): a mismatch", async () => {
    const r = await register({ central: fake({ ...res, vault_base_address: other.ethAddress }), vaultPubkey: v.pubkey, now });
    expect(r).toMatchObject({ vault: v.ethAddress, vault_base_address: other.ethAddress, vaultMismatch: 'other' });
    expect(await mismatch({ ...res, vault_base_address: null })).toBe('none');
  });
  test('a central without the field (prod, on main): unknown (null), not a mismatch', async () => {
    const { vault_base_address: _, ...old } = res;
    expect(await register({ central: fake(old), vaultPubkey: v.pubkey, now })).toEqual({
      at: clock, ok: true, peer_id: 7, message: 'Peer already registered', vault: v.ethAddress, vault_base_address: null, vaultMismatch: null,
    });
    expect(await mismatch('not json')).toBeNull();
  });
  test('a failure is returned, never thrown', async () => {
    expect(await register({ central: fake(new CentralError(409, 'taken')), vaultPubkey: v.pubkey, now }))
      .toEqual({ at: clock, ok: false, error: 'central 409: taken' });
  });
});

describe('schedule', () => {
  test('no start delay: a new neuron (none stored) or a due poll is now; a stored time still ahead (by at most 11 h) is kept', () => {
    expect(POLL_EVERY_S).toBe(11 * 3600);
    expect(firstPollAt(T + 100, T)).toBe(T + 100);
    expect(firstPollAt(T + POLL_EVERY_S, T)).toBe(T + POLL_EVERY_S);
    for (const stored of [undefined, null, T, T - 5000, T + POLL_EVERY_S + 1, 'x']) {
      expect(firstPollAt(stored, T)).toBe(T);
    }
  });
});

describe('createPoller', () => {
  function harness(runImpl, store = db) {
    const timers = [];
    const ran = [];
    const changes = [];
    const poller = createPoller(async () => { ran.push(clock); return runImpl?.(); }, {
      db: store, now,
      setTimeout: (fn, ms) => timers.push({ fn, ms, live: true }) - 1,
      clearTimeout: (id) => { if (timers[id]) timers[id].live = false; },
      onChange: (c) => changes.push(c),
    });
    const live = () => timers.filter((t) => t.live);
    return { poller, timers, live, ran, changes };
  }

  test('start: a new neuron polls at once (persisted); the timer runs a cycle, then every 11 h', async () => {
    const h = harness();
    const t0 = clock;
    await h.poller.start();
    expect(await db.get('next_poll_at')).toBe(clock);
    expect(h.poller.next).toBe(clock);
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0].ms).toBe(0);
    h.live()[0].fn();
    await vi.waitFor(() => expect(h.timers.length).toBe(2));
    expect(h.ran).toEqual([clock]);
    expect(await db.get('next_poll_at')).toBe(clock + POLL_EVERY_S);
    expect(h.live().map((t) => t.ms)).toEqual([POLL_EVERY_S * 1000]);
    // One flag, the poller's: onChange tells the UI when it runs and what is next.
    expect(h.changes).toEqual([
      { next: t0, running: false }, { next: t0, running: true }, { next: clock + POLL_EVERY_S, running: false },
    ]);
  });

  test('reopened with a poll overdue: at once', async () => {
    await db.set('next_poll_at', clock - 3 * 86400);
    const h = harness();
    await h.poller.start();
    expect(h.poller.next).toBe(clock);
    expect(h.live().map((t) => t.ms)).toEqual([0]);
  });

  test('a reload keeps a stored time that is still ahead', async () => {
    await db.set('next_poll_at', clock + 7200);
    const h = harness();
    await h.poller.start();
    expect(h.poller.next).toBe(clock + 7200);
    expect(h.live()[0].ms).toBe(7_200_000);
  });

  test('poll now: runs at once, one run at a time, then 11 h on', async () => {
    let release;
    const h = harness(() => new Promise((r) => { release = r; }));
    await h.poller.start();
    const a = h.poller.poll();
    const b = h.poller.poll();
    expect(a).toBe(b);
    expect(h.poller.running).toBe(true);
    expect(h.live()).toHaveLength(0); // the start timer is cleared
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release({ poll: 'done' });
    expect(await a).toEqual({ poll: 'done' });
    expect(h.poller.running).toBe(false);
    expect(h.ran).toHaveLength(1);
    expect(h.poller.next).toBe(clock + POLL_EVERY_S);
    expect(h.live().map((t) => t.ms)).toEqual([POLL_EVERY_S * 1000]);
  });

  test('idle: resolves once the running poll is done (at once when none runs), and starts none', async () => {
    let release;
    const h = harness(() => new Promise((r) => { release = r; }));
    await h.poller.start();
    await h.poller.idle();
    expect(h.ran).toHaveLength(0);
    h.poller.poll();
    let done = false;
    const idle = h.poller.idle().then(() => { done = true; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(done).toBe(false);
    release({ poll: 'done' });
    await idle;
    expect(h.poller.running).toBe(false);
    expect(h.ran).toHaveLength(1);
  });

  test('a run that throws still schedules the next one', async () => {
    const h = harness(() => { throw new Error('db gone'); });
    await h.poller.start();
    await expect(h.poller.poll()).rejects.toThrow('db gone');
    expect(h.poller.next).toBe(clock + POLL_EVERY_S);
    expect(h.live()).toHaveLength(1);
  });

  test('saving next_poll_at fails: the timer is set anyway and the error is logged', async () => {
    let fail = false;
    const store = { ...db, set: async (k, v) => { if (fail) throw new Error('QuotaExceededError'); return db.set(k, v); } };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(() => ({ poll: 'ok' }), store);
    await h.poller.start();
    fail = true;
    expect(await h.poller.poll()).toEqual({ poll: 'ok' });
    expect(h.live().map((t) => t.ms)).toEqual([POLL_EVERY_S * 1000]);
    expect(h.poller.next).toBe(clock + POLL_EVERY_S);
    expect(error).toHaveBeenCalledWith('[satori] saving the next poll time', expect.any(Error));
    error.mockRestore();
  });
});

test('centralStatus: the URL, the register result, the last poll and submission, the schedule, the queue, the history', async () => {
  central.url = 'https://central2.example';
  central.results.push({ total_submitted: 1, successful: 0, failed: 1, errors: ['no'] });
  central.batch = [entry('u-btc', 'btc', T, 1)];
  const r = await run();
  const registration = { at: T, ok: true, peer_id: 7 };
  expect(await centralStatus({ db, central, registration, poller: { next: T + 60, running: false } })).toEqual({
    url: 'https://central2.example', registration, lastPoll: r.poll, nextPoll: T + 60, polling: false, lastSubmit: r.submit, pending: 1,
    history: { at: clock, url: 'https://central2.example', streams: 0, rows: 0, left: 1, error: 'central 404: Not Found',
      retryAt: clock + 86_400, needed: 1 },
  });
  expect(await centralStatus({ db })).toMatchObject({ url: null, nextPoll: null, polling: false });
});

test('modelsOf: each target\'s spec with its companions\' names, for agents (window.satori.models())', () => {
  const spec = (c) => JSON.stringify({ companions: c, lambda1: 0.1, lambda2: 1 });
  expect(modelsOf([
    { uuid: 'u-a', name: 'a', model: 'bvar', spec: spec(['u-b', 'u-x']), score: 0.01, generation: 4, accepted: 1 },
    { uuid: 'u-b', name: 'b', model: null, spec: null },
  ])).toEqual([{ uuid: 'u-a', name: 'a', model: 'bvar', spec: { companions: [{ uuid: 'u-b', name: 'b' }, { uuid: 'u-x', name: null }],
    lambda1: 0.1, lambda2: 1 }, score: 0.01, generation: 4, accepted: 1 }]);
});

test('claimTab: the first claim wins, a second gets false', async () => {
  const held = new Set();
  const locks = { request: (name, opts, cb) => {
    if (held.has(name)) return cb(null);
    held.add(name);
    return cb({ name });
  } };
  expect(await claimTab('x', locks)).toBe(true);
  expect(await claimTab('x', locks)).toBe(false);
});
