// Store: schema, migrations, settings, batch inserts, engine reads, self-test.
// Runs DuckDB-WASM's node blocking bundle in memory (same wasm as the browser).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createStore, migrate, openStore } from './index.js';
import { MIGRATIONS } from './schema.js';
import { nodeDuckDB } from './node.js';

let duck;
let store;
beforeAll(async () => { duck = await nodeDuckDB(); }, 60_000);
afterAll(() => duck?.db.reset());
beforeEach(async () => {
  duck.reset();
  store = await createStore(duck.connect());
});

const cols = async (table) =>
  (await store.rows(
    `SELECT column_name AS c, data_type AS t FROM information_schema.columns
     WHERE table_name = ? ORDER BY ordinal_position`, table))
    .map((r) => `${r.c} ${r.t}`);

const obs = (seq, extra = {}) => ({
  stream_name: 's1', provider_pubkey: 'base', seq_num: seq, observed_at: 1000 + seq,
  received_at: 2000 + seq, value_raw: String(seq * 1.5), value: seq * 1.5, round: 500 + seq, ...extra,
});

describe('schema (storage.md v1)', () => {
  test('creates exactly the v1 tables and columns', async () => {
    const tables = (await store.rows(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'main' ORDER BY 1"))
      .map((r) => r.t);
    expect(tables).toEqual(['base_submits', 'observations', 'predictions', 'schema_version', 'settings', 'stream_names']);
    expect(await cols('settings')).toEqual(['key VARCHAR', 'value VARCHAR']);
    expect(await cols('observations')).toEqual([
      'stream_name VARCHAR', 'provider_pubkey VARCHAR', 'seq_num BIGINT', 'observed_at DOUBLE',
      'received_at DOUBLE', 'value_raw VARCHAR', 'value DOUBLE', 'round BIGINT']);
    expect(await cols('stream_names')).toEqual([
      'stream_name VARCHAR', 'provider_pubkey VARCHAR', 'display_name VARCHAR', 'game_id INTEGER']);
    expect(await cols('predictions')).toEqual([
      'stream_name VARCHAR', 'provider_pubkey VARCHAR', 'observation_seq BIGINT', 't1 DOUBLE',
      't2 DOUBLE', 'model VARCHAR', 'created_at DOUBLE', 'submitted BOOLEAN']);
    expect(await cols('base_submits')).toEqual([
      'ts BIGINT', 'round BIGINT', 'tx_hash VARCHAR', 'games VARCHAR', 'status VARCHAR']);
  });

  test('records the schema version and reopening is a no-op', async () => {
    expect(await store.rows('SELECT version FROM schema_version')).toEqual([{ version: MIGRATIONS.length }]);
    await store.set('k', 1);
    const again = await createStore(duck.connect());
    expect(await again.rows('SELECT version FROM schema_version')).toEqual([{ version: MIGRATIONS.length }]);
    expect(await again.get('k')).toBe(1);
  });

  test('applies only newer migrations, in order', async () => {
    const conn = duck.connect();
    const extra = [...MIGRATIONS, 'CREATE TABLE m2 (a INTEGER)', 'ALTER TABLE m2 ADD COLUMN b INTEGER'];
    expect(await migrate(conn, extra)).toBe(extra.length);
    expect(await cols('m2')).toEqual(['a INTEGER', 'b INTEGER']);
    expect(await migrate(conn, extra)).toBe(extra.length);
  });

  test('a failing migration rolls back and leaves the version alone', async () => {
    const bad = [...MIGRATIONS, 'CREATE TABLE half (a INTEGER); SELECT * FROM no_such_table'];
    await expect(migrate(duck.connect(), bad)).rejects.toThrow(/no_such_table/);
    expect(await store.rows('SELECT version FROM schema_version')).toEqual([{ version: MIGRATIONS.length }]);
    expect(await store.rows("SELECT table_name FROM information_schema.tables WHERE table_name = 'half'")).toEqual([]);
  });

  test('extensions never autoload: a JSON column fails instead of fetching', async () => {
    await expect(store.run('CREATE TABLE j (x JSON)')).rejects.toThrow(/json/i);
  });
});

describe('settings', () => {
  test('missing key returns the fallback', async () => {
    expect(await store.get('central_poll_due')).toBeUndefined();
    expect(await store.get('central_poll_due', 0)).toBe(0);
  });

  test('values round-trip as JSON and overwrite', async () => {
    await store.set('central_poll_due', 1760000000000);
    await store.set('base_config_cache', { hub: '0xabc', n: [1, 2] });
    await store.set('central_poll_due', 1760000999000);
    expect(await store.get('central_poll_due')).toBe(1760000999000);
    expect(await store.get('base_config_cache')).toEqual({ hub: '0xabc', n: [1, 2] });
    expect(await store.rows("SELECT value FROM settings WHERE key = 'base_config_cache'"))
      .toEqual([{ value: '{"hub":"0xabc","n":[1,2]}' }]);
  });

  test('null deletes the key', async () => {
    await store.set('x', true);
    await store.set('x', null);
    expect(await store.get('x', 'gone')).toBe('gone');
  });
});

describe('insert', () => {
  test('ignores duplicate (stream, provider, seq) and (stream, provider, round)', async () => {
    expect(await store.insert('observations', [obs(1), obs(2)], 'ignore')).toBe(2);
    const n = await store.insert('observations', [
      obs(1),                    // same seq
      obs(3, { round: 501 }),    // same round as seq 1
      obs(4), obs(4),            // duplicate inside one batch
      obs(5, { provider_pubkey: 'central', round: null }),
    ], 'ignore');
    expect(n).toBe(2);
    expect((await store.rows('SELECT seq_num FROM observations ORDER BY seq_num')).map((r) => r.seq_num))
      .toEqual([1, 2, 4, 5]);
  });

  test('inserts a full registry page (768 rows) in one call', async () => {
    const rows = Array.from({ length: 768 }, (_, i) => obs(i + 1));
    expect(await store.insert('observations', rows, 'ignore')).toBe(768);
    expect(await store.rows('SELECT count(*) AS n, max(round) AS r FROM observations')).toEqual([{ n: 768, r: 1268 }]);
  });

  test('replace overwrites by primary key (stream_names)', async () => {
    await store.insert('stream_names', [{ stream_name: 'u1', provider_pubkey: 'central', display_name: 'BTC', game_id: null }]);
    await store.insert('stream_names', [{ stream_name: 'u1', provider_pubkey: 'central', display_name: 'BTCUSD', game_id: 7 }], 'replace');
    expect(await store.rows('SELECT * FROM stream_names'))
      .toEqual([{ stream_name: 'u1', provider_pubkey: 'central', display_name: 'BTCUSD', game_id: 7 }]);
  });

  test('plain insert of a duplicate key throws', async () => {
    const row = { stream_name: 'u1', provider_pubkey: 'central', display_name: 'a', game_id: 1 };
    await store.insert('stream_names', [row]);
    await expect(store.insert('stream_names', [row])).rejects.toThrow(/constraint/i);
  });

  test('predictions default to unsubmitted; rows come back as plain numbers', async () => {
    await store.insert('predictions', [
      { stream_name: 's1', provider_pubkey: 'base', observation_seq: 1760000000123, t1: 1.5, t2: 2.5, model: 'ses', created_at: 1.25 },
    ]);
    await store.run('UPDATE predictions SET submitted = true WHERE observation_seq = ?', 1760000000123);
    expect(await store.rows('SELECT * FROM predictions')).toEqual([{
      stream_name: 's1', provider_pubkey: 'base', observation_seq: 1760000000123, t1: 1.5, t2: 2.5,
      model: 'ses', created_at: 1.25, submitted: true,
    }]);
  });

  test('base_submits stores games as JSON text', async () => {
    await store.insert('base_submits', [{ ts: 1760000000, round: 20370, tx_hash: '0x1', games: JSON.stringify([[3, 1]]), status: 'sent' }]);
    expect(JSON.parse((await store.rows('SELECT games FROM base_submits'))[0].games)).toEqual([[3, 1]]);
  });

  test('rejects unknown tables and non-identifier columns', async () => {
    await expect(store.insert('nope', [{ a: 1 }])).rejects.toThrow(/table/);
    await expect(store.insert('settings', [{ 'key; DROP TABLE settings': 1 }])).rejects.toThrow(/column/);
  });

  test('empty batch is a no-op', async () => {
    expect(await store.insert('observations', [], 'ignore')).toBe(0);
  });
});

describe('values (engine read path)', () => {
  beforeEach(async () => {
    await store.insert('observations', [
      obs(3, { observed_at: 30, value: 3 }), obs(1, { observed_at: 10, value: 1 }),
      obs(2, { observed_at: 20, value: null }), obs(4, { observed_at: 40, value: 4 }),
      obs(5, { observed_at: 50, value: 5 }),
      obs(1, { stream_name: 's2', value: 99 }), obs(1, { provider_pubkey: 'central', value: 98 }),
    ], 'ignore');
  });

  test('numeric values for one stream in observed_at order, nulls skipped', async () => {
    const v = await store.values('s1', 'base');
    expect(v).toBeInstanceOf(Float64Array);
    expect([...v]).toEqual([1, 3, 4, 5]);
  });

  test('limit keeps the latest n, still oldest first', async () => {
    expect([...(await store.values('s1', 'base', 2))]).toEqual([4, 5]);
  });

  test('unknown stream gives an empty array', async () => {
    expect([...(await store.values('none', 'base'))]).toEqual([]);
  });
});

describe('serial queue', () => {
  test('a failed call does not block later calls', async () => {
    const bad = store.run('SELECT * FROM missing');
    const good = store.get('a', 'ok');
    await expect(bad).rejects.toThrow();
    expect(await good).toBe('ok');
  });
});

describe('openStore self-test', () => {
  test('persists a token across close and reopen, then returns a migrated store', async () => {
    let closes = 0;
    const open = async () => ({ conn: duck.connect(), close: async () => void closes++ });
    const s = await openStore({ open });
    expect(closes).toBe(1);
    expect(await s.get('selftest')).toMatch(/^\d+-/);
    await s.set('k', 'v');
    expect(await s.get('k')).toBe('v');
  });

  test('fails loudly when the reopened database lost the write', async () => {
    const open = async () => {
      duck.reset();
      return { conn: duck.connect(), close: async () => {} };
    };
    await expect(openStore({ open })).rejects.toThrow(/self-test/);
  });
});
