import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb } from '../db/node.js';
import { CentralError, predictionItem } from '../central/index.js';
import { MODEL } from '../engine/index.js';
import {
  cycle, register, firstPollAt, startJitter, createPoller, claimTab, POLL_EVERY_S, FIRST_POLL_S, BATCH_LIMIT,
} from './index.js';

vi.setConfig({ testTimeout: 60_000 });

const T = 1_792_000_000; // seconds
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
const run = (o) => cycle({ db, central, now, ...o });

describe('cycle: poll → store → forecast new rows → submit', () => {
  test('stores the batch, forecasts each stream, and sends Lite\'s payload items', async () => {
    central.batch = [entry('u-btc', 'bitcoin', T - 100.7, '100.0'), entry('u-eth', 'eth', T - 50, '5')];
    const r = await run();
    expect(r.poll).toEqual({ at: T + 0.25, streams: 2, new: 2, predicted: 2 });
    expect(r.submit).toMatchObject({ at: T + 0.25, total_submitted: 2, successful: 2, failed: 0 });
    expect(await db.history('u-btc')).toEqual([{ ts: T - 101, value: 100 }]);
    const [items] = central.sent;
    expect(items).toEqual([
      predictionItem({ streamUuid: 'u-btc', streamName: 'bitcoin', t1: 100, t2: 100, now: T + 0.25 }),
      predictionItem({ streamUuid: 'u-eth', streamName: 'eth', t1: 5, t2: 5, now: T + 0.25 }),
    ]);
    expect(items[0]).toMatchObject({ value: '100.0', t1_value: '100.0', observed_at: '1792000000.25' });
    expect(await db.pendingCount()).toBe(0);
    expect(await db.predictions('bitcoin')).toMatchObject([{ status: 'sent', sent_at: T + 0.25, model: MODEL }]);
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

  test('only streams that got a new row are forecast, on their whole history', async () => {
    const forecast = vi.fn((points) => ({ model: 'm', t1: points.length, t2: points.length + 0.5 }));
    central.batch = [entry('u-a', 'a', T, 1), entry('u-b', 'b', T, 2)];
    await run({ forecast });
    central.batch = [entry('u-a', 'a', T + 3600, 3), entry('u-b', 'b', T, 2)];
    clock += 3600;
    const r = await run({ forecast });
    expect(r.poll).toMatchObject({ new: 1, predicted: 1 });
    expect(forecast).toHaveBeenLastCalledWith([{ ts: T, value: 1 }, { ts: T + 3600, value: 3 }]);
    expect(central.sent[1]).toEqual([expect.objectContaining({ stream_uuid: 'u-a', value: '2.5', t1_value: '2.0' })]);
  });

  test('no forecast (null) → no prediction; unusable rows are dropped', async () => {
    central.batch = [entry('u-a', 'a', T, 'abc'), { ...entry('u-b', 'b', T, 1), stream: null, stream_uuid: null }, entry('u-c', 'c', T, 1)];
    const r = await run({ forecast: () => null });
    expect(r).toEqual({ poll: { at: clock, streams: 1, new: 1, predicted: 0 }, submit: null });
  });

  test('kept queue: successful == 0 or an error keeps every prediction; the next poll resends them with its own', async () => {
    central.batch = [entry('u-a', 'a', T, 1)];
    central.results = [{ total_submitted: 1, successful: 0, failed: 1, prediction_ids: [], errors: ['nope'] }];
    expect((await run()).submit).toMatchObject({ successful: 0, errors: ['nope'] });
    expect(await db.pendingCount()).toBe(1);

    central.batch = [entry('u-a', 'a', T + 1, 2)];
    central.results = [new CentralError(0, 'network', 'central unreachable: Failed to fetch')];
    expect((await run()).submit).toEqual({ at: clock, error: 'central unreachable: Failed to fetch' });
    expect(await db.pendingCount()).toBe(2);

    central.batch = [entry('u-a', 'a', T + 2, 3)];
    clock += 10;
    const r = await run(); // the default result accepts all
    expect(central.sent.map((s) => s.length)).toEqual([1, 2, 3]);
    expect(central.sent[2].map((i) => i.t1_value)).toEqual(['1.0', '3.0', '4.0']);
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
    expect(r).toEqual({ poll: { at: clock, error: 'IO Error: Could not write file' }, submit: null });
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

  test('a batch that is not a list is a failed poll', async () => {
    central.batch = { detail: 'odd' };
    expect((await run()).poll).toEqual({ at: clock, error: 'central sent no list of observations' });
  });
});

describe('register', () => {
  const res = { success: true, peer_id: 7, wallet_address: 'Eid', vault_address: 'Evault', message: 'Peer already registered' };
  const fake = (r) => ({ register: vi.fn(async () => { if (r instanceof Error) throw r; return r; }) });
  test('sends the vault pubkey; the result says whether central has our vault', async () => {
    const c = fake(res);
    expect(await register({ central: c, vaultPubkey: '03cd', vaultAddress: 'Evault', now })).toEqual({
      at: clock, ok: true, peer_id: 7, wallet_address: 'Eid', vault_address: 'Evault', message: 'Peer already registered', vaultMismatch: false,
    });
    expect(c.register).toHaveBeenCalledWith({ vaultPubkey: '03cd' });
  });
  test('another vault, or none kept: a mismatch', async () => {
    expect((await register({ central: fake({ ...res, vault_address: 'Eother' }), vaultPubkey: '03cd', vaultAddress: 'Evault', now })).vaultMismatch).toBe(true);
    expect((await register({ central: fake({ ...res, vault_address: null }), vaultPubkey: '03cd', vaultAddress: 'Evault', now })).vaultMismatch).toBe(true);
  });
  test('no vault pubkey: skipped; a failure is returned, never thrown', async () => {
    const c = fake(res);
    expect(await register({ central: c, vaultPubkey: null, vaultAddress: null, now })).toEqual({ at: clock, ok: false, skipped: true, error: 'no vault public key in vault.yaml' });
    expect(c.register).not.toHaveBeenCalled();
    expect(await register({ central: fake(new CentralError(409, 'taken')), vaultPubkey: '03cd', vaultAddress: 'E', now }))
      .toEqual({ at: clock, ok: false, error: 'central 409: taken' });
  });
});

describe('schedule', () => {
  test("the start jitter is Lite's uniform 5–30 min", () => {
    expect(FIRST_POLL_S).toEqual([300, 1800]);
    expect(POLL_EVERY_S).toBe(11 * 3600);
    expect(startJitter(() => 0)).toBe(300);
    expect(startJitter(() => 0.999999)).toBe(1800);
    for (let i = 0; i < 200; i++) {
      const j = startJitter();
      expect(Number.isInteger(j) && j >= 300 && j <= 1800).toBe(true);
    }
  });
  test('a stored time still ahead is kept; due, missing or too far ahead → now + jitter', () => {
    const half = () => 0.5;
    expect(firstPollAt(T + 100, T, half)).toBe(T + 100);
    expect(firstPollAt(T + POLL_EVERY_S, T, half)).toBe(T + POLL_EVERY_S);
    for (const stored of [undefined, null, T, T - 5000, T + POLL_EVERY_S + 1, 'x']) {
      expect(firstPollAt(stored, T, half)).toBe(T + 1050);
    }
  });
});

describe('createPoller', () => {
  function harness(runImpl, store = db) {
    const timers = [];
    const ran = [];
    const changes = [];
    const poller = createPoller(async () => { ran.push(clock); return runImpl?.(); }, {
      db: store, now, rand: () => 0,
      setTimeout: (fn, ms) => timers.push({ fn, ms, live: true }) - 1,
      clearTimeout: (id) => { if (timers[id]) timers[id].live = false; },
      onChange: (c) => changes.push(c),
    });
    const live = () => timers.filter((t) => t.live);
    return { poller, timers, live, ran, changes };
  }

  test('start: due → 5–30 min, persisted; the timer runs a cycle, then every 11 h', async () => {
    const h = harness();
    const t0 = clock;
    await h.poller.start();
    expect(await db.get('next_poll_at')).toBe(clock + 300);
    expect(h.poller.next).toBe(clock + 300);
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0].ms).toBe(300_000);
    clock += 300;
    h.live()[0].fn();
    await vi.waitFor(() => expect(h.timers.length).toBe(2));
    expect(h.ran).toEqual([clock]);
    expect(await db.get('next_poll_at')).toBe(clock + POLL_EVERY_S);
    expect(h.live().map((t) => t.ms)).toEqual([POLL_EVERY_S * 1000]);
    // One flag, the poller's: onChange tells the UI when it runs and what is next.
    expect(h.changes).toEqual([
      { next: t0 + 300, running: false }, { next: t0 + 300, running: true }, { next: clock + POLL_EVERY_S, running: false },
    ]);
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
