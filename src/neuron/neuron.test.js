import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { memoryDb } from '../db/node.js';
import { loadIdentity, verifyMessage } from '../keys/index.js';
import {
  tick, createScheduler, readPath, canonical, localPublisher, claimTab, streamError, DEFAULT_STREAM, MODEL, WINDOW,
} from './index.js';

vi.setConfig({ testTimeout: 60_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const v = fx.vectors[0];
const json = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
const coinbase = (amount) => json({ data: { amount: String(amount), base: 'BTC', currency: 'USD' } });

let db;
let identity;
beforeEach(async () => {
  db = await memoryDb();
  identity = await loadIdentity(v.walletYaml);
  await db.addStream(DEFAULT_STREAM);
});

test('readPath and canonical', () => {
  expect(readPath({ data: { amount: '1' } }, 'data.amount')).toBe('1');
  expect(readPath({ a: [{ b: 2 }] }, 'a.0.b')).toBe(2);
  expect(readPath({ a: 1 }, 'x.y')).toBeUndefined();
  expect(readPath(5, '')).toBe(5);
  expect(canonical({ address: 'E', value: 1, stream: 's', ts: 2, target_ts: 3, model: 'm', extra: 9 }))
    .toBe('{"stream":"s","ts":2,"target_ts":3,"value":1,"model":"m","address":"E"}');
});

describe('tick', () => {
  const deps = (o) => ({ db, identity, publish: localPublisher(db), now: () => 1_000_000, ...o });

  test('fetch → observation → OLS → signed prediction → stored → published', async () => {
    let t = 0;
    for (const price of [100, 101, 102]) {
      t += 60_000;
      const r = await tick(DEFAULT_STREAM, deps({ fetch: coinbase(price), now: () => t }));
      expect(r.ok).toBe(true);
    }
    const [s] = await db.summary();
    expect(s).toMatchObject({ observations: 3, predictions: 3, obs_value: 102, obs_ts: 180_000,
      pred_value: 103, pred_ts: 180_000, pred_target_ts: 240_000, pred_model: MODEL, last_error: null });
    expect(s.pred_published_at).not.toBeNull();
    expect(JSON.parse(s.pred_message)).toEqual({ stream: 'BTC-USD', ts: 180_000, target_ts: 240_000,
      value: 103, model: MODEL, address: v.address });
    expect(verifyMessage(s.pred_message, s.pred_signature, { address: v.address })).toBe(true);
  });

  test(`uses only the last ${WINDOW} observations`, async () => {
    const min = 60_000;
    for (let i = 0; i < 30; i++) await db.addObservation('BTC-USD', i * min, i < 10 ? 1000 : i);
    const r = await tick(DEFAULT_STREAM, deps({ fetch: coinbase(30), now: () => 30 * min }));
    expect(r.prediction.value).toBeCloseTo(31);
  });

  test('fits on observation times: a gap (closed tab, failed fetches) is not one step', async () => {
    const min = 60_000;
    for (let i = 0; i < 19; i++) await db.addObservation('BTC-USD', i * min, 80_000);
    const later = 18 * min + 12 * 60 * min;
    const r = await tick(DEFAULT_STREAM, deps({ fetch: coinbase(82_000), now: () => later }));
    expect(r.prediction.target_ts).toBe(later + min);
    expect(Math.abs(r.prediction.value - 82_000)).toBeLessThan(10);
  });

  test('an engine result that is not a number is an error, never signed', async () => {
    await db.addObservation('BTC-USD', 0, 1e308);
    await db.addObservation('BTC-USD', 1, -1e308);
    const r = await tick(DEFAULT_STREAM, deps({ fetch: coinbase(1e308), now: () => 2 }));
    expect(r).toEqual({ ok: false, error: 'engine produced no value' });
    expect((await db.summary())[0]).toMatchObject({ predictions: 0, last_error: 'engine produced no value' });
  });

  test('a stopped run (Remove) stores nothing and reports no error', async () => {
    const ctl = new AbortController();
    const fetch = (url, { signal }) => new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)));
    const run = tick(DEFAULT_STREAM, deps({ fetch, signal: ctl.signal }));
    ctl.abort();
    expect(await run).toEqual({ ok: false, error: 'stopped' });
    // stopped after the fetch resolved: still nothing stored
    const ctl2 = new AbortController();
    const r2 = await tick(DEFAULT_STREAM, deps({ fetch: async (...a) => { ctl2.abort(); return coinbase(1)(...a); }, signal: ctl2.signal }));
    expect(r2).toEqual({ ok: false, error: 'stopped' });
    expect((await db.summary())[0]).toMatchObject({ observations: 0, predictions: 0, last_error: null });
  });

  test('failures are stored as the last error and cleared by the next success', async () => {
    const cases = [
      [json({}, 503), /HTTP 503/],
      [json({ data: { amount: 'abc' } }), /no number at "data.amount"/],
      [json({ nope: 1 }), /no number/],
      [async () => { throw new TypeError('Failed to fetch'); }, /Failed to fetch/],
      [async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }, /timed out/],
    ];
    for (const [fetch, msg] of cases) {
      const r = await tick(DEFAULT_STREAM, deps({ fetch }));
      expect(r).toMatchObject({ ok: false });
      expect(r.error).toMatch(msg);
      expect((await db.streams())[0].last_error).toMatch(msg);
    }
    expect((await db.summary())[0]).toMatchObject({ observations: 0, predictions: 0 });
    expect((await tick(DEFAULT_STREAM, deps({ fetch: coinbase(5) }))).ok).toBe(true);
    expect((await db.streams())[0].last_error).toBeNull();
  });

  test('a publish failure is reported; the signed prediction stays stored', async () => {
    const r = await tick(DEFAULT_STREAM, deps({ fetch: coinbase(1), publish: async () => { throw new Error('relay down'); } }));
    expect(r).toEqual({ ok: false, error: 'relay down' });
    expect((await db.summary())[0]).toMatchObject({ predictions: 1, pred_published_at: null, last_error: 'relay down' });
  });
});

describe('scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('runs each stream now, then once per interval; a failing stream does not stop others', async () => {
    const calls = [];
    const s = createScheduler(async (stream) => {
      calls.push(stream.name);
      if (stream.name === 'bad') throw new Error('boom');
    });
    s.start({ name: 'a', interval_s: 60 });
    s.start({ name: 'bad', interval_s: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['a', 'bad']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((c) => c === 'a')).toHaveLength(2);
    expect(calls.filter((c) => c === 'bad')).toHaveLength(3);
    expect(s.running).toEqual(['a', 'bad']);
  });

  test('stop and stopAll end the schedule; restart replaces the old job', async () => {
    let n = 0;
    const s = createScheduler(async () => { n++; });
    s.start({ name: 'a', interval_s: 1 });
    s.start({ name: 'a', interval_s: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(3);
    s.stopAll();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(3);
    expect(s.running).toEqual([]);
  });

  test('stop aborts the run in flight and returns it, so the caller can wait for it', async () => {
    let seen;
    let finished = false;
    const s = createScheduler(async (stream, signal) => {
      seen = signal;
      await new Promise((r) => signal.addEventListener('abort', r));
      await new Promise((r) => setTimeout(r, 100));
      finished = true;
    });
    s.start({ name: 'a', interval_s: 60 });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.aborted).toBe(false);
    const done = s.stop('a');
    expect(seen.aborted).toBe(true);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(finished).toBe(true);
    await expect(s.stop('a')).resolves.toBeUndefined();
  });

  test('a slow run delays the next one instead of overlapping', async () => {
    let active = 0;
    let max = 0;
    const s = createScheduler(async () => {
      max = Math.max(max, ++active);
      await new Promise((r) => setTimeout(r, 1500));
      active--;
    });
    s.start({ name: 'a', interval_s: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(max).toBe(1);
    s.stopAll();
  });
});

test('streamError: a name, an https URL, a path, and 10 s to 1 day', () => {
  const ok = { name: 'ETH-USD', url: 'https://x', path: 'data.amount', interval_s: 60 };
  expect(streamError(ok)).toBeNull();
  expect(streamError(DEFAULT_STREAM)).toBeNull();
  expect(streamError({ ...ok, name: '' })).toMatch(/name/);
  expect(streamError({ ...ok, url: 'http://x' })).toMatch(/https/);
  expect(streamError({ ...ok, path: '' })).toMatch(/path/i);
  expect(streamError({ ...ok, interval_s: 9 })).toMatch(/10 seconds/);
  expect(streamError({ ...ok, interval_s: NaN })).toMatch(/10 seconds/);
  expect(streamError({ ...ok, interval_s: 86_400 })).toBeNull();
  expect(streamError({ ...ok, interval_s: 2_200_000 })).toMatch(/1 day/);
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
