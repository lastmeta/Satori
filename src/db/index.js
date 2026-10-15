// The database: DuckDB-WASM, one connection, calls run one at a time in order.
// Times are unix seconds (docs/design/central.md).
//
//   const db = await openDb(conn, close?)    // runs migrations
//   await db.get(key) / db.set(key, value)   // meta, JSON values
//   await db.addObservations(rows) → uuids with a new row / db.history(uuid) → [{ts, value}]
//   await db.addPrediction(p) → id / db.pending() / db.pendingCount() / db.markSent(ids, at)
//   await db.streams() / db.predictions(uuidOrName, limit)   // for the UI and agents
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
        p.model, p.t1, p.t2, p.made_at, p.status, p.sent_at
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
      `INSERT INTO predictions (stream_uuid, made_at, model, t1, t2, observed_at, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      p.stream_uuid, p.made_at, p.model, p.t1, p.t2, p.observed_at, p.hash))[0].id),
    /** The kept queue: every pending prediction, oldest first, with its stream's name. */
    pending: serial(() => rows(`SELECT p.*, s.name FROM predictions p JOIN streams s ON s.uuid = p.stream_uuid
      WHERE p.status = 'pending' ORDER BY p.id`)),
    pendingCount: serial(async () => (await rows("SELECT count(*) AS n FROM predictions WHERE status = 'pending'"))[0].n),
    markSent: serial(async (ids, at) => {
      if (ids.length) await run(`UPDATE predictions SET status = 'sent', sent_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, at, ...ids);
    }),
    /** A stream's predictions (by uuid or name), newest first. */
    predictions: serial((stream, limit = 20) => rows(`SELECT p.*, s.name FROM predictions p
      JOIN streams s ON s.uuid = p.stream_uuid WHERE p.stream_uuid = ? OR s.name = ? ORDER BY p.id DESC LIMIT ?`,
      stream, stream, limit)),

    checkpoint: serial(() => run('CHECKPOINT')),
    close: serial(async () => {
      await run('CHECKPOINT');
      await closeDb();
    }),
  };
}
