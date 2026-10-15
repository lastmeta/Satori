// The database: DuckDB-WASM, one connection, calls run one at a time in order.
// Times are unix seconds (docs/design/central.md).
//
//   const db = await openDb(conn, close?)    // runs migrations
//   await db.get(key) / db.set(key, value)   // meta, JSON values
//   await db.addObservations(rows) → uuids with a new row / db.history(uuid) → [{ts, value}]
//   await db.addPrediction(p) → id / db.pending() / db.pendingCount() / db.markSent(ids, at) / db.dropPending(before)
//   await db.resetCentral()                  // the central URL changed
//   await db.streams() / db.predictions(uuidOrName, limit)   // for the UI and agents
//   relay (Nostr) streams, apart from central's (docs/design/nostr.md):
//   db.subscribeRelay(s) / unsubscribeRelay(uuid) / relayStream(uuid) / relayStreams({active}) / countActiveRelay()
//   db.addRelayObservation(o) → new? / relayHistory(uuid) / nextPredSeq(uuid) / addRelayPrediction(p) / relayPredictions(uuid, limit)
//   await db.checkpoint() / db.close()
// `conn` is an AsyncDuckDBConnection (browser) or a blocking one (node tests).
import { MIGRATIONS } from './schema.js';

const plain = (v) => (typeof v === 'bigint' ? Number(v) : v);
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
  for (; version < MIGRATIONS.length; version++) {
    await conn.query('BEGIN TRANSACTION');
    try {
      await conn.query(MIGRATIONS[version]);
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
  const version = await migrate(conn);

  let tail = Promise.resolve();
  const serial = (fn) => (...args) => {
    const p = tail.then(() => fn(...args));
    tail = p.catch(() => {});
    return p;
  };
  const rows = async (sql, ...params) => toRows(await query(conn, sql, params));
  const run = async (sql, ...params) => void (await query(conn, sql, params));

  return {
    version,
    rows: serial(rows),
    get: serial(async (key) => {
      const [row] = await rows('SELECT value FROM meta WHERE key = ?', key);
      return row ? JSON.parse(row.value) : undefined;
    }),
    set: serial((key, value) => run('INSERT OR REPLACE INTO meta VALUES (?, ?)', key, JSON.stringify(value))),

    /** One row per stream: its latest observation and our latest prediction. */
    streams: serial(() => rows(`
      SELECT s.uuid, s.name, s.meta,
        (SELECT count(*) FROM observations x WHERE x.stream_uuid = s.uuid) AS observations,
        o.ts AS obs_ts, o.value AS obs_value,
        p.model, p.t1, p.t2, p.phi, p.weight, p.made_at, p.status, p.sent_at
      FROM streams s
      LEFT JOIN (SELECT * FROM observations QUALIFY row_number() OVER (PARTITION BY stream_uuid ORDER BY ts DESC) = 1) o
        ON o.stream_uuid = s.uuid
      LEFT JOIN (SELECT * FROM predictions QUALIFY row_number() OVER (PARTITION BY stream_uuid ORDER BY id DESC) = 1) p
        ON p.stream_uuid = s.uuid
      ORDER BY s.name, s.uuid`)),

    /** Upsert each row's stream; insert or ignore the observation. The uuids that got a new row. */
    addObservations: serial(async (list) => {
      const fresh = new Set();
      await run('BEGIN TRANSACTION');
      try {
        for (const o of list) {
          await run(`INSERT INTO streams VALUES (?, ?, ?)
            ON CONFLICT (uuid) DO UPDATE SET name = excluded.name, meta = excluded.meta`, o.stream_uuid, o.name, o.meta);
          const added = await rows('INSERT OR IGNORE INTO observations VALUES (?, ?, ?) RETURNING stream_uuid',
            o.stream_uuid, o.ts, o.value);
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
    history: serial((uuid) => rows('SELECT ts, value FROM observations WHERE stream_uuid = ? ORDER BY ts', uuid)),

    addPrediction: serial(async (p) => (await rows(
      `INSERT INTO predictions (stream_uuid, made_at, model, t1, t2, phi, weight, observed_at, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      p.stream_uuid, p.made_at, p.model, p.t1, p.t2, p.phi ?? null, p.weight ?? null, p.observed_at, p.hash))[0].id),
    /** The kept queue: every pending prediction, oldest first, with its stream's name. */
    pending: serial(() => rows(`SELECT p.*, s.name FROM predictions p JOIN streams s ON s.uuid = p.stream_uuid
      WHERE p.status = 'pending' ORDER BY p.id`)),
    pendingCount: serial(async () => (await rows("SELECT count(*) AS n FROM predictions WHERE status = 'pending'"))[0].n),
    markSent: serial(async (ids, at) => {
      if (ids.length) await run(`UPDATE predictions SET status = 'sent', sent_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, at, ...ids);
    }),
    /** The cap on the kept queue: pending predictions made before `before` are deleted. */
    dropPending: serial((before) => run("DELETE FROM predictions WHERE status = 'pending' AND made_at < ?", before)),
    /** Another central: its uuids differ, so the pending queue, the stream list and the last poll/submission go. */
    resetCentral: serial(async () => {
      await run("DELETE FROM predictions WHERE status = 'pending'");
      await run('DELETE FROM streams');
      await run("DELETE FROM meta WHERE key IN ('central_last_poll', 'central_last_submit')");
    }),
    /** A stream's predictions (by uuid or name), newest first. */
    predictions: serial((stream, limit = 20) => rows(`SELECT p.*, s.name FROM predictions p
      JOIN streams s ON s.uuid = p.stream_uuid WHERE p.stream_uuid = ? OR s.name = ? ORDER BY p.id DESC LIMIT ?`,
      stream, stream, limit)),

    // ── relay (Nostr) streams ──
    /**
     * Subscribe (again): active from `now`; a row that exists keeps its
     * pred_created_at and pred_seq. (meta and unsubscribed_at, from migration
     * 4, are no longer written: nothing read them.)
     */
    subscribeRelay: serial(async ({ uuid, stream_name, provider_pubkey, name, cadence_seconds, now }) => {
      await run(`INSERT INTO relay_streams (uuid, stream_name, provider_pubkey, name, cadence_seconds, active,
          subscribed_at, pred_created_at, pred_seq) VALUES (?, ?, ?, ?, ?, true, ?, ?, 0)
        ON CONFLICT (uuid) DO UPDATE SET name = excluded.name, cadence_seconds = excluded.cadence_seconds,
          active = true, subscribed_at = excluded.subscribed_at`,
      uuid, stream_name, provider_pubkey, name ?? '', cadence_seconds ?? null, now, now);
      return (await rows('SELECT * FROM relay_streams WHERE uuid = ?', uuid))[0];
    }),
    unsubscribeRelay: serial((uuid) => run('UPDATE relay_streams SET active = false WHERE uuid = ?', uuid)),
    relayStream: serial(async (uuid) => (await rows('SELECT * FROM relay_streams WHERE uuid = ?', uuid))[0] ?? null),
    countActiveRelay: serial(async () => (await rows('SELECT count(*) AS n FROM relay_streams WHERE active'))[0].n),
    /**
     * Each relay stream, newest subscription first, with its latest observation
     * (obs_*, the highest seq), our latest `_pred` (p_*) and its observation
     * count: all kept on the stream's row at insert time (migration 5).
     */
    relayStreams: serial(({ active } = {}) =>
      rows(`SELECT * FROM relay_streams ${active ? 'WHERE active' : ''} ORDER BY subscribed_at DESC, uuid`)),
    /** Insert or ignore (the event id, or the stream's seq, seen before): true when new (network_db.py:597-636). */
    addRelayObservation: serial(async (o) => {
      await run('BEGIN TRANSACTION');
      try {
        const fresh = (await rows('INSERT OR IGNORE INTO relay_observations VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq',
          o.stream_uuid, o.seq, o.ts ?? null, o.value ?? null, o.raw ?? null, o.event_id, o.received_at)).length > 0;
        if (fresh) {
          await run('UPDATE relay_streams SET observations = observations + 1 WHERE uuid = ?', o.stream_uuid);
          await run(`UPDATE relay_streams SET obs_seq = ?, obs_ts = ?, obs_value = ?, obs_raw = ?, obs_received_at = ?
            WHERE uuid = ? AND (obs_seq IS NULL OR obs_seq < ?)`,
          o.seq, o.ts ?? null, o.value ?? null, o.raw ?? null, o.received_at, o.stream_uuid, o.seq);
        }
        await run('COMMIT');
        return fresh;
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
    }),
    /** The engine's input for a relay stream: [{ts, value}] with a number and a time, oldest first. */
    relayHistory: serial((uuid) => rows(`SELECT ts, value FROM relay_observations
      WHERE stream_uuid = ? AND value IS NOT NULL AND ts IS NOT NULL ORDER BY ts, seq`, uuid)),
    /** The `_pred` seq for the next publish: last + 1, kept (network_db.py:835-848). */
    nextPredSeq: serial(async (uuid) =>
      (await rows('UPDATE relay_streams SET pred_seq = pred_seq + 1 WHERE uuid = ? RETURNING pred_seq', uuid))[0].pred_seq),
    addRelayPrediction: serial(async (p) => {
      await run('INSERT INTO relay_predictions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        p.stream_uuid, p.seq, p.value, p.model ?? null, p.obs_seq ?? null, p.made_at, p.event_id, p.relays);
      await run(`UPDATE relay_streams SET p_seq = ?, p_value = ?, p_model = ?, p_made_at = ?, p_relays = ?
        WHERE uuid = ? AND (p_seq IS NULL OR p_seq < ?)`,
      p.seq, p.value, p.model ?? null, p.made_at, p.relays, p.stream_uuid, p.seq);
    }),
    /** How many relays took a published `_pred` (known after it is kept). */
    setPredictionRelays: serial(async (uuid, seq, n) => {
      await run('UPDATE relay_predictions SET relays = ? WHERE stream_uuid = ? AND seq = ?', n, uuid, seq);
      await run('UPDATE relay_streams SET p_relays = ? WHERE uuid = ? AND p_seq = ?', n, uuid, seq);
    }),
    relayPredictions: serial((uuid, limit = 20) =>
      rows('SELECT * FROM relay_predictions WHERE stream_uuid = ? ORDER BY seq DESC LIMIT ?', uuid, limit)),

    checkpoint: serial(() => run('CHECKPOINT')),
    close: serial(async () => {
      await run('CHECKPOINT');
      await closeDb();
    }),
  };
}
