// The database: DuckDB-WASM, one connection, calls run one at a time in order.
//
//   const db = await openDb(conn, close?)    // runs migrations
//   await db.get(key) / db.set(key, value)   // meta, JSON values
//   await db.streams() / db.addStream(s) / db.removeStream(name) / db.setError(name, msg, at)
//   await db.addObservation(stream, ts, value) / db.recent(stream, n) → [{ts, value}]
//   await db.addPrediction(p) → id / db.markPublished(id, at)
//   await db.summary()                        // one row per stream for the UI
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

    streams: serial(() => rows('SELECT * FROM streams ORDER BY created_at, name')),
    addStream: serial(({ name, url, path, interval_s = 60, created_at = Date.now() }) =>
      run('INSERT INTO streams (name, url, path, interval_s, created_at) VALUES (?, ?, ?, ?, ?)',
        name, url, path, interval_s, created_at)),
    removeStream: serial(async (name) => {
      await run('DELETE FROM observations WHERE stream = ?', name);
      await run('DELETE FROM predictions WHERE stream = ?', name);
      await run('DELETE FROM streams WHERE name = ?', name);
    }),
    setError: serial((name, error, at = Date.now()) =>
      run('UPDATE streams SET last_error = ?, last_error_at = ? WHERE name = ?',
        error ?? null, error ? at : null, name)),

    addObservation: serial((stream, ts, value) =>
      run('INSERT INTO observations VALUES (?, ?, ?)', stream, ts, value)),
    recent: serial((stream, n) => rows(
      `SELECT ts, value FROM (SELECT ts, value FROM observations WHERE stream = ?
         ORDER BY ts DESC LIMIT ?) ORDER BY ts`, stream, n)),

    addPrediction: serial(async (p) => (await rows(
      `INSERT INTO predictions (stream, ts, target_ts, value, model, address, message, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      p.stream, p.ts, p.target_ts, p.value, p.model, p.address, p.message, p.signature))[0].id),
    markPublished: serial((id, at = Date.now()) =>
      run('UPDATE predictions SET published_at = ? WHERE id = ?', at, id)),

    summary: serial(() => rows(`
      SELECT s.name, s.url, s.path, s.interval_s, s.last_error, s.last_error_at,
        (SELECT count(*) FROM observations o WHERE o.stream = s.name) AS observations,
        (SELECT count(*) FROM predictions p WHERE p.stream = s.name) AS predictions,
        o.ts AS obs_ts, o.value AS obs_value,
        p.id AS pred_id, p.ts AS pred_ts, p.target_ts AS pred_target_ts, p.value AS pred_value,
        p.model AS pred_model, p.message AS pred_message, p.signature AS pred_signature,
        p.published_at AS pred_published_at
      FROM streams s
      LEFT JOIN (SELECT * FROM observations QUALIFY row_number() OVER (PARTITION BY stream ORDER BY ts DESC) = 1) o
        ON o.stream = s.name
      LEFT JOIN (SELECT * FROM predictions QUALIFY row_number() OVER (PARTITION BY stream ORDER BY id DESC) = 1) p
        ON p.stream = s.name
      ORDER BY s.created_at, s.name`)),

    checkpoint: serial(() => run('CHECKPOINT')),
    close: serial(async () => {
      await run('CHECKPOINT');
      await closeDb();
    }),
  };
}
