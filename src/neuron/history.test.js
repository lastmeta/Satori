// Central's history (docs/design/central.md#history-an-addition-beyond-lite):
// the backfill against a mocked fetch through the real client.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb } from '../../test/memory-db.js';
import { createCentral } from '../central/index.js';
import { backfillHistory, HISTORY_LIMIT, HISTORY_SPAN_S, HISTORY_CONCURRENCY, HISTORY_RETRY_S } from './history.js';
import { cycle } from './index.js';

vi.setConfig({ testTimeout: 60_000 });

const BASE = 'https://central.test';
const T = 1_792_000_000;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const identity = { pubkey: '02ab', signCentralLogin: () => 'sig' };
const row = (uuid, at, value, o = {}) => ({ id: 1, stream_uuid: uuid, observed_at: String(at), value: String(value), ts: '2026-10-14T23:00:12', ...o });
const entry = (uuid, name, at, value) => ({ ...row(uuid, at, value), stream: { uuid, name, meta: null } });

/** A central whose history route answers `history(uuid)` (a Response, or a list for 200); counts calls in flight. */
function fakeCentral({ history = () => json(404, { detail: 'Not Found' }), delayMs = 0 } = {}) {
  const f = { calls: [], inFlight: 0, maxInFlight: 0, batch: [], sent: [] };
  f.fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/v1/observations/history') {
      f.calls.push(Object.fromEntries(u.searchParams));
      f.inFlight++;
      f.maxInFlight = Math.max(f.maxInFlight, f.inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      f.inFlight--;
      const r = history(u.searchParams.get('stream_uuid'));
      return r instanceof Response ? r : json(200, r);
    }
    if (u.pathname === '/api/v1/observations/batch') return json(200, f.batch);
    if (u.pathname === '/api/v1/auth/challenge') return json(200, { challenge: 'c' });
    if (u.pathname === '/api/v1/auth/login') return json(200, { access_token: 't' });
    if (u.pathname === '/api/v1/predictions/batch') {
      const { predictions } = JSON.parse(init.body);
      f.sent.push(predictions);
      return json(200, { total_submitted: predictions.length, successful: predictions.length, failed: 0 });
    }
    return json(404, { detail: 'Not Found' });
  });
  f.central = createCentral({ url: BASE, identity, version: '0', fetch: f.fetch });
  return f;
}

let db;
let clock;
const now = () => clock;
beforeEach(async () => {
  db = await memoryDb();
  clock = T + 0.5;
});
const polled = (uuids, at = T) => db.addObservations(uuids.map((u) => ({ stream_uuid: u, name: u, meta: null, ts: at, value: 100 })));

describe('backfillHistory', () => {
  test('200: up to 1,000 rows per stream since 1,000 h ago, normalized as poll rows, stored older than the newest polled row; once per stream', async () => {
    await polled(['u-a', 'u-b']);
    const f = fakeCentral({ history: (u) => [row(u, T - 7200.9, 98), row(u, T - 3600, 99, { observed_at: null, ts: new Date((T - 3600) * 1000).toISOString().slice(0, -1) }), row(u, T, 1), row(u, T + 60, 101)] });
    const r = await backfillHistory({ db, central: f.central, now });
    expect(f.calls).toEqual(['u-a', 'u-b'].map((u) => ({ stream_uuid: u, limit: String(HISTORY_LIMIT), since: String(T - HISTORY_SPAN_S) })));
    expect(r).toEqual({ at: T + 0.5, url: BASE, streams: 2, rows: 4, left: 0, error: null, retryAt: null });
    expect(await db.get('central_history')).toEqual(r);
    expect(await db.history('u-a')).toEqual([{ ts: T - 7201, value: 98 }, { ts: T - 3600, value: 99 }, { ts: T, value: 100 }]);
    expect(await db.needHistory()).toEqual([]);
    await backfillHistory({ db, central: f.central, now });
    expect(f.calls).toHaveLength(2); // once per stream
    await polled(['u-c'], T + 3600); // a stream first seen later
    await backfillHistory({ db, central: f.central, now });
    expect(f.calls.map((c) => c.stream_uuid)).toEqual(['u-a', 'u-b', 'u-c']);
  });

  test(`at most ${HISTORY_CONCURRENCY} calls at a time`, async () => {
    await polled(Array.from({ length: 11 }, (_, i) => `u-${i}`));
    const f = fakeCentral({ history: (u) => [row(u, T - 3600, 1)], delayMs: 20 });
    const slow = { ...db, addHistory: async (...a) => { await new Promise((r) => setTimeout(r, 30)); return db.addHistory(...a); } };
    expect(await backfillHistory({ db: slow, central: f.central, now })).toMatchObject({ streams: 11, rows: 11 }); // counted across overlapping calls
    expect(f.maxInFlight).toBe(HISTORY_CONCURRENCY);
  });

  test('404 "Not Found" (no history route on this central): quiet, no more calls, "unavailable" for a day, then tried again; another central is asked at once', async () => {
    await polled(Array.from({ length: 9 }, (_, i) => `u-${i}`));
    const f = fakeCentral();
    const warn = vi.spyOn(console, 'warn');
    const r = await backfillHistory({ db, central: f.central, now });
    expect(r).toEqual({ at: T + 0.5, url: BASE, streams: 0, rows: 0, left: 9, error: 'central 404: Not Found', retryAt: T + 0.5 + HISTORY_RETRY_S });
    expect(f.calls.length).toBe(HISTORY_CONCURRENCY); // the first ones in flight, nothing after
    expect(warn).not.toHaveBeenCalled();
    clock += HISTORY_RETRY_S - 10;
    await backfillHistory({ db, central: f.central, now });
    expect(f.calls.length).toBe(HISTORY_CONCURRENCY);
    const other = fakeCentral({ history: () => [] });
    const elsewhere = { ...other.central, url: 'https://other.test' }; // another URL (the setting changed): asked at once
    expect((await backfillHistory({ db, central: elsewhere, now })).streams).toBe(9);
    clock += 20;
    await db.resetCentral();
    await polled(['u-0']);
    await backfillHistory({ db, central: f.central, now });
    expect(f.calls.length).toBe(HISTORY_CONCURRENCY + 1);
    warn.mockRestore();
  });

  test('404 "Stream not found" (a stream central deleted, or a uuid it never had): that stream is done, the rest go on, nothing is held', async () => {
    const uuids = Array.from({ length: 12 }, (_, i) => `u-${String(i).padStart(2, '0')}`);
    await polled(uuids);
    const f = fakeCentral({ history: (u) => (u === 'u-01' ? json(404, { detail: `Stream not found: ${u}` }) : [row(u, T - 3600, 2)]) });
    const r = await backfillHistory({ db, central: f.central, now });
    expect(r).toMatchObject({ streams: 12, rows: 11, left: 0, error: null, retryAt: null });
    expect(await db.needHistory()).toEqual([]);
    expect(await db.history('u-01')).toEqual([{ ts: T, value: 100 }]);
    clock += 86_401;
    await backfillHistory({ db, central: f.central, now });
    expect(f.calls).toHaveLength(12); // once each, the missing one included
  });

  test('partial: malformed rows and other streams\' rows are dropped, a short list is fine; a failure stops the run and the rest wait for the next', async () => {
    await polled(['u-a', 'u-b', 'u-c']);
    const f = fakeCentral({ history: (u) => (u === 'u-b' ? json(500, { detail: 'boom' })
      : [row(u, T - 100, 'abc'), row(u, null, 5, { ts: null }), row('u-z', T - 50, 5), row(u, T - 3600, 7), { nonsense: true }, null]) });
    const r = await backfillHistory({ db, central: f.central, now });
    // the three are fetched at once: u-a and u-c land, u-b fails and waits for the next run
    expect(r).toMatchObject({ streams: 2, rows: 2, left: 1, error: 'central 500: boom', retryAt: null });
    expect(await db.history('u-a')).toEqual([{ ts: T - 3600, value: 7 }, { ts: T, value: 100 }]);
    expect(await db.history('u-z')).toEqual([]);
    expect(await db.needHistory()).toEqual(['u-b']);
    const ok = fakeCentral({ history: (u) => [row(u, T - 3600, 7)] });
    expect(await backfillHistory({ db, central: ok.central, now })).toMatchObject({ streams: 1, left: 0, error: null });
  });

  test('not a list: an error, retried next time', async () => {
    await polled(['u-a']);
    const f = fakeCentral({ history: () => json(200, { detail: 'odd' }) });
    expect(await backfillHistory({ db, central: f.central, now })).toMatchObject({ streams: 0, error: 'central sent no list of observations' });
    expect(await db.needHistory()).toEqual(['u-a']);
  });

  test('never throws (a database failure is logged and returned)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { ...db, needHistory: async () => { throw new Error('IO Error'); } };
    expect(await backfillHistory({ db: broken, central: fakeCentral().central, now })).toMatchObject({ error: 'IO Error' });
    error.mockRestore();
  });
});

describe('in the cycle', () => {
  test('backfilled rows never trigger a prediction; the poll\'s new row does, from the whole history', async () => {
    const f = fakeCentral({ history: (u) => Array.from({ length: 40 }, (_, k) => row(u, T - (40 - k) * 3600, 100 + k)).concat(row(u, T + 7200, 999)) });
    // u-old is in the stream list from an earlier poll but not in this batch: its history comes, no forecast
    await db.addObservations([{ stream_uuid: 'u-old', name: 'old', meta: null, ts: T - 200_000, value: 5 }]);
    f.batch = [entry('u-a', 'a', T, 140)];
    const r = await cycle({ db, central: f.central, now, seed: 'id' });
    expect(r.poll).toMatchObject({ streams: 1, new: 1, predicted: 1 });
    expect(f.sent).toEqual([[expect.objectContaining({ stream_uuid: 'u-a' })]]);
    expect((await db.history('u-a')).length).toBe(41); // 40 past rows + the poll's; not the one after it
    expect((await db.history('u-old')).length).toBe(1); // its history is all newer than its newest polled row
    expect(await db.predictions('old')).toEqual([]);
    // the row after the poll's (T + 2 h), which the backfill saw, comes with the next poll: new, so it is forecast
    f.batch = [entry('u-a', 'a', T + 7200, 999)];
    clock += 7200;
    expect((await cycle({ db, central: f.central, now, seed: 'id' })).poll).toMatchObject({ new: 1, predicted: 1 });
    expect(f.calls.map((c) => c.stream_uuid)).toEqual(['u-a', 'u-old']); // once per stream
  });

  test('a history route that 404s never breaks the poll', async () => {
    const f = fakeCentral();
    f.batch = [entry('u-a', 'a', T, 140)];
    const r = await cycle({ db, central: f.central, now, seed: 'id' });
    expect(r.poll).toMatchObject({ new: 1, predicted: 1 });
    expect(r.submit).toMatchObject({ successful: 1 });
    expect(await db.get('central_history')).toMatchObject({ error: 'central 404: Not Found', retryAt: T + 0.5 + HISTORY_RETRY_S });
  });
});
