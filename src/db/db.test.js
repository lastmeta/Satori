import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb, memoryConn } from './node.js';
import { MIGRATIONS } from './schema.js';
import { openDb } from './index.js';

vi.setConfig({ testTimeout: 60_000 });

let db;
beforeEach(async () => { db = await memoryDb(); });

const btc = { name: 'BTC-USD', url: 'https://x/btc', path: 'data.amount', interval_s: 60, created_at: 1 };
const pred = (o) => ({ stream: 'BTC-USD', ts: 1000, target_ts: 61000, value: 10, model: 'ols-20',
  address: 'E1', message: 'm', signature: 's', ...o });

test('migrations run and the version is stored', async () => {
  expect(db.version).toBe(MIGRATIONS.length);
  expect(await db.get('schema_version')).toBe(MIGRATIONS.length);
});

test('a database from a newer app version is refused, not migrated', async () => {
  const conn = await memoryConn();
  await (await openDb(conn)).set('schema_version', MIGRATIONS.length + 1);
  await expect(openDb(conn)).rejects.toThrow(/newer version/);
});

test('meta holds JSON values', async () => {
  expect(await db.get('vault')).toBeUndefined();
  await db.set('vault', { v: 1, ct: 'abc' });
  expect(await db.get('vault')).toEqual({ v: 1, ct: 'abc' });
  await db.set('vault', { v: 2 });
  expect(await db.get('vault')).toEqual({ v: 2 });
});

describe('streams', () => {
  test('add, list, unique names, remove with its data', async () => {
    await db.addStream(btc);
    await db.addStream({ ...btc, name: 'ETH-USD', created_at: 2 });
    await expect(db.addStream(btc)).rejects.toThrow();
    expect((await db.streams()).map((s) => s.name)).toEqual(['BTC-USD', 'ETH-USD']);
    await db.addObservation('ETH-USD', 1, 2);
    await db.removeStream('ETH-USD');
    expect((await db.streams()).map((s) => s.name)).toEqual(['BTC-USD']);
    expect(await db.recent('ETH-USD', 5)).toEqual([]);
  });
  test('last error is set and cleared', async () => {
    await db.addStream(btc);
    await db.setError('BTC-USD', 'HTTP 500', 5);
    expect((await db.streams())[0]).toMatchObject({ last_error: 'HTTP 500', last_error_at: 5 });
    await db.setError('BTC-USD', null);
    expect((await db.streams())[0]).toMatchObject({ last_error: null, last_error_at: null });
  });
});

test('recent: latest n observations, oldest first, with their times', async () => {
  await db.addStream(btc);
  for (let i = 1; i <= 5; i++) await db.addObservation('BTC-USD', i * 1000, i * 10);
  expect(await db.recent('BTC-USD', 2)).toEqual([{ ts: 4000, value: 40 }, { ts: 5000, value: 50 }]);
  expect((await db.recent('BTC-USD', 99)).map((o) => o.value)).toEqual([10, 20, 30, 40, 50]);
});

test('predictions get ids and are marked published', async () => {
  await db.addStream(btc);
  const a = await db.addPrediction(pred());
  const b = await db.addPrediction(pred({ ts: 2000, value: 11 }));
  expect(b).toBeGreaterThan(a);
  await db.markPublished(b, 3000);
  const rows = await db.rows('SELECT id, published_at FROM predictions ORDER BY id');
  expect(rows).toEqual([{ id: a, published_at: null }, { id: b, published_at: 3000 }]);
});

test('summary: one row per stream with latest observation and prediction', async () => {
  await db.addStream(btc);
  await db.addStream({ ...btc, name: 'EMPTY', created_at: 2 });
  await db.addObservation('BTC-USD', 1000, 1);
  await db.addObservation('BTC-USD', 2000, 2);
  await db.addPrediction(pred({ ts: 1000, value: 1 }));
  const id = await db.addPrediction(pred({ ts: 2000, value: 3, signature: 'sig' }));
  await db.markPublished(id, 2500);
  const [s, e] = await db.summary();
  expect(s).toMatchObject({ name: 'BTC-USD', observations: 2, predictions: 2, obs_ts: 2000, obs_value: 2,
    pred_id: id, pred_value: 3, pred_signature: 'sig', pred_published_at: 2500 });
  expect(e).toMatchObject({ name: 'EMPTY', observations: 0, predictions: 0, obs_value: null, pred_value: null });
});

test('calls run in order even when not awaited', async () => {
  await db.addStream(btc);
  const writes = [1, 2, 3].map((i) => db.addObservation('BTC-USD', i, i));
  const read = db.recent('BTC-USD', 10);
  await Promise.all(writes);
  expect((await read).map((o) => o.value)).toEqual([1, 2, 3]);
});
