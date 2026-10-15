import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb, memoryConn } from './node.js';
import { MIGRATIONS } from './schema.js';
import { openDb } from './index.js';

vi.setConfig({ testTimeout: 60_000 });

let db;
beforeEach(async () => { db = await memoryDb(); });

const obs = (o) => ({ stream_uuid: 'u-btc', name: 'bitcoin', meta: null, ts: 1000, value: 1, ...o });
const pred = (o) => ({ stream_uuid: 'u-btc', made_at: 2000.5, model: 'bar1', t1: 2, t2: 3, phi: -0.25, weight: 0.75,
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
  await up.addPrediction(pred({ made_at: 5 }));
  await up.addPrediction(pred({ made_at: 6, model: 'naive', phi: undefined, weight: undefined }));
  expect((await up.predictions('u-btc')).map((p) => [p.model, p.phi, p.weight]))
    .toEqual([['naive', null, null], ['bar1', -0.25, 0.75], ['ols-20', null, null]]);
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

test('dropPending: only pending ones made before the cutoff', async () => {
  await db.addObservations([obs()]);
  const old = await db.addPrediction(pred({ made_at: 100 }));
  const sent = await db.addPrediction(pred({ made_at: 100 }));
  await db.markSent([sent], 150);
  const fresh = await db.addPrediction(pred({ made_at: 300 }));
  await db.dropPending(200);
  expect((await db.predictions('u-btc')).map((p) => p.id)).toEqual([fresh, sent]);
  expect(old).toBeLessThan(sent);
});

test('resetCentral: the pending queue, the stream list and the last poll/submission go; history and sent stay', async () => {
  await db.addObservations([obs()]);
  const sent = await db.addPrediction(pred());
  await db.markSent([sent], 3000);
  await db.addPrediction(pred({ t2: 9 }));
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
  await db.addPrediction(pred({ t2: 5 }));
  const id = await db.addPrediction(pred({ made_at: 2100, t1: 6, t2: 7 }));
  await db.markSent([id], 2200);
  const [btc, eth] = await db.streams();
  expect(btc).toMatchObject({ uuid: 'u-btc', name: 'bitcoin', observations: 2, obs_ts: 2000, obs_value: 2,
    t1: 6, t2: 7, model: 'bar1', phi: -0.25, weight: 0.75, made_at: 2100, status: 'sent', sent_at: 2200 });
  expect(eth).toMatchObject({ uuid: 'u-eth', name: 'eth', observations: 1, t1: null, t2: null, status: null });
});

test('calls run in order even when not awaited', async () => {
  const writes = [1, 2, 3].map((i) => db.addObservations([obs({ ts: i, value: i })]));
  const read = db.history('u-btc');
  await Promise.all(writes);
  expect((await read).map((o) => o.value)).toEqual([1, 2, 3]);
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

  test("relayStreams: each with its latest observation and our latest _pred", async () => {
    await db.subscribeRelay(sub());
    await db.subscribeRelay(sub({ uuid: 'r-2', stream_name: 'eth', name: 'Ether', now: 150 }));
    await db.addRelayObservation(robs());
    await db.addRelayObservation(robs({ seq: 9, ts: 2000, value: 6, raw: '"6"', event_id: 'e9', received_at: 2001 }));
    await db.addRelayPrediction({ stream_uuid: 'r-1', seq: 1, value: '5.0', model: 'naive', obs_seq: 1, made_at: 1002, event_id: 'p1', relays: 1 });
    await db.addRelayPrediction({ stream_uuid: 'r-1', seq: 2, value: '6.5', model: 'bar1', obs_seq: 9, made_at: 2002, event_id: 'p2', relays: 2 });
    const [eth, btc] = await db.relayStreams();
    expect(btc).toMatchObject({ uuid: 'r-1', stream_name: 'btc', active: true, observations: 2, obs_seq: 9, obs_ts: 2000,
      obs_value: 6, obs_raw: '"6"', obs_received_at: 2001, p_seq: 2, p_value: '6.5', p_model: 'bar1', p_made_at: 2002,
      p_relays: 2 });
    expect(eth).toMatchObject({ uuid: 'r-2', observations: 0, obs_value: null, p_value: null });
    expect((await db.relayPredictions('r-1', 1)).map((p) => p.value)).toEqual(['6.5']);
    await db.setPredictionRelays('r-1', 2, 3); // the relays' OKs come after the row is kept
    expect((await db.relayStreams()).find((r) => r.uuid === 'r-1')).toMatchObject({ p_seq: 2, p_relays: 3 });
    await db.unsubscribeRelay('r-2', 3000);
    expect((await db.relayStreams({ active: true })).map((r) => r.uuid)).toEqual(['r-1']);
  });
});
