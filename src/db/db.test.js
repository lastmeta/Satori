import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb, memoryConn } from './node.js';
import { MIGRATIONS } from './schema.js';
import { openDb } from './index.js';

vi.setConfig({ testTimeout: 60_000 });

let db;
beforeEach(async () => { db = await memoryDb(); });

const obs = (o) => ({ stream_uuid: 'u-btc', name: 'bitcoin', meta: null, ts: 1000, value: 1, ...o });
const pred = (o) => ({ stream_uuid: 'u-btc', made_at: 2000.5, model: 'ols-20', t1: 2, t2: 3,
  observed_at: '2000.5', hash: 'abcd', ...o });

test('migrations run and the version is stored', async () => {
  expect(db.version).toBe(MIGRATIONS.length);
  expect(await db.get('schema_version')).toBe(MIGRATIONS.length);
});

test('a database from a newer app version is refused, not migrated', async () => {
  const conn = await memoryConn();
  await (await openDb(conn)).set('schema_version', MIGRATIONS.length + 1);
  await expect(openDb(conn)).rejects.toThrow(/newer version/);
});

test('a step-2 database: the URL streams go, meta (the keys) stays', async () => {
  const conn = await memoryConn();
  await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
  await conn.query(MIGRATIONS[0]);
  await conn.query(`INSERT INTO meta VALUES ('schema_version', '1'), ('wallet_yaml', '"w"')`);
  await conn.query(`INSERT INTO streams VALUES ('BTC-USD', 'https://x', 'data.amount', 60, 1, NULL, NULL)`);
  const up = await openDb(conn);
  expect(up.version).toBe(MIGRATIONS.length);
  expect(await up.get('wallet_yaml')).toBe('w');
  expect(await up.streams()).toEqual([]);
});

test('meta holds JSON values', async () => {
  expect(await db.get('next_poll_at')).toBeUndefined();
  await db.set('x', { v: 1, ct: 'abc' });
  expect(await db.get('x')).toEqual({ v: 1, ct: 'abc' });
  await db.set('x', 2);
  expect(await db.get('x')).toBe(2);
});

describe('addObservations', () => {
  test('insert or ignore on (stream, whole second); returns the streams that got a new row', async () => {
    expect(await db.addObservations([obs(), obs({ stream_uuid: 'u-eth', name: 'eth', value: 5 })])).toEqual(['u-btc', 'u-eth']);
    expect(await db.addObservations([obs({ value: 99 }), obs({ stream_uuid: 'u-eth', name: 'eth', ts: 1001, value: 6 })]))
      .toEqual(['u-eth']);
    expect(await db.history('u-btc')).toEqual([{ ts: 1000, value: 1 }]); // the first value stays
    expect(await db.history('u-eth')).toEqual([{ ts: 1000, value: 5 }, { ts: 1001, value: 6 }]);
    expect(await db.addObservations([])).toEqual([]);
  });
  test("keeps each stream's latest name and meta", async () => {
    await db.addObservations([obs()]);
    await db.addObservations([obs({ ts: 2000, name: 'btc', meta: '{"unit":"USD"}' })]);
    expect(await db.rows('SELECT * FROM streams')).toEqual([{ uuid: 'u-btc', name: 'btc', meta: '{"unit":"USD"}' }]);
  });
  test('history is oldest first', async () => {
    await db.addObservations([obs({ ts: 3000, value: 3 }), obs({ ts: 1000, value: 1 }), obs({ ts: 2000, value: 2 })]);
    expect((await db.history('u-btc')).map((o) => o.value)).toEqual([1, 2, 3]);
  });
});

describe('predictions', () => {
  test('stored pending; pending() is oldest first with the stream name; markSent', async () => {
    await db.addObservations([obs(), obs({ stream_uuid: 'u-eth', name: 'eth' })]);
    const a = await db.addPrediction(pred());
    const b = await db.addPrediction(pred({ stream_uuid: 'u-eth', t2: 7 }));
    expect(b).toBeGreaterThan(a);
    expect(await db.pending()).toMatchObject([
      { id: a, stream_uuid: 'u-btc', name: 'bitcoin', t1: 2, t2: 3, observed_at: '2000.5', hash: 'abcd', status: 'pending' },
      { id: b, stream_uuid: 'u-eth', name: 'eth', t2: 7 },
    ]);
    expect(await db.pendingCount()).toBe(2);
    await db.markSent([a, b], 3000);
    expect(await db.pending()).toEqual([]);
    expect(await db.pendingCount()).toBe(0);
    expect(await db.predictions('bitcoin')).toMatchObject([{ id: a, status: 'sent', sent_at: 3000 }]);
    await db.markSent([], 4000); // nothing to do
  });
  test('predictions(stream) by uuid or name, newest first, with a limit', async () => {
    await db.addObservations([obs()]);
    for (const t2 of [1, 2, 3]) await db.addPrediction(pred({ t2 }));
    expect((await db.predictions('u-btc')).map((p) => p.t2)).toEqual([3, 2, 1]);
    expect((await db.predictions('bitcoin', 2)).map((p) => p.t2)).toEqual([3, 2]);
    expect(await db.predictions('nope')).toEqual([]);
  });
});

test('streams: one row per stream with its latest observation and prediction', async () => {
  await db.addObservations([obs(), obs({ ts: 2000, value: 2 }), obs({ stream_uuid: 'u-eth', name: 'eth' })]);
  await db.addPrediction(pred({ t2: 5 }));
  const id = await db.addPrediction(pred({ made_at: 2100, t1: 6, t2: 7 }));
  await db.markSent([id], 2200);
  const [btc, eth] = await db.streams();
  expect(btc).toMatchObject({ uuid: 'u-btc', name: 'bitcoin', observations: 2, obs_ts: 2000, obs_value: 2,
    t1: 6, t2: 7, model: 'ols-20', made_at: 2100, status: 'sent', sent_at: 2200 });
  expect(eth).toMatchObject({ uuid: 'u-eth', name: 'eth', observations: 1, t1: null, t2: null, status: null });
});

test('calls run in order even when not awaited', async () => {
  const writes = [1, 2, 3].map((i) => db.addObservations([obs({ ts: i, value: i })]));
  const read = db.history('u-btc');
  await Promise.all(writes);
  expect((await read).map((o) => o.value)).toEqual([1, 2, 3]);
});
