// The database: DuckDB-WASM, one connection, calls run one at a time in order.
// Times are unix seconds (docs/design/central.md).
//
//   const db = await openDb(conn, close?)    // runs migrations
//   await db.get(key) / db.set(key, value)   // meta, JSON values
//   await db.addObservations(rows) → uuids with a new row / db.history(uuid) → [{ts, value}]
//   await db.centralHistories() → Map(uuid → [{ts, value}]) / db.specs() / db.saveSpecs(map, at) / db.models()
//   await db.needHistory() → uuids / db.addHistory(uuid, rows, at) → rows added (older than the newest polled only)
//   await db.addPredictions(list) → ids / db.pending() / db.pendingCount() / db.markSent(ids, at) / db.dropPending(before)
//   await db.resetCentral()                  // the central URL changed
//   await db.streams() / db.predictions(uuidOrName, limit) / db.sparks(n)   // for the UI and agents
//   relay (Nostr) streams, apart from central's (docs/design/nostr.md):
//   db.subscribeRelay(s) / unsubscribeRelay(uuid) / relayStream(uuid) / relayStreams({active}) / countActiveRelay()
//   db.addRelayObservation(o) → new? / relayHistory(uuid) / nextPredSeq(uuid) / addRelayPrediction(p) / relayPredictions(uuid, limit)
//   the activity log (docs/design/health.md): db.addActivity(row) → id / updateActivity(id, fields) / activity(since) / pruneActivity(before)
//   await db.checkpoint() / db.close()
// `conn` is an AsyncDuckDBConnection (browser) or a blocking one (node tests).
import { MIGRATIONS } from './schema.js';
import { serial } from '../util.js';

const plain = (v) => (typeof v === 'bigint' ? Number(v) : v);
/**
 * A DOUBLE parameter, sent as text for `CAST(? AS DOUBLE)`: DuckDB-WASM sends
 * parameters as JSON, and its parser reads about 1 number in 12 one ulp off;
 * a JS number's shortest text parses back exactly.
 */
const dbl = (x) => (x == null ? null : String(x));
const D = 'CAST(? AS DOUBLE)';
const toRows = (table) => table.toArray().map((r) => {
  const o = r.toJSON();
  for (const k in o) o[k] = plain(o[k]);
  return o;
});

async function query(conn, sql, params = []) {
  if (!params.length) return conn.query(sql);
  const stmt = await conn.prepare(sql);
  try {
    return await stmt.query(...params);
  } finally {
    await stmt.close();
  }
}

async function migrate(conn) {
  await conn.query('CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
  const [row] = toRows(await conn.query("SELECT value FROM meta WHERE key = 'schema_version'"));
  let version = row ? JSON.parse(row.value) : 0;
  if (version > MIGRATIONS.length) {
    throw new Error(`This database is from a newer version of the app (schema ${version}, this app knows ${MIGRATIONS.length}).`);
  }
  const meta = {
    get: async (key) => {
      const [r] = toRows(await query(conn, 'SELECT value FROM meta WHERE key = ?', [key]));
      return r ? JSON.parse(r.value) : undefined;
    },
    set: (key, value) => query(conn, 'INSERT OR REPLACE INTO meta VALUES (?, ?)', [key, JSON.stringify(value)]),
    remove: (...keys) => query(conn, `DELETE FROM meta WHERE key IN (${keys.map(() => '?').join(', ')})`, keys),
  };
  for (; version < MIGRATIONS.length; version++) {
    const step = MIGRATIONS[version];
    await conn.query('BEGIN TRANSACTION');
    try {
      await (typeof step === 'function' ? step(meta) : conn.query(step));
      await conn.query(`INSERT OR REPLACE INTO meta VALUES ('schema_version', '${version + 1}')`);
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    }
  }
  return version;
}

export async function openDb(conn, closeDb = async () => conn.close()) {
  await conn.query('SET autoload_known_extensions = false');
  // DuckDB checkpoints every commit itself, so nothing is left in the WAL: on OPFS,
  // DuckDB-WASM 1.32.0 keeps only what is checkpointed, and cannot replay a WAL
  // that holds migration 3 (docs/design/storage.md#the-checkpoint-rule).
  await conn.query("SET checkpoint_threshold = '0b'");
  const version = await migrate(conn);
  await conn.query('CHECKPOINT'); // whatever the migrations left, before anything else runs

  const line = serial();
  const inOrder = (fn) => (...args) => line(() => fn(...args));
  const rows = async (sql, ...params) => toRows(await query(conn, sql, params));
  const run = async (sql, ...params) => void (await query(conn, sql, params));

  return {
    version,
    get: inOrder(async (key) => {
      const [row] = await rows('SELECT value FROM meta WHERE key = ?', key);
      return row ? JSON.parse(row.value) : undefined;
    }),
    set: inOrder((key, value) => run('INSERT OR REPLACE INTO meta VALUES (?, ?)', key, JSON.stringify(value))),

    /** One row per stream: its latest observation and our latest prediction. */
    streams: inOrder(() => rows(`
      SELECT s.uuid, s.name, s.meta,
        (SELECT count(*) FROM observations x WHERE x.stream_uuid = s.uuid) AS observations,
        o.ts AS obs_ts, o.value AS obs_value,
        p.model, p.t1, p.t2, p.phi, p.weight, p.made_at, p.status, p.sent_at,
        m.spec, m.score, m.generation, m.accepted, s.history_at
      FROM streams s
      LEFT JOIN model_specs m ON m.target_uuid = s.uuid
      LEFT JOIN (SELECT * FROM observations QUALIFY row_number() OVER (PARTITION BY stream_uuid ORDER BY ts DESC) = 1) o
        ON o.stream_uuid = s.uuid
      LEFT JOIN (SELECT * FROM predictions QUALIFY row_number() OVER (PARTITION BY stream_uuid ORDER BY id DESC) = 1) p
        ON p.stream_uuid = s.uuid
      ORDER BY s.name, s.uuid`)),

    /** Each central stream's last `n` observations, oldest first: { uuid: [value] } (Home's trend lines). */
    sparks: inOrder(async (n = 24) => {
      const out = {};
      for (const r of await rows(`SELECT stream_uuid, value FROM observations
        QUALIFY row_number() OVER (PARTITION BY stream_uuid ORDER BY ts DESC) <= ? ORDER BY stream_uuid, ts`, n)) {
        (out[r.stream_uuid] ??= []).push(r.value);
      }
      return out;
    }),

    /** Upsert each row's stream; insert or ignore the observation. The uuids that got a new row. */
    addObservations: inOrder(async (list) => {
      const fresh = new Set();
      await run('BEGIN TRANSACTION');
      try {
        for (const o of list) {
          await run(`INSERT INTO streams (uuid, name, meta) VALUES (?, ?, ?)
            ON CONFLICT (uuid) DO UPDATE SET name = excluded.name, meta = excluded.meta`, o.stream_uuid, o.name, o.meta);
          const added = await rows(`INSERT OR IGNORE INTO observations VALUES (?, ?, ${D}) RETURNING stream_uuid`,
            o.stream_uuid, o.ts, dbl(o.value));
          if (added.length) fresh.add(o.stream_uuid);
        }
        await run('COMMIT');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
      return [...fresh];
    }),
    /** A stream's observations, oldest first: [{ts, value}]. */
    history: inOrder((uuid) => rows('SELECT ts, value FROM observations WHERE stream_uuid = ? ORDER BY ts', uuid)),
    /** Every central stream's observations, oldest first, in one read: Map(uuid → [{ts, value}]). */
    centralHistories: inOrder(async () => {
      const t = await query(conn, `SELECT o.stream_uuid, o.ts::DOUBLE AS ts, o.value FROM observations o
        JOIN streams s ON s.uuid = o.stream_uuid ORDER BY o.stream_uuid, o.ts`);
      const uuids = t.getChild('stream_uuid').toArray();
      const ts = t.getChild('ts').toArray();
      const values = t.getChild('value').toArray();
      const out = new Map();
      let list;
      for (let i = 0; i < t.numRows; i++) {
        if (i === 0 || uuids[i] !== uuids[i - 1]) out.set(uuids[i], (list = []));
        list.push({ ts: ts[i], value: values[i] });
      }
      return out;
    }),
    /** Central streams whose history has not been fetched yet. */
    needHistory: inOrder(async () => (await rows('SELECT uuid FROM streams WHERE history_at IS NULL ORDER BY uuid')).map((r) => r.uuid)),
    /**
     * A stream's history from central: insert or ignore the rows older than its
     * newest stored (polled) one, so a backfill never pre-empts a poll's new row;
     * mark the stream fetched. → how many rows were added
     */
    addHistory: inOrder(async (uuid, list, at) => {
      const [{ newest }] = await rows('SELECT max(ts) AS newest FROM observations WHERE stream_uuid = ?', uuid);
      const keep = newest == null ? [] : list.filter((o) => o.ts < newest);
      let added = 0;
      await run('BEGIN TRANSACTION');
      try {
        if (keep.length) {
          // one statement, times and values as comma-joined text (exact doubles, see dbl), split in SQL
          // (INSERT's Count is the rows inserted, the ignored ones not counted; RETURNING made it 3× slower)
          [{ Count: added }] = await rows(`INSERT OR IGNORE INTO observations SELECT ?, t::BIGINT, v::DOUBLE
            FROM (SELECT unnest(string_split(?, ',')) AS t, unnest(string_split(?, ',')) AS v)`,
          uuid, keep.map((o) => o.ts).join(','), keep.map((o) => dbl(o.value)).join(','));
        }
        await run('UPDATE streams SET history_at = ? WHERE uuid = ?', at, uuid);
        await run('COMMIT');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
      return added;
    }),
    /** Each target's champion spec: Map(uuid → {spec, score, generation, accepted, updated_at}). */
    specs: inOrder(async () => new Map((await rows('SELECT * FROM model_specs')).map((r) =>
      [r.target_uuid, { spec: JSON.parse(r.spec), score: r.score, generation: r.generation, accepted: r.accepted, updated_at: r.updated_at }]))),
    /** Store the specs a poll touched: Map(uuid → {spec, score, generation, accepted}). */
    saveSpecs: inOrder(async (specs, at) => {
      if (!specs.size) return;
      await run('BEGIN TRANSACTION');
      try {
        for (const [uuid, r] of specs) {
          await run(`INSERT INTO model_specs VALUES (?, ?, ${D}, ?, ?, ?) ON CONFLICT (target_uuid) DO UPDATE SET
            spec = excluded.spec, score = excluded.score, generation = excluded.generation, accepted = excluded.accepted,
            updated_at = excluded.updated_at`, uuid, JSON.stringify(r.spec), dbl(r.score), r.generation, r.accepted, at);
        }
        await run('COMMIT');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
    }),

    /** A poll's predictions, in one transaction (one checkpoint). → their ids, in order */
    addPredictions: inOrder(async (list) => {
      const ids = [];
      await run('BEGIN TRANSACTION');
      try {
        for (const p of list) {
          ids.push((await rows(`INSERT INTO predictions (stream_uuid, made_at, model, t1, t2, phi, weight, observed_at, hash)
            VALUES (?, ${D}, ?, ${D}, ${D}, ${D}, ${D}, ?, ?) RETURNING id`,
          p.stream_uuid, dbl(p.made_at), p.model, dbl(p.t1), dbl(p.t2), dbl(p.phi), dbl(p.weight), p.observed_at, p.hash))[0].id);
        }
        await run('COMMIT');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
      return ids;
    }),
    /** The kept queue: every pending prediction, oldest first, with its stream's name. */
    pending: inOrder(() => rows(`SELECT p.*, s.name FROM predictions p JOIN streams s ON s.uuid = p.stream_uuid
      WHERE p.status = 'pending' ORDER BY p.id`)),
    pendingCount: inOrder(async () => (await rows("SELECT count(*) AS n FROM predictions WHERE status = 'pending'"))[0].n),
    markSent: inOrder(async (ids, at) => {
      if (ids.length) await run(`UPDATE predictions SET status = 'sent', sent_at = ${D} WHERE id IN (${ids.map(() => '?').join(', ')})`, dbl(at), ...ids);
    }),
    /** The cap on the kept queue: pending predictions made before `before` are deleted. */
    dropPending: inOrder((before) => run("DELETE FROM predictions WHERE status = 'pending' AND made_at < ?", before)),
    /** Another central: its uuids differ, so the pending queue, the stream list, the specs and the last poll/submission/history go. */
    resetCentral: inOrder(async () => {
      await run("DELETE FROM predictions WHERE status = 'pending'");
      await run('DELETE FROM streams');
      await run('DELETE FROM model_specs');
      await run("DELETE FROM meta WHERE key IN ('central_last_poll', 'central_last_submit', 'central_history')");
    }),
    /** A stream's predictions (by uuid or name), newest first. */
    predictions: inOrder((stream, limit = 20) => rows(`SELECT p.*, s.name FROM predictions p
      JOIN streams s ON s.uuid = p.stream_uuid WHERE p.stream_uuid = ? OR s.name = ? ORDER BY p.id DESC LIMIT ?`,
      stream, stream, limit)),

    // ── relay (Nostr) streams ──
    /**
     * Subscribe (again): active from `now`; a row that exists keeps its
     * pred_created_at and pred_seq. (meta and unsubscribed_at, from migration
     * 4, are no longer written: nothing read them.)
     */
    subscribeRelay: inOrder(async ({ uuid, stream_name, provider_pubkey, name, cadence_seconds, now }) => {
      await run(`INSERT INTO relay_streams (uuid, stream_name, provider_pubkey, name, cadence_seconds, active,
          subscribed_at, pred_created_at, pred_seq) VALUES (?, ?, ?, ?, ?, true, ?, ?, 0)
        ON CONFLICT (uuid) DO UPDATE SET name = excluded.name, cadence_seconds = excluded.cadence_seconds,
          active = true, subscribed_at = excluded.subscribed_at`,
      uuid, stream_name, provider_pubkey, name ?? '', cadence_seconds ?? null, now, now);
      return (await rows('SELECT * FROM relay_streams WHERE uuid = ?', uuid))[0];
    }),
    unsubscribeRelay: inOrder((uuid) => run('UPDATE relay_streams SET active = false WHERE uuid = ?', uuid)),
    relayStream: inOrder(async (uuid) => (await rows('SELECT * FROM relay_streams WHERE uuid = ?', uuid))[0] ?? null),
    countActiveRelay: inOrder(async () => (await rows('SELECT count(*) AS n FROM relay_streams WHERE active'))[0].n),
    /**
     * Each relay stream, newest subscription first, with its latest observation
     * (obs_*, the highest seq), our latest `_pred` (p_*) and its observation
     * count: all kept on the stream's row at insert time (migration 5).
     */
    relayStreams: inOrder(({ active } = {}) =>
      rows(`SELECT * FROM relay_streams ${active ? 'WHERE active' : ''} ORDER BY subscribed_at DESC, uuid`)),
    /** Insert or ignore (the event id, or the stream's seq, seen before): true when new (network_db.py:597-636). */
    addRelayObservation: inOrder(async (o) => {
      await run('BEGIN TRANSACTION');
      try {
        const fresh = (await rows(`INSERT OR IGNORE INTO relay_observations VALUES (?, ?, ?, ${D}, ?, ?, ?) RETURNING seq`,
          o.stream_uuid, o.seq, o.ts ?? null, dbl(o.value), o.raw ?? null, o.event_id, o.received_at)).length > 0;
        if (fresh) {
          await run('UPDATE relay_streams SET observations = observations + 1 WHERE uuid = ?', o.stream_uuid);
          await run(`UPDATE relay_streams SET obs_seq = ?, obs_ts = ?, obs_value = ${D}, obs_raw = ?, obs_received_at = ?
            WHERE uuid = ? AND (obs_seq IS NULL OR obs_seq < ?)`,
          o.seq, o.ts ?? null, dbl(o.value), o.raw ?? null, o.received_at, o.stream_uuid, o.seq);
        }
        await run('COMMIT');
        return fresh;
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
    }),
    /** The engine's input for a relay stream: [{ts, value}] with a number and a time, oldest first. */
    relayHistory: inOrder((uuid) => rows(`SELECT ts, value FROM relay_observations
      WHERE stream_uuid = ? AND value IS NOT NULL AND ts IS NOT NULL ORDER BY ts, seq`, uuid)),
    /** The `_pred` seq for the next publish: last + 1, kept (network_db.py:835-848). */
    nextPredSeq: inOrder(async (uuid) =>
      (await rows('UPDATE relay_streams SET pred_seq = pred_seq + 1 WHERE uuid = ? RETURNING pred_seq', uuid))[0].pred_seq),
    addRelayPrediction: inOrder(async (p) => {
      await run('INSERT INTO relay_predictions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        p.stream_uuid, p.seq, p.value, p.model ?? null, p.obs_seq ?? null, p.made_at, p.event_id, p.relays);
      await run(`UPDATE relay_streams SET p_seq = ?, p_value = ?, p_model = ?, p_made_at = ?, p_relays = ?
        WHERE uuid = ? AND (p_seq IS NULL OR p_seq < ?)`,
      p.seq, p.value, p.model ?? null, p.made_at, p.relays, p.stream_uuid, p.seq);
    }),
    /** How many relays took a published `_pred` (known after it is kept). */
    setPredictionRelays: inOrder(async (uuid, seq, n) => {
      await run('UPDATE relay_predictions SET relays = ? WHERE stream_uuid = ? AND seq = ?', n, uuid, seq);
      await run('UPDATE relay_streams SET p_relays = ? WHERE uuid = ? AND p_seq = ?', n, uuid, seq);
    }),
    relayPredictions: inOrder((uuid, limit = 20) =>
      rows('SELECT * FROM relay_predictions WHERE stream_uuid = ? ORDER BY seq DESC LIMIT ?', uuid, limit)),

    // ── the activity log (docs/design/health.md) ──
    /** One event: { at, kind, level, data, until?, mkey? } → its id. */
    addActivity: inOrder(async ({ at, kind, level, data, until = null, mkey = null }) =>
      (await rows(`INSERT INTO activity (ts, last_ts, kind, level, data, mkey) VALUES (${D}, ${D}, ?, ?, ?, ?) RETURNING id`,
        dbl(at), dbl(until), kind, level, JSON.stringify(data ?? null), mkey))[0].id),
    /** A merged row's change: any of until, level, data, count. */
    updateActivity: inOrder(async (id, fields) => {
      const COLUMN = { until: `last_ts = ${D}`, level: 'level = ?', data: 'data = ?', count: 'count = ?' };
      const set = [];
      const args = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!COLUMN[k]) throw new Error(`activity has no ${k} to update`);
        set.push(COLUMN[k]);
        args.push(k === 'until' ? dbl(v) : k === 'data' ? JSON.stringify(v) : v);
      }
      if (set.length) await run(`UPDATE activity SET ${set.join(', ')} WHERE id = ?`, ...args, id);
    }),
    /** The rows that started or last changed at or after `since`, oldest first, data parsed. */
    activity: inOrder(async (since) => (await rows(`SELECT id, ts, last_ts, kind, level, data, count, mkey FROM activity
      WHERE greatest(ts, coalesce(last_ts, ts)) >= ${D} ORDER BY ts, id`, dbl(since)))
      .map(({ ts, last_ts: until, data, ...r }) => ({ id: r.id, at: ts, until, kind: r.kind, level: r.level,
        data: JSON.parse(data), count: r.count, mkey: r.mkey }))),
    /** The 90-day bound: rows that ended before `before` go. */
    pruneActivity: inOrder((before) => run(`DELETE FROM activity WHERE greatest(ts, coalesce(last_ts, ts)) < ${D}`, dbl(before))),

    checkpoint: inOrder(() => run('CHECKPOINT')),
    close: inOrder(async () => {
      await run('CHECKPOINT');
      await closeDb();
    }),
  };
}
