import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, statSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryDb, memoryConn } from '../../test/memory-db.js';
import { MIGRATIONS, ADDITIVE } from './schema.js';
import { openDb } from './index.js';
import { loadKeys, unlockWallet, wordsOf } from '../keys/index.js';
import { nostrPubkey } from '../nostr/event.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // DuckDB's wasm starts in the first beforeEach: slow on a busy box

let db;
beforeEach(async () => { db = await memoryDb(); });

const obs = (o) => ({ stream_uuid: 'u-btc', name: 'bitcoin', meta: null, ts: 1000, value: 1, ...o });
const pred = (o) => ({ stream_uuid: 'u-btc', made_at: 2000.5, model: 'bar1', t1: 2, t2: 3, phi: -0.25, weight: 0.75,
  observed_at: '2000.5', hash: 'abcd', ...o });
const addPrediction = async (d, p) => (await d.addPredictions([p]))[0];

test('migrations run and the version is stored', async () => {
  expect(db.version).toBe(MIGRATIONS.length);
  expect(await db.get('schema_version')).toBe(MIGRATIONS.length);
});

test('every commit is checkpointed at once: a database file keeps nothing in its WAL (storage.md#the-checkpoint-rule)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'satori-db-'));
  try {
    const path = join(dir, 'n.duckdb');
    const wal = () => (existsSync(`${path}.wal`) ? statSync(`${path}.wal`).size : 0);
    const conn = await memoryConn(path);
    const fileDb = await openDb(conn); // the migrations: before, DuckDB kept them in the WAL (6 kB)
    expect(wal()).toBe(0);
    await fileDb.set('central_url', 'w');
    await fileDb.addObservations([obs()]);
    await fileDb.addPredictions([pred(), pred({ t2: 4 })]);
    expect(wal()).toBe(0);
    expect((await conn.query("SELECT current_setting('checkpoint_threshold') AS t")).toArray()[0].toJSON().t).toBe('0 bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database from a newer app version is refused, not migrated, unless its later migrations are additive only', async () => {
  const conn = await memoryConn();
  const first = await openDb(conn);
  // what a reader must know: the migrations up to the last one that is not additive (schema.js ADDITIVE)
  const need = Math.max(...MIGRATIONS.map((_, i) => i + 1).filter((n) => !ADDITIVE.has(n)));
  expect(await first.get('schema_min')).toBe(need);
  expect(need).toBe(16); // 16: the keys record names its keys alias and wallet
  // a newer build ran two more migrations, both additive: this build opens it as it is (a rollback, an offline old cache)
  await first.set('schema_version', MIGRATIONS.length + 2);
  const newer = await openDb(conn);
  expect(newer.version).toBe(MIGRATIONS.length + 2);
  expect([await newer.get('schema_version'), await newer.get('schema_min')]).toEqual([MIGRATIONS.length + 2, need]); // nothing written
  await newer.set('central_url', 'w'); // and it works
  // one of them was not additive (the reader must know more than this build does), or an older newer build said nothing: refused
  for (const min of [MIGRATIONS.length + 1, undefined]) {
    if (min === undefined) await conn.query("DELETE FROM meta WHERE key = 'schema_min'");
    else await newer.set('schema_min', min);
    await expect(openDb(conn)).rejects.toThrow(`This database was written by a newer version of Satori (schema ${MIGRATIONS.length + 2}; `
      + `this version knows ${MIGRATIONS.length}) in a way this version can't read. Reload to get the newer version; offline, connect first.`);
  }
});

test('a step-2 database: the URL streams go, meta stays', async () => {
  const conn = await memoryConn();
  await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
  await conn.query(MIGRATIONS[0]);
  await conn.query(`INSERT INTO meta VALUES ('schema_version', '1'), ('central_url', '"w"')`);
  await conn.query(`INSERT INTO streams VALUES ('BTC-USD', 'https://x', 'data.amount', 60, 1, NULL, NULL)`);
  const up = await openDb(conn);
  expect(up.version).toBe(MIGRATIONS.length);
  expect(await up.get('central_url')).toBe('w');
  expect(await up.streams()).toEqual([]);
});

/** A database as the version that made `p` left it: its migrations, its meta rows (test/fixtures/profiles.json). */
async function profileConn(p) {
  const conn = await memoryConn();
  await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
  for (const m of MIGRATIONS.slice(0, p.schema)) await conn.query(m);
  const rows = { schema_version: p.schema, ...p.meta };
  for (const [k, v] of Object.entries(rows)) {
    const stmt = await conn.prepare('INSERT INTO meta VALUES (?, ?)');
    await stmt.query(k, JSON.stringify(v));
    await stmt.close();
  }
  return conn;
}

describe("migration 7: the keys move into this app's own record (meta `keys`), never losing one", () => {
  const { profiles } = JSON.parse(readFileSync(new URL('../../test/fixtures/profiles.json', import.meta.url)));
  const hexBytes = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
  for (const p of profiles) {
    test(p.label, async () => {
      const up = await openDb(await profileConn(p));
      expect(up.version).toBe(MIGRATIONS.length);
      const keys = await up.get('keys');
      if (p.expect.setup) {
        // never a neuron: Setup shows, and its rows are left as they are
        expect(keys).toBeUndefined();
        for (const [k, v] of Object.entries(p.meta)) expect(await up.get(k), k).toEqual(v);
        return;
      }
      expect(keys).toMatchObject({ v: 1, alias: p.expect.alias, wallet: { yaml: p.meta.vault_yaml } });
      if (p.expect.nostr) expect(keys.nostr).toBe(p.expect.nostr);
      else expect(nostrPubkey(keys.nostr)).toMatch(/^[0-9a-f]{64}$/);
      for (const k of ['wallet_yaml', 'vault_yaml', 'nostr_yaml']) expect(await up.get(k), k).toBeUndefined();
      expect(loadKeys(keys).alias.pubkey).toBeTruthy();
      // the wallet at its next Unlock, as main.js stores it
      const { wallet, record } = await unlockWallet(keys, p.passphrase);
      await up.set('keys', record);
      expect(wallet.backup().words).toBe(wordsOf(hexBytes(p.expect.wallet)));
      expect((await unlockWallet(await up.get('keys'), p.passphrase)).record).toBe(null);
    });
  }
  test("the step-1 prototype's meta.wallet is never touched, next to a later neuron's keys too", async () => {
    const step1 = profiles.find((x) => x.commit === '7be47fc');
    const later = profiles.find((x) => x.label.startsWith('step 5 on'));
    const up = await openDb(await profileConn({ ...later, meta: { ...later.meta, ...step1.meta } }));
    expect(await up.get('wallet')).toEqual(step1.meta.wallet);
    expect((await up.get('keys')).alias).toBe(later.expect.alias);
  });
  test('rows it cannot read stop the open: nothing is changed, and the version stays (the app says it could not start)', async () => {
    const later = profiles.find((x) => x.label.startsWith('step 5 on'));
    const conn = await profileConn({ ...later, meta: { ...later.meta, wallet_yaml: 'not: [a wallet' } });
    await expect(openDb(conn)).rejects.toThrow();
    const left = (await conn.query("SELECT key, value FROM meta ORDER BY key")).toArray().map((r) => r.toJSON());
    expect(Object.fromEntries(left.map((r) => [r.key, JSON.parse(r.value)])))
      .toEqual({ schema_version: later.schema, ...later.meta, wallet_yaml: 'not: [a wallet' });
  });
});

test('a step-3 database: predictions gain the engine\'s phi and weight (null on old rows)', async () => {
  const conn = await memoryConn();
  await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
  await conn.query(MIGRATIONS[0]);
  await conn.query(MIGRATIONS[1]);
  await conn.query(`INSERT INTO meta VALUES ('schema_version', '2')`);
  await conn.query(`INSERT INTO streams VALUES ('u-btc', 'bitcoin', NULL)`);
  await conn.query(`INSERT INTO predictions (stream_uuid, made_at, model, t1, t2, observed_at, hash)
    VALUES ('u-btc', 1, 'ols-20', 2, 3, '1.0', 'h')`);
  const up = await openDb(conn);
  expect(up.version).toBe(MIGRATIONS.length);
  await addPrediction(up, pred({ made_at: 5 }));
  await addPrediction(up, pred({ made_at: 6, model: 'naive', phi: undefined, weight: undefined }));
  expect((await up.predictions('u-btc')).map((p) => [p.model, p.phi, p.weight]))
    .toEqual([['naive', null, null], ['bar1', -0.25, 0.75], ['ols-20', null, null]]);
});

test('doubles come back bit for bit (DuckDB-WASM sends parameters as JSON, which it parses 1 ulp off now and then)', async () => {
  const xs = Array.from({ length: 400 }, (_, i) => 0.1 + i * 1e-7 + 1 / 3); // 17 significant digits: 1 in 12 was off
  await db.addObservations(xs.map((value, i) => obs({ ts: 1000 + i, value })));
  expect((await db.history('u-btc')).map((o) => o.value)).toEqual(xs);
  await db.addObservations([obs({ ts: 100_000 })]);
  await db.addHistories([{ uuid: 'u-btc', rows: xs.map((value, i) => ({ ts: 50_000 + i, value })) }], 1);
  expect((await db.history('u-btc')).slice(400, 800).map((o) => o.value)).toEqual(xs);
  for (const x of xs.slice(0, 120)) {
    await addPrediction(db, pred({ made_at: 1792000000 + x, t1: x, t2: x * 1000.123, phi: x / 7, weight: x / 3 }));
  }
  const ps = (await db.predictions('u-btc', 200)).reverse();
  expect(ps.map((p) => [p.made_at, p.t1, p.t2, p.phi, p.weight]))
    .toEqual(xs.slice(0, 120).map((x) => [1792000000 + x, x, x * 1000.123, x / 7, x / 3]));
  await db.markSent([ps[0].id], 1792000000 + xs[5]);
  expect((await db.predictions('u-btc', 200)).at(-1).sent_at).toBe(1792000000 + xs[5]);
  await db.saveSpecs(new Map([['u-btc', { spec: {}, score: xs[7], generation: 1, accepted: 0 }]]), 1);
  expect((await db.specs()).get('u-btc').score).toBe(xs[7]);
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
    expect(await db.streams()).toMatchObject([{ uuid: 'u-btc', name: 'btc', meta: '{"unit":"USD"}' }]);
  });
  test('names and meta are kept as given (commas, quotes, any script); in one batch a stream\'s second seen twice keeps its first value, the stream its last name', async () => {
    const meta = '{"unit":"USD","note":"a, b; \\"c\\" – 日本"}';
    expect(await db.addObservations([obs({ name: 'BTC, spot', meta }), obs({ value: 2, name: 'bitcoin, "spot"' }),
      obs({ stream_uuid: 'u,eth', name: 'éth – ∑', ts: 7 })])).toEqual(['u-btc', 'u,eth']);
    expect(await db.history('u-btc')).toEqual([{ ts: 1000, value: 1 }]);
    expect((await db.streams()).map((r) => [r.uuid, r.name, r.meta])).toEqual([['u-btc', 'bitcoin, "spot"', null], ['u,eth', 'éth – ∑', null]]);
  });
  test('history is oldest first', async () => {
    await db.addObservations([obs({ ts: 3000, value: 3 }), obs({ ts: 1000, value: 1 }), obs({ ts: 2000, value: 2 })]);
    expect((await db.history('u-btc')).map((o) => o.value)).toEqual([1, 2, 3]);
  });
});

describe('predictions', () => {
  test('stored pending; pending() is oldest first with the stream name; markSent', async () => {
    await db.addObservations([obs(), obs({ stream_uuid: 'u-eth', name: 'eth' })]);
    const a = await addPrediction(db, pred());
    const b = await addPrediction(db, pred({ stream_uuid: 'u-eth', t2: 7 }));
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
  test('addPredictions: a poll\'s predictions in one transaction (one checkpoint); their ids in order', async () => {
    await db.addObservations([obs(), obs({ stream_uuid: 'u-eth', name: 'eth' })]);
    const ids = await db.addPredictions([pred({ t2: 1 }), pred({ stream_uuid: 'u-eth', t2: 2 }), pred({ t2: 3 })]);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect((await db.pending()).map((p) => [p.id, p.t2])).toEqual([[ids[0], 1], [ids[1], 2], [ids[2], 3]]);
    expect(await db.addPredictions([])).toEqual([]);
    const [naive] = await db.addPredictions([pred({ model: 'naive', phi: null, weight: null, t2: 1 / 3, hash: 'h,1' })]);
    expect((await db.predictions('u-btc', 1))[0]).toMatchObject({ id: naive, model: 'naive', phi: null, weight: null, t2: 1 / 3, hash: 'h,1' });
  });
  test('unpredicted: the streams whose latest observation has no prediction made from it (obs_ts); a dropped prediction still counts', async () => {
    await db.addObservations([obs(), obs({ stream_uuid: 'u-eth', name: 'eth' })]);
    expect(await db.unpredicted()).toEqual(['u-btc', 'u-eth']);
    await db.addPredictions([pred({ obs_ts: 1000 })]);
    expect(await db.unpredicted()).toEqual(['u-eth']);
    await db.addHistories([{ uuid: 'u-btc', rows: [{ ts: 500, value: 0.5 }] }], 1); // an older row: the latest stays predicted
    expect(await db.unpredicted()).toEqual(['u-eth']);
    await db.addObservations([obs({ ts: 2000 })]); // a newer one is not
    expect(await db.unpredicted()).toEqual(['u-btc', 'u-eth']);
    await db.addPredictions([pred({ obs_ts: 2000 }), pred({ stream_uuid: 'u-eth', obs_ts: 1000 })]);
    expect(await db.unpredicted()).toEqual([]);
    await db.dropPending(1e10); // never sent, but made: Lite never predicts an observation twice
    expect(await db.unpredicted()).toEqual([]);
    await db.addPredictions([pred()]); // no obs_ts (not central's poll): changes nothing
    expect(await db.unpredicted()).toEqual([]);
  });
  test('predictions(stream) by uuid or name, newest first, with a limit', async () => {
    await db.addObservations([obs()]);
    for (const t2 of [1, 2, 3]) await addPrediction(db, pred({ t2 }));
    expect((await db.predictions('u-btc')).map((p) => p.t2)).toEqual([3, 2, 1]);
    expect((await db.predictions('bitcoin', 2)).map((p) => p.t2)).toEqual([3, 2]);
    expect(await db.predictions('nope')).toEqual([]);
  });
});

test('dropPending: only pending ones made before the cutoff', async () => {
  await db.addObservations([obs()]);
  const old = await addPrediction(db, pred({ made_at: 100 }));
  const sent = await addPrediction(db, pred({ made_at: 100 }));
  await db.markSent([sent], 150);
  const fresh = await addPrediction(db, pred({ made_at: 300 }));
  await db.dropPending(200);
  expect((await db.predictions('u-btc')).map((p) => p.id)).toEqual([fresh, sent]);
  expect(old).toBeLessThan(sent);
});

test('resetCentral: the pending queue, the stream list and the last poll/submission go; history and sent stay', async () => {
  await db.addObservations([obs()]);
  const sent = await addPrediction(db, pred());
  await db.markSent([sent], 3000);
  await addPrediction(db, pred({ t2: 9 }));
  await db.set('central_last_poll', { at: 1 });
  await db.set('central_last_submit', { at: 2 });
  await db.set('next_poll_at', 5);
  await db.resetCentral();
  expect(await db.pendingCount()).toBe(0);
  expect(await db.streams()).toEqual([]);
  expect(await db.get('central_last_poll')).toBeUndefined();
  expect(await db.get('central_last_submit')).toBeUndefined();
  expect(await db.get('next_poll_at')).toBe(5);
  expect(await db.history('u-btc')).toEqual([{ ts: 1000, value: 1 }]);
  await db.addObservations([obs({ ts: 2000 })]); // the same stream from the new central comes back with its history
  expect(await db.predictions('u-btc')).toMatchObject([{ id: sent, status: 'sent' }]);
});

test('streams: one row per stream with its latest observation and prediction', async () => {
  await db.addObservations([obs(), obs({ ts: 2000, value: 2 }), obs({ stream_uuid: 'u-eth', name: 'eth' })]);
  await addPrediction(db, pred({ t2: 5 }));
  const id = await addPrediction(db, pred({ made_at: 2100, t1: 6, t2: 7 }));
  await db.markSent([id], 2200);
  const [btc, eth] = await db.streams();
  expect(btc).toMatchObject({ uuid: 'u-btc', name: 'bitcoin', observations: 2, obs_ts: 2000, obs_value: 2,
    t1: 6, t2: 7, model: 'bar1', phi: -0.25, weight: 0.75, made_at: 2100, status: 'sent', sent_at: 2200 });
  expect(eth).toMatchObject({ uuid: 'u-eth', name: 'eth', observations: 1, t1: null, t2: null, status: null });
});

test('a step-8 database: a stream predicted before counts as predicted through its latest observation; one never predicted is due', async () => {
  const conn = await memoryConn();
  await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
  for (const m of MIGRATIONS.slice(0, 8)) if (typeof m === 'string') await conn.query(m); // 7 moves keys: none here
  await conn.query(`INSERT INTO meta VALUES ('schema_version', '8')`);
  await conn.query(`INSERT INTO streams VALUES ('u-btc', 'bitcoin', NULL, NULL), ('u-eth', 'eth', NULL, NULL)`);
  await conn.query(`INSERT INTO observations VALUES ('u-btc', 1000, 1), ('u-btc', 2000, 2), ('u-eth', 1000, 5)`);
  await conn.query(`INSERT INTO predictions (stream_uuid, made_at, model, t1, t2, observed_at, hash)
    VALUES ('u-btc', 1500, 'naive', 1, 1, '1500', 'h')`);
  const up = await openDb(conn);
  expect(up.version).toBe(MIGRATIONS.length);
  expect(await up.unpredicted()).toEqual(['u-eth']); // never predicted twice: u-btc's 2000 is not guessed at
});

test('a step-9 database: the activity log says staking in its earlier rows too (the feed never shows the old words)', async () => {
  const conn = await memoryConn();
  await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
  for (const m of MIGRATIONS.slice(0, 9)) if (typeof m === 'string') await conn.query(m);
  await conn.query(`INSERT INTO meta VALUES ('schema_version', '9')`);
  const rows = [ // as the earlier app wrote them

    ['wallet', 'ok', { action: 'delegate', text: 'Delegated to this neuron' }, null],
    ['wallet', 'ok', { action: 'undelegate', text: 'Stopped delegating' }, null],
    ['base', 'idle', { round: 8, skipped: 'no prediction power delegated to the identity' }, 'skip:no prediction power delegated to the identity'],
    ['wallet', 'ok', { action: 'claim', text: 'Claimed 3 SATORI' }, null],
  ];
  for (const [kind, level, data, mkey] of rows) {
    await conn.query(`INSERT INTO activity (ts, kind, level, data, mkey) VALUES (1000, '${kind}', '${level}', '${JSON.stringify(data)}', ${mkey ? `'${mkey}'` : 'NULL'})`);
  }
  const up = await openDb(conn);
  expect(up.version).toBe(MIGRATIONS.length);
  expect((await up.activity(0)).map((r) => [r.kind, r.data, r.mkey])).toEqual([
    ['wallet', { action: 'stake', text: 'Staked with this app' }, null],
    ['wallet', { action: 'unstake', text: 'Unstaked' }, null],
    ['base', { round: 8, skipped: 'nothing staked with this app' }, 'skip:nothing staked with this app'],
    ['wallet', { action: 'claim', text: 'Claimed 3 SATORI' }, null],
  ]);
});

test('a step-14 database: the activity log says "this app" in its earlier rows (the word neuron is phased out)', async () => {
  const conn = await memoryConn();
  await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
  for (const m of MIGRATIONS.slice(0, 14)) if (typeof m === 'string') await conn.query(m);
  await conn.query(`INSERT INTO meta VALUES ('schema_version', '14')`);
  const rows = [
    ['wallet', 'ok', { action: 'stake', text: 'Staked with this neuron' }, null],
    ['base', 'idle', { round: 8, skipped: 'nothing staked with this neuron' }, 'skip:nothing staked with this neuron'],
    ['wallet', 'ok', { action: 'claim', text: 'Claimed 3 SATORI' }, null],
  ];
  for (const [kind, level, data, mkey] of rows) {
    await conn.query(`INSERT INTO activity (ts, kind, level, data, mkey) VALUES (1000, '${kind}', '${level}', '${JSON.stringify(data)}', ${mkey ? `'${mkey}'` : 'NULL'})`);
  }
  const up = await openDb(conn);
  expect(up.version).toBe(MIGRATIONS.length);
  expect((await up.activity(0)).map((r) => [r.kind, r.data, r.mkey])).toEqual([
    ['wallet', { action: 'stake', text: 'Staked with this app' }, null],
    ['base', { round: 8, skipped: 'nothing staked with this app' }, 'skip:nothing staked with this app'],
    ['wallet', { action: 'claim', text: 'Claimed 3 SATORI' }, null],
  ]);
});

describe('bvar: specs and central history (migration 6)', () => {
  test('a step-6 database: streams gain history_at (null: not fetched yet), and model_specs starts empty', async () => {
    const conn = await memoryConn();
    await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
    for (const m of MIGRATIONS.slice(0, 5)) await conn.query(m);
    await conn.query(`INSERT INTO meta VALUES ('schema_version', '5')`);
    await conn.query(`INSERT INTO streams VALUES ('u-btc', 'bitcoin', NULL)`);
    await conn.query(`INSERT INTO observations VALUES ('u-btc', 1000, 1)`);
    const up = await openDb(conn);
    expect(up.version).toBe(MIGRATIONS.length);
    expect(await up.needHistory()).toEqual(['u-btc']);
    expect(await up.specs()).toEqual(new Map());
    expect(await up.streams()).toMatchObject([{ uuid: 'u-btc', observations: 1, spec: null, history_at: null }]);
  });

  test('migration 11: a spec stored before keeps its row; no-change\'s error and the influence are null until the next poll', async () => {
    const conn = await memoryConn();
    await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
    for (const m of MIGRATIONS.slice(0, 10)) if (typeof m === 'string') await conn.query(m);
    await conn.query(`INSERT INTO meta VALUES ('schema_version', '10')`);
    await conn.query(`INSERT INTO streams (uuid, name, meta) VALUES ('u-btc', 'bitcoin', NULL)`);
    await conn.query(`INSERT INTO model_specs VALUES ('u-btc', '{"companions":[],"lambda1":0.2,"lambda2":0.5}', 0.02, 3, 1, 4000)`);
    const up = await openDb(conn);
    expect(up.version).toBe(MIGRATIONS.length);
    expect((await up.specs()).get('u-btc')).toEqual({ spec: { companions: [], lambda1: 0.2, lambda2: 0.5 }, score: 0.02, persist: null,
      influence: null, generation: 3, accepted: 1, updated_at: 4000, fit_key: null, retrain: null });
  });

  test('migration 12: a spec stored before has no fit key (the training pass scores it again); a `_pred` before, no backtest', async () => {
    const conn = await memoryConn();
    await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
    for (const m of MIGRATIONS.slice(0, 11)) if (typeof m === 'string') await conn.query(m);
    await conn.query(`INSERT INTO meta VALUES ('schema_version', '11')`);
    await conn.query(`INSERT INTO streams (uuid, name, meta) VALUES ('u-btc', 'bitcoin', NULL)`);
    await conn.query(`INSERT INTO model_specs VALUES ('u-btc', '{"companions":[],"lambda1":0.2,"lambda2":0.5}', 0.02, 3, 1, 4000, 0.03, NULL)`);
    await conn.query(`INSERT INTO relay_streams (uuid, stream_name, provider_pubkey, name, active, subscribed_at, pred_created_at, pred_seq, p_seq, p_model)
      VALUES ('r-1', 'btc', 'e5', 'B', true, 1, 1, 2, 2, 'bar1')`);
    const up = await openDb(conn);
    expect(up.version).toBe(MIGRATIONS.length);
    expect((await up.specs()).get('u-btc')).toMatchObject({ score: 0.02, persist: 0.03, fit_key: null });
    expect((await up.streams())[0]).toMatchObject({ uuid: 'u-btc', fit_key: null });
    expect((await up.relayStreams())[0]).toMatchObject({ p_seq: 2, p_score: null, p_persist: null, p_tests: null });
  });

  test('migration 13: a spec stored before has no retrain asked (null)', async () => {
    const conn = await memoryConn();
    await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
    for (const m of MIGRATIONS.slice(0, 12)) if (typeof m === 'string') await conn.query(m);
    await conn.query(`INSERT INTO meta VALUES ('schema_version', '12')`);
    await conn.query(`INSERT INTO streams (uuid, name, meta) VALUES ('u-btc', 'bitcoin', NULL)`);
    await conn.query(`INSERT INTO model_specs VALUES ('u-btc', '{"companions":[],"lambda1":0.2,"lambda2":0.5}', 0.02, 3, 1, 4000, 0.03, NULL, 'k')`);
    const up = await openDb(conn);
    expect(up.version).toBe(MIGRATIONS.length);
    expect((await up.specs()).get('u-btc')).toMatchObject({ score: 0.02, fit_key: 'k', retrain: null });
    expect((await up.streams())[0]).toMatchObject({ uuid: 'u-btc', retrain: null });
  });

  test('centralHistories: every central stream\'s observations in one read, oldest first; another central\'s left out', async () => {
    await db.addObservations([obs({ ts: 2000, value: 2 }), obs({ ts: 1000, value: 1.5 }), obs({ stream_uuid: 'u-eth', name: 'eth', value: 5 })]);
    await db.addObservations([obs({ stream_uuid: 'u-old', name: 'old' })]);
    await db.resetCentral();
    await db.addObservations([obs({ ts: 3000, value: 3 }), obs({ stream_uuid: 'u-eth', name: 'eth', ts: 1500, value: 6 })]);
    expect(await db.centralHistories()).toEqual(new Map([
      ['u-btc', [{ ts: 1000, value: 1.5 }, { ts: 2000, value: 2 }, { ts: 3000, value: 3 }]],
      ['u-eth', [{ ts: 1000, value: 5 }, { ts: 1500, value: 6 }]],
    ]));
    expect(await db.centralHistories()).toBeInstanceOf(Map);
  });

  test('histories: some streams\' observations in one read (the Models tab\'s drill-in), oldest first; none: empty', async () => {
    await db.addObservations([obs({ ts: 2000, value: 2 }), obs({ ts: 1000, value: 1.5 }), obs({ stream_uuid: 'u-eth', name: 'eth', value: 5 }),
      obs({ stream_uuid: 'u-oil', name: 'oil', value: 7 })]);
    expect(await db.histories(['u-eth', 'u-btc', 'u-none'])).toEqual(new Map([
      ['u-eth', [{ ts: 1000, value: 5 }]], ['u-btc', [{ ts: 1000, value: 1.5 }, { ts: 2000, value: 2 }]], ['u-none', []]]));
    expect(await db.histories([])).toEqual(new Map());
  });

  test('addHistories: only rows older than the newest polled one (a poll\'s new row stays new), insert or ignore; marks the stream', async () => {
    await db.addObservations([obs({ ts: 5000, value: 50 }), obs({ stream_uuid: 'u-eth', name: 'eth' })]);
    const rows = [{ ts: 3000, value: 30 }, { ts: 4000, value: 40 }, { ts: 5000, value: 99 }, { ts: 6000, value: 60 }];
    expect(await db.addHistories([{ uuid: 'u-btc', rows }], 7000)).toBe(2);
    expect(await db.history('u-btc')).toEqual([{ ts: 3000, value: 30 }, { ts: 4000, value: 40 }, { ts: 5000, value: 50 }]);
    expect(await db.needHistory()).toEqual(['u-eth']);
    expect(await db.addHistories([{ uuid: 'u-btc', rows }], 7001)).toBe(0); // again: ignored
    // the next poll brings 6000: new, so it is forecast
    expect(await db.addObservations([obs({ ts: 6000, value: 60 })])).toEqual(['u-btc']);
    expect((await db.streams())[0]).toMatchObject({ uuid: 'u-btc', history_at: 7001, observations: 4 });
  });

  test('addHistories: several streams in one transaction, each only older than its own newest row; one with no rows is marked fetched', async () => {
    await db.addObservations([obs({ ts: 5000 }), obs({ stream_uuid: 'u-eth', name: 'eth', ts: 3000 }), obs({ stream_uuid: 'u-sol', name: 'sol' })]);
    const rows = [{ ts: 2000, value: 20 }, { ts: 4000, value: 40 }];
    expect(await db.addHistories([{ uuid: 'u-btc', rows }, { uuid: 'u-eth', rows }, { uuid: 'u-sol', rows: [] }], 9000)).toBe(3);
    expect(await db.history('u-btc')).toEqual([{ ts: 2000, value: 20 }, { ts: 4000, value: 40 }, { ts: 5000, value: 1 }]);
    expect(await db.history('u-eth')).toEqual([{ ts: 2000, value: 20 }, { ts: 3000, value: 1 }]);
    expect(await db.needHistory()).toEqual([]);
    expect((await db.streams()).map((r) => r.history_at)).toEqual([9000, 9000, 9000]);
    expect(await db.addHistories([], 9001)).toBe(0);
  });

  test('addHistories: 12,000 rows of 3 streams (more than one statement) all land', async () => {
    await db.addObservations(['u-a', 'u-b', 'u-c'].map((u) => obs({ stream_uuid: u, name: u, ts: 1e8 })));
    const rows = Array.from({ length: 4000 }, (_, i) => ({ ts: 1000 + i, value: i / 7 }));
    expect(await db.addHistories(['u-a', 'u-b', 'u-c'].map((uuid) => ({ uuid, rows })), 1)).toBe(12_000);
    expect((await db.history('u-c')).slice(0, 4000)).toEqual(rows);
  });

  test('addHistories: many rows (one statement), floats exactly as given', async () => {
    await db.addObservations([obs({ ts: 10_000_000 })]);
    const rows = Array.from({ length: 1000 }, (_, i) => ({ ts: 1000 + i * 3600, value: 0.1 + i * 1e-7 + 1 / 3 }));
    expect(await db.addHistories([{ uuid: 'u-btc', rows }], 1)).toBe(1000);
    expect((await db.history('u-btc')).slice(0, 1000)).toEqual(rows);
  });

  test('specs: saved and read back; resetCentral drops them (another central\'s uuids)', async () => {
    await db.addObservations([obs(), obs({ stream_uuid: 'u-eth', name: 'eth' })]);
    const spec = { companions: ['u-eth'], lambda1: 0.2, lambda2: 0.5 };
    await db.saveSpecs(new Map([['u-btc', { spec, score: 0.0123, persist: 0.0125, influence: [0.75, 0.25], generation: 3, accepted: 1 }],
      ['u-eth', { spec: { ...spec, companions: ['u-btc'] }, score: null, persist: null, influence: null, generation: 0, accepted: 0 }]]), 4000);
    const shares = [0.6 + 1e-17, 0.4 - 1 / 3e9]; // doubles kept bit for bit
    await db.saveSpecs(new Map([['u-btc', { spec, score: 0.0122, persist: 0.0121, influence: shares, generation: 4, accepted: 1 }]]), 4100);
    expect(await db.specs()).toEqual(new Map([
      ['u-btc', { spec, score: 0.0122, persist: 0.0121, influence: shares, generation: 4, accepted: 1, updated_at: 4100, fit_key: null, retrain: null }],
      ['u-eth', { spec: { ...spec, companions: ['u-btc'] }, score: null, persist: null, influence: null, generation: 0, accepted: 0, updated_at: 4000,
        fit_key: null, retrain: null }],
    ]));
    expect((await db.streams())[0]).toMatchObject({ spec: JSON.stringify(spec), score: 0.0122, persist: 0.0121,
      influence: JSON.stringify(shares), generation: 4, accepted: 1 });
    await db.saveSpecs(new Map([['u-btc', { spec, score: 0.0122, persist: 0.0121, influence: shares, generation: 4, accepted: 1, fit_key: 'k1' }]]), 4200);
    expect((await db.specs()).get('u-btc').fit_key).toBe('k1');
    expect((await db.streams())[0].fit_key).toBe('k1');
    await db.set('central_history', { at: 1 });
    await db.resetCentral();
    expect(await db.specs()).toEqual(new Map());
    expect(await db.get('central_history')).toBeUndefined();
  });
});

test('calls run in order even when not awaited', async () => {
  const writes = [1, 2, 3].map((i) => db.addObservations([obs({ ts: i, value: i })]));
  const read = db.history('u-btc');
  await Promise.all(writes);
  expect((await read).map((o) => o.value)).toEqual([1, 2, 3]);
});

describe('saveFits: the training pass\'s results (docs/design/models.md#the-training-pass)', () => {
  test('score, no change\'s error, influence and the fit key, only where the spec is still the one fit; the spec and its counts untouched', async () => {
    await db.addObservations([obs(), obs({ stream_uuid: 'u-eth', name: 'eth' }), obs({ stream_uuid: 'u-oil', name: 'oil' })]);
    const spec = { companions: ['u-eth'], lambda1: 0.2, lambda2: 0.5 };
    const other = { companions: ['u-btc'], lambda1: 0.1, lambda2: 1 };
    await db.saveSpecs(new Map([['u-btc', { spec, score: 0.02, persist: null, influence: null, generation: 3, accepted: 1 }],
      ['u-eth', { spec: other, score: 0.05, persist: null, influence: null, generation: 7, accepted: 2 }]]), 4000);
    const shares = [0.7 + 1e-17, 0.3];
    const n = await db.saveFits([
      { uuid: 'u-btc', spec: JSON.stringify(spec), score: 0.019, persist: 0.021, influence: shares, fit_key: 'k-btc' },
      { uuid: 'u-eth', spec: JSON.stringify(spec), score: 0.5, persist: 0.5, influence: null, fit_key: 'k-eth' }, // a poll changed it meanwhile
      { uuid: 'u-oil', spec: JSON.stringify(spec), score: 0.5, persist: 0.5, influence: null, fit_key: 'k-oil' }, // no spec: nothing
    ], 5000);
    expect(n).toBe(1);
    expect(await db.specs()).toEqual(new Map([
      ['u-btc', { spec, score: 0.019, persist: 0.021, influence: shares, generation: 3, accepted: 1, updated_at: 5000, fit_key: 'k-btc', retrain: null }],
      ['u-eth', { spec: other, score: 0.05, persist: null, influence: null, generation: 7, accepted: 2, updated_at: 4000, fit_key: null, retrain: null }],
    ]));
    expect(await db.saveFits([], 1)).toBe(0);
    expect(await db.pendingCount()).toBe(0); // never a prediction
  });
});

describe('Retrain (docs/design/models.md#retrain): the request, its progress and its result, kept with the spec', () => {
  const spec = { companions: ['u-eth'], lambda1: 0.2, lambda2: 0.5 };
  const seed = async () => {
    await db.addObservations([obs(), obs({ stream_uuid: 'u-eth', name: 'eth' }), obs({ stream_uuid: 'u-oil', name: 'oil' })]);
    await db.saveSpecs(new Map([['u-btc', { spec, score: 0.02, persist: 0.019, influence: [0.6, 0.4], generation: 3, accepted: 1, fit_key: 'k1' }]]), 4000);
  };

  test('setRetrain: kept as JSON on the spec\'s row (specs(), streams()); null clears it; no spec: nothing', async () => {
    await seed();
    const r = { n: 1, status: 'running', asked_at: 4100, state: { tried: 20, best: spec } };
    expect(await db.setRetrain('u-btc', r)).toBe(1);
    expect((await db.specs()).get('u-btc')).toMatchObject({ spec, generation: 3, retrain: r });
    expect((await db.streams()).find((x) => x.uuid === 'u-btc').retrain).toBe(JSON.stringify(r));
    expect(await db.setRetrain('u-oil', r)).toBe(0); // no spec yet
    expect(await db.setRetrain('u-btc', null)).toBe(1);
    expect((await db.specs()).get('u-btc').retrain).toBeNull();
  });

  test('saveRetrained: the new champion with its fit, generation + 1, accepted + 1, the summary; only where the spec is still the one compared with', async () => {
    await seed();
    const found = { companions: [], lambda1: 0.2, lambda2: 0.5, algorithm: 'bar1' };
    const summary = { n: 1, status: 'done', result: { outcome: 'found', kept: 'new', ratio: 0.8 } };
    const row = { uuid: 'u-btc', from: JSON.stringify(spec), spec: found, score: 0.015, persist: 0.019, influence: null, fit_key: 'k2', retrain: summary };
    expect(await db.saveRetrained({ ...row, from: JSON.stringify({ ...spec, lambda1: 0.5 }) }, 5000)).toBe(0); // a poll evolved it meanwhile
    expect((await db.specs()).get('u-btc')).toMatchObject({ spec, generation: 3, accepted: 1, retrain: null });
    expect(await db.saveRetrained(row, 5000)).toBe(1);
    expect((await db.specs()).get('u-btc')).toEqual({ spec: found, score: 0.015, persist: 0.019, influence: null, generation: 4, accepted: 2,
      updated_at: 5000, fit_key: 'k2', retrain: summary });
    // a poll's store afterwards keeps the retrain's summary (it writes only its own columns)
    await db.saveSpecs(new Map([['u-btc', { spec: found, score: 0.016, persist: 0.019, influence: null, generation: 5, accepted: 2 }]]), 6000);
    expect((await db.specs()).get('u-btc')).toMatchObject({ generation: 5, retrain: summary });
    expect(await db.pendingCount()).toBe(0); // never a prediction
  });
});

describe('relay streams (Nostr), apart from central', () => {
  const sub = (o) => ({ uuid: 'r-1', stream_name: 'btc', provider_pubkey: 'e5', name: 'Bitcoin', cadence_seconds: 900, now: 100, ...o });
  const robs = (o) => ({ stream_uuid: 'r-1', seq: 1, ts: 1000, value: 5, raw: '"5"', event_id: 'e1', received_at: 1001, ...o });

  test('a step-4 database gains the relay tables; central data stays', async () => {
    const conn = await memoryConn();
    await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
    for (const m of MIGRATIONS.slice(0, 3)) await conn.query(m);
    await conn.query(`INSERT INTO meta VALUES ('schema_version', '3')`);
    await conn.query(`INSERT INTO streams VALUES ('u-btc', 'bitcoin', NULL)`);
    const up = await openDb(conn);
    expect(up.version).toBe(MIGRATIONS.length);
    expect(await up.streams()).toMatchObject([{ uuid: 'u-btc' }]);
    expect(await up.relayStreams()).toEqual([]);
  });

  test('a step-5 database: each stream gets its latest observation, latest prediction and count kept on its row', async () => {
    const conn = await memoryConn();
    await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
    for (const m of MIGRATIONS.slice(0, 4)) await conn.query(m);
    await conn.query(`INSERT INTO meta VALUES ('schema_version', '4')`);
    await conn.query(`INSERT INTO relay_streams VALUES ('r-1', 'btc', 'e5', 'B', 900, NULL, true, 1, NULL, 1, 2),
      ('r-2', 'eth', 'e5', 'E', 900, NULL, true, 1, NULL, 1, 0)`);
    await conn.query(`INSERT INTO relay_observations VALUES ('r-1', 7, 70, 7.5, '"7.5"', 'e7', 71), ('r-1', 9, 90, 9.5, '"9.5"', 'e9', 91),
      ('r-1', 8, 80, 8.5, '"8.5"', 'e8', 92)`);
    await conn.query(`INSERT INTO relay_predictions VALUES ('r-1', 1, '7.5', 'naive', 7, 71, 'p1', 1), ('r-1', 2, '9.5', 'naive', 9, 91, 'p2', 2)`);
    const up = await openDb(conn);
    expect(up.version).toBe(MIGRATIONS.length);
    const [btc, eth] = await up.relayStreams(); // the same subscribed_at: by uuid
    expect(btc).toMatchObject({ uuid: 'r-1', observations: 3, obs_seq: 9, obs_ts: 90, obs_value: 9.5, obs_raw: '"9.5"',
      obs_received_at: 91, p_seq: 2, p_value: '9.5', p_model: 'naive', p_made_at: 91, p_relays: 2, pred_seq: 2 });
    expect(eth).toMatchObject({ uuid: 'r-2', observations: 0, obs_seq: null, p_seq: null });
  });

  test('the latest observation is the highest seq, whatever order they arrive in', async () => {
    await db.subscribeRelay(sub());
    await db.addRelayObservation(robs({ seq: 5, value: 5, event_id: 'e5' }));
    await db.addRelayObservation(robs({ seq: 3, value: 3, event_id: 'e3' }));
    expect(await db.relayStream('r-1')).toMatchObject({ observations: 2, obs_seq: 5, obs_value: 5 });
  });

  test('subscribe, unsubscribe, subscribe again: the row stays, so do pred_created_at and the seq', async () => {
    expect(await db.subscribeRelay(sub())).toMatchObject({ uuid: 'r-1', active: true, subscribed_at: 100,
      pred_created_at: 100, pred_seq: 0, name: 'Bitcoin', cadence_seconds: 900 });
    expect(await db.countActiveRelay()).toBe(1);
    expect(await db.nextPredSeq('r-1')).toBe(1);
    expect(await db.nextPredSeq('r-1')).toBe(2);
    await db.unsubscribeRelay('r-1');
    expect(await db.relayStream('r-1')).toMatchObject({ active: false });
    expect(await db.countActiveRelay()).toBe(0);
    expect(await db.relayStreams({ active: true })).toEqual([]);
    expect(await db.subscribeRelay(sub({ now: 300, name: 'BTC', cadence_seconds: null }))).toMatchObject({
      active: true, subscribed_at: 300, pred_created_at: 100, pred_seq: 2, name: 'BTC', cadence_seconds: null });
    expect(await db.nextPredSeq('r-1')).toBe(3);
    expect(await db.relayStream('nope')).toBeNull();
  });

  test('observations: insert or ignore on the event id and on (stream, seq); history is numeric rows, oldest first', async () => {
    await db.subscribeRelay(sub());
    expect(await db.addRelayObservation(robs())).toBe(true);
    expect(await db.addRelayObservation(robs())).toBe(false); // the same event from another relay
    expect(await db.addRelayObservation(robs({ event_id: 'e2' }))).toBe(false); // a new event, the same seq
    expect(await db.addRelayObservation(robs({ seq: 2 }))).toBe(false); // the same event id, another seq
    expect(await db.addRelayObservation(robs({ seq: 3, ts: 900, value: 4, event_id: 'e3' }))).toBe(true);
    expect(await db.addRelayObservation(robs({ seq: 4, ts: 1100, value: null, raw: '"abc"', event_id: 'e4' }))).toBe(true);
    expect(await db.addRelayObservation(robs({ seq: 5, ts: null, value: 7, event_id: 'e5' }))).toBe(true);
    expect(await db.relayHistory('r-1')).toEqual([{ ts: 900, value: 4 }, { ts: 1000, value: 5 }]);
    expect(await db.history('r-1')).toEqual([]); // central's table is untouched
    expect(await db.streams()).toEqual([]);
  });

  test("the engine's window: relayHistory(uuid, seconds) reads only what is that close to the stream's newest time", async () => {
    await db.subscribeRelay(sub());
    for (let k = 0; k < 10; k++) await db.addRelayObservation(robs({ seq: k, ts: 1000 + k * 60, value: k, event_id: `e${k}` }));
    expect((await db.relayHistory('r-1', 180)).map((p) => p.value)).toEqual([6, 7, 8, 9]); // 1540 − 180 = 1360 on
    expect(await db.relayHistory('r-1')).toHaveLength(10); // no window: all of it
  });

  test("pruneRelay: each relay stream's rows older than its window (buckets × its cadence; a day without one) go, in batches", async () => {
    await db.subscribeRelay(sub()); // cadence 900
    await db.subscribeRelay(sub({ uuid: 'r-2', stream_name: 'eth', cadence_seconds: null }));
    for (let k = 0; k < 30; k++) await db.addRelayObservation(robs({ seq: k, ts: 100_000 + k * 900, value: k, event_id: `a${k}` }));
    for (let k = 0; k < 5; k++) await db.addRelayObservation(robs({ stream_uuid: 'r-2', seq: k, ts: 100_000 + k * 86_400, value: k, event_id: `b${k}` }));
    await db.addRelayObservation(robs({ seq: 99, ts: null, value: 1, event_id: 'a99', received_at: 1 })); // no time of its own: its arrival's
    expect(await db.pruneRelay({ buckets: 10, batch: 4 })).toBe(19 + 1); // r-1 keeps ts ≥ newest − 9000 (and the timeless row goes); r-2 all
    expect((await db.relayHistory('r-1')).map((p) => p.value)).toEqual([19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect((await db.relayHistory('r-2')).map((p) => p.value)).toEqual([0, 1, 2, 3, 4]); // 4 days: all inside 10
    expect(await db.pruneRelay({ buckets: 10, batch: 4 })).toBe(0);
    expect(await db.relayStream('r-1')).toMatchObject({ observations: 31, obs_seq: 99 }); // the count is what was received
  });

  test('pruneRelay: the window is counted back from the newest time not in the future; a far-future row (more than max(cadence, 300 s) ahead) goes', async () => {
    await db.subscribeRelay(sub()); // cadence 900
    const now = 1_792_000_000;
    for (let k = 0; k < 20; k++) await db.addRelayObservation(robs({ seq: k, ts: now - (19 - k) * 900, value: k, event_id: `a${k}` }));
    await db.addRelayObservation(robs({ seq: 20, ts: now + 600, value: 20, event_id: 'a20' })); // a little ahead: kept, not the newest
    await db.addRelayObservation(robs({ seq: 21, ts: 4_000_000_000, value: 21, event_id: 'a21' })); // stamped 2096: stored before the guard
    expect(await db.pruneRelay({ buckets: 10, now })).toBe(9 + 1); // keeps ts ≥ now − 9000, and the 2096 row goes
    expect((await db.relayHistory('r-1')).map((p) => p.value)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  test("relayStreams: each with its latest observation and our latest _pred", async () => {
    await db.subscribeRelay(sub());
    await db.subscribeRelay(sub({ uuid: 'r-2', stream_name: 'eth', name: 'Ether', now: 150 }));
    await db.addRelayObservation(robs());
    await db.addRelayObservation(robs({ seq: 9, ts: 2000, value: 6, raw: '"6"', event_id: 'e9', received_at: 2001 }));
    await db.addRelayPrediction({ stream_uuid: 'r-1', seq: 1, value: '5.0', model: 'naive', obs_seq: 1, made_at: 1002, event_id: 'p1', relays: 1 });
    await db.addRelayPrediction({ stream_uuid: 'r-1', seq: 2, value: '6.5', model: 'bar1', obs_seq: 9, made_at: 2002, event_id: 'p2', relays: 2,
      score: 0.011, persist: 0.012, tests: 9 });
    const [eth, btc] = await db.relayStreams();
    expect(btc).toMatchObject({ uuid: 'r-1', stream_name: 'btc', active: true, observations: 2, obs_seq: 9, obs_ts: 2000,
      obs_value: 6, obs_raw: '"6"', obs_received_at: 2001, p_seq: 2, p_value: '6.5', p_model: 'bar1', p_made_at: 2002,
      p_relays: 2, p_score: 0.011, p_persist: 0.012, p_tests: 9 }); // its backtest, made with it
    // the training pass: a `_pred` kept before its backtest was, scored later; only the latest one
    await db.setRelayFit('r-1', 1, { score: 1, persist: 1, tests: 1 });
    expect((await db.relayStream('r-1'))).toMatchObject({ p_seq: 2, p_score: 0.011, p_tests: 9 });
    await db.setRelayFit('r-1', 2, { score: 0.02, persist: 0.03, tests: 0 });
    expect((await db.relayStream('r-1'))).toMatchObject({ p_seq: 2, p_score: 0.02, p_persist: 0.03, p_tests: 0 });
    expect(eth).toMatchObject({ uuid: 'r-2', observations: 0, obs_value: null, p_value: null });
    expect((await db.relayPredictions('r-1', 1)).map((p) => p.value)).toEqual(['6.5']);
    await db.setPredictionRelays('r-1', 2, 3); // the relays' OKs come after the row is kept
    expect((await db.relayStreams()).find((r) => r.uuid === 'r-1')).toMatchObject({ p_seq: 2, p_relays: 3 });
    await db.unsubscribeRelay('r-2', 3000);
    expect((await db.relayStreams({ active: true })).map((r) => r.uuid)).toEqual(['r-1']);
  });
});

describe('the activity log (migration 8; docs/design/health.md)', () => {
  test('a step-7 database gains the activity table, empty; nothing else changes', async () => {
    const conn = await memoryConn();
    await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
    for (const m of MIGRATIONS.slice(0, 6)) await conn.query(m);
    await conn.query(`INSERT INTO meta VALUES ('schema_version', '7'), ('central_url', '"w"')`);
    const up = await openDb(conn);
    expect(up.version).toBe(MIGRATIONS.length);
    expect(await up.get('central_url')).toBe('w');
    expect(await up.activity(0)).toEqual([]);
  });

  test('add, read back oldest first with data parsed, update a row, since a time', async () => {
    const a = await db.addActivity({ at: 100.5, kind: 'open', level: 'ok', data: { gap: null, missed: false }, until: 100.5 });
    const b = await db.addActivity({ at: 200, kind: 'central', level: 'bad', data: { error: 'central 500: boom', sent: 2 } });
    expect(b).toBeGreaterThan(a);
    expect(await db.activity(0)).toEqual([
      { id: a, at: 100.5, until: 100.5, kind: 'open', level: 'ok', data: { gap: null, missed: false }, count: 1, mkey: null },
      { id: b, at: 200, until: null, kind: 'central', level: 'bad', data: { error: 'central 500: boom', sent: 2 }, count: 1, mkey: null },
    ]);
    await db.updateActivity(a, { until: 400.25 });
    await db.updateActivity(b, { count: 3, data: { error: 'x' }, level: 'warn', until: 500 });
    const [ra, rb] = await db.activity(0);
    expect(ra).toMatchObject({ id: a, until: 400.25, data: { gap: null, missed: false }, count: 1 });
    expect(rb).toMatchObject({ id: b, until: 500, data: { error: 'x' }, level: 'warn', count: 3 });
    expect((await db.activity(150)).map((r) => r.id)).toEqual([a, b]); // started, or last changed, since then
    expect((await db.activity(450)).map((r) => r.id)).toEqual([b]);
  });

  test('firstSession: when the oldest session in the log began, or null', async () => {
    expect(await db.firstSession()).toBe(null);
    await db.addActivity({ at: 50, kind: 'central', level: 'ok', data: {} }); // not a session
    await db.addActivity({ at: 300, kind: 'open', level: 'ok', data: {}, until: 400 });
    await db.addActivity({ at: 100.5, kind: 'open', level: 'ok', data: {}, until: 200 });
    expect(await db.firstSession()).toBe(100.5);
  });

  test('prune: rows that ended before the cutoff go; resetCentral keeps the log (it is this neuron\'s)', async () => {
    await db.addActivity({ at: 10, kind: 'open', level: 'ok', data: {}, until: 20 });
    await db.addActivity({ at: 10, kind: 'base', level: 'bad', data: {}, until: 90, mkey: 'e' });
    await db.addActivity({ at: 50, kind: 'central', level: 'ok', data: {} });
    await db.pruneActivity(30);
    expect((await db.activity(0)).map((r) => [r.kind, r.mkey])).toEqual([['base', 'e'], ['central', null]]);
    await db.resetCentral();
    expect(await db.activity(0)).toHaveLength(2);
  });
});

test("sparks: each central stream's last n observations, oldest first (Home's trend lines)", async () => {
  await db.addObservations([obs({ ts: 1, value: 1 }), obs({ ts: 2, value: 2 }), obs({ ts: 3, value: 3 }),
    obs({ stream_uuid: 'u-eth', name: 'eth', ts: 5, value: 9 })]);
  expect(await db.sparks(2)).toEqual({ 'u-btc': [2, 3], 'u-eth': [9] });
  expect(await db.sparks()).toEqual({ 'u-btc': [1, 2, 3], 'u-eth': [9] });
});

describe('the track record (migration 14; docs/design/track-record.md)', () => {
  const ws = (o) => ({ uuid: 'w-p', pubkey: 'aa', stream_name: 'btc_pred', kind: 'pred', source_uuid: 'w-s', name: 'Predictions for BTC',
    cadence_seconds: 60, meta: '{"announced_at":5}', seen_at: 1000, ...o });
  const wo = (o) => ({ stream_uuid: 'w-p', seq: 1, ts: 2000, value: 1.5, received_at: 2001, event_id: 'e1', ...o });

  test('a step-13 database gains the two tables, empty; additive (an older build may open it); nothing else changes', async () => {
    expect(ADDITIVE.has(14)).toBe(true);
    const conn = await memoryConn();
    await conn.query('CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
    for (const m of MIGRATIONS.slice(0, 13)) if (typeof m === 'string') await conn.query(m);
    await conn.query(`INSERT INTO meta VALUES ('schema_version', '13'), ('central_url', '"w"')`);
    await conn.query(`INSERT INTO relay_streams (uuid, stream_name, provider_pubkey, active, subscribed_at, pred_created_at) VALUES ('r-1', 'btc', 'e5', true, 1, 1)`);
    const up = await openDb(conn);
    expect(up.version).toBe(MIGRATIONS.length);
    expect(await up.get('central_url')).toBe('w');
    expect(await up.relayStreams()).toMatchObject([{ uuid: 'r-1' }]);
    expect(await up.watchStreams()).toEqual([]);
    expect((await up.watchObservations(['x'])).get('x')).toEqual([]);
    expect(await up.get('schema_min')).toBe(Math.max(...MIGRATIONS.map((_, i) => i + 1).filter((n) => !ADDITIVE.has(n))));
  });

  test('saveWatch: new rows added (added_at = seen_at), known ones updated (kind, name, cadence, seen_at), added_at kept', async () => {
    await db.saveWatch([ws(), ws({ uuid: 'w-s', pubkey: 'bb', stream_name: 'btc', kind: 'source', source_uuid: null, name: 'BTC, "the" coin', meta: null })]);
    await db.saveWatch([ws({ seen_at: 2000, name: 'Predictions for Bitcoin', cadence_seconds: 120 })]);
    expect(await db.watchStreams()).toEqual([
      { uuid: 'w-p', pubkey: 'aa', stream_name: 'btc_pred', kind: 'pred', source_uuid: 'w-s', name: 'Predictions for Bitcoin', cadence_seconds: 120,
        meta: '{"announced_at":5}', seen_at: 2000, added_at: 1000 },
      { uuid: 'w-s', pubkey: 'bb', stream_name: 'btc', kind: 'source', source_uuid: null, name: 'BTC, "the" coin', cadence_seconds: 60,
        meta: null, seen_at: 1000, added_at: 1000 },
    ]);
    await db.saveWatch([]);
  });

  test('addWatchObservation: insert or ignore on (stream, seq) and on the event id, the first copy kept; nulls kept as null', async () => {
    await db.saveWatch([ws()]);
    expect(await db.addWatchObservation(wo())).toBe(true);
    expect(await db.addWatchObservation(wo({ value: 9, received_at: 5000 }))).toBe(false); // the same seq: the first stays
    expect(await db.addWatchObservation(wo({ seq: 2 }))).toBe(false); // the same event id
    expect(await db.addWatchObservation(wo({ seq: 3, ts: null, value: null, event_id: 'e3', received_at: 3000 }))).toBe(true);
    expect(await db.addWatchObservation(wo({ seq: 4, ts: 1500, value: 0.1 + 0.2, event_id: 'e4' }))).toBe(true);
    expect((await db.watchObservations(['w-p', 'none'])).get('w-p')).toEqual([ // by time, a row with none last
      { seq: 4, ts: 1500, value: 0.1 + 0.2, received_at: 2001 }, { seq: 1, ts: 2000, value: 1.5, received_at: 2001 },
      { seq: 3, ts: null, value: null, received_at: 3000 }]);
  });

  test('addWatchObservation: only while its stream is watched (a stream dropped meanwhile gets nothing)', async () => {
    expect(await db.addWatchObservation(wo())).toBe(false);
    expect((await db.watchObservations(['w-p'])).get('w-p')).toEqual([]);
    await db.saveWatch([ws()]);
    expect(await db.addWatchObservation(wo())).toBe(true);
  });

  test("retainWatch: every watched stream not kept goes, with its observations, in one commit; pruneWatch: each one's rows past its window", async () => {
    await db.saveWatch([ws(), ws({ uuid: 'w-old', stream_name: 'eth_pred', seen_at: 10, cadence_seconds: null })]);
    for (let k = 0; k < 20; k++) await db.addWatchObservation(wo({ seq: k, ts: 10_000 + 60 * k, event_id: `p${k}` }));
    await db.addWatchObservation(wo({ seq: 99, ts: null, received_at: 1, event_id: 'p99' })); // no time of its own: its arrival's
    await db.addWatchObservation(wo({ stream_uuid: 'w-old', event_id: 'o1' }));
    expect(await db.pruneWatch({ buckets: 10, batch: 3 })).toBe(9 + 1); // w-p keeps ts ≥ 11,140 − 600 (and its timeless row goes); w-old keeps its one row (a day's window)
    expect((await db.watchObservations(['w-p'])).get('w-p').map((o) => o.seq)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(await db.retainWatch(['w-p'])).toBe(1);
    expect((await db.watchStreams()).map((r) => r.uuid)).toEqual(['w-p']);
    expect((await db.watchObservations(['w-old'])).get('w-old')).toEqual([]);
    expect(await db.retainWatch(['w-p'])).toBe(0);
    expect(await db.retainWatch([])).toBe(1);
    expect(await db.watchStreams()).toEqual([]);
  });

  test('pruneWatch: counted back from the newest time not in the future; a far-future row goes, the history stays', async () => {
    await db.saveWatch([ws({ cadence_seconds: 900 })]);
    const now = 1_792_000_000;
    for (let k = 0; k < 40; k++) await db.addWatchObservation(wo({ seq: k, ts: now - (39 - k) * 900, event_id: `p${k}` }));
    await db.addWatchObservation(wo({ seq: 40, ts: 4_000_000_000, event_id: 'future' })); // 2096, stored before the guard
    expect(await db.pruneWatch({ buckets: 400, now })).toBe(1); // only the 2096 row: 40 cadences are well inside 400
    expect((await db.watchObservations(['w-p'])).get('w-p')).toHaveLength(40);
  });

  test('watchObservations(uuids, { last }): only the last n of each stream, by time; watchCounts: how many each holds', async () => {
    await db.saveWatch([ws(), ws({ uuid: 'w-s', kind: 'source', source_uuid: null })]);
    for (let k = 0; k < 10; k++) await db.addWatchObservation(wo({ seq: k, ts: 5000 + 60 * k, event_id: `p${k}` }));
    await db.addWatchObservation(wo({ stream_uuid: 'w-s', seq: 1, event_id: 's1' }));
    const got = await db.watchObservations(['w-p', 'w-s', 'none'], { last: 3 });
    expect(got.get('w-p').map((o) => o.seq)).toEqual([7, 8, 9]); // oldest first
    expect(got.get('w-s').map((o) => o.seq)).toEqual([1]);
    expect(got.get('none')).toEqual([]);
    expect(await db.watchCounts(['w-p', 'w-s', 'none'])).toEqual(new Map([['w-p', 10], ['w-s', 1], ['none', 0]]));
  });
});

test('a day opened on Home: the predictions sent in it, and the observations around them', async () => {
  await db.addObservations([obs({ ts: 900 }), obs({ ts: 1100, value: 7 }), obs({ ts: 5000 }), obs({ stream_uuid: 'u-eth', name: 'eth', ts: 1000 })]);
  const [a, b, c] = await db.addPredictions([pred({ made_at: 1000 }), pred({ made_at: 1500, t2: 4 }), pred({ made_at: 3000 })]);
  await db.markSent([a, b, c].map((p) => p.id ?? p), 3100);
  await addPrediction(db, pred({ made_at: 1200 })); // pending: not sent
  expect((await db.sentBetween(1000, 3000)).map((p) => [p.made_at, p.t2])).toEqual([[1000, pred().t2], [1500, 4]]);
  const o = await db.observationsBetween(['u-btc', 'u-none'], 1000, 5000);
  expect(o.get('u-btc')).toEqual([{ ts: 1100, value: 7 }, { ts: 5000, value: obs().value }]);
  expect(o.get('u-none')).toEqual([]);
  expect(await db.observationsBetween([], 0, 1)).toEqual(new Map());
});
