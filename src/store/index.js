// Store: one DuckDB-WASM database on OPFS, owned by the neuron worker.
// Design: docs/design/storage.md. Schema: ./schema.js.
//
//   const store = await openStore();   // OPFS open + self-test + migrations; throws if OPFS lost a write
//
//   await store.get(key, fallback)     // settings value (JSON-parsed), or fallback
//   await store.set(key, value)        // JSON text; null/undefined deletes the key
//   await store.insert(table, rows, conflict?)  // batch insert of row objects -> rows inserted
//        conflict: undefined (throw on duplicate) | 'ignore' | 'replace'
//        observations: use 'ignore' (dupes by seq_num or round are skipped)
//   await store.values(stream_name, provider_pubkey, limit?)  // Float64Array of non-null
//        observations.value, oldest first; with limit, the latest `limit` values
//   await store.rows(sql, ...params)   // plain objects; BIGINT comes back as Number
//   await store.run(sql, ...params)    // no result
//   await store.checkpoint()           // after each ingest or prediction batch (storage.md)
//   await store.close()                // checkpoint, then close the database
//
// Calls run one at a time in order (one queue per store). Not called from the
// worker: navigator.storage.persist() is Window-only, so the page asks for it.
import { MIGRATIONS } from './schema.js';

const TABLES = new Set(['settings', 'observations', 'stream_names', 'predictions', 'base_submits']);
const IDENT = /^[a-z_][a-z0-9_]*$/;
const CHUNK = 256;
const VERBS = { undefined: 'INSERT', ignore: 'INSERT OR IGNORE', replace: 'INSERT OR REPLACE' };

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
    return await stmt.query(...params.map(plain));
  } finally {
    await stmt.close();
  }
}

/**
 * Run the migrations newer than schema_version, each in its own transaction.
 * @returns {Promise<number>} the schema version afterwards
 */
export async function migrate(conn, migrations = MIGRATIONS) {
  await conn.query('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)');
  const row = toRows(await conn.query('SELECT max(version) AS v FROM schema_version'))[0];
  let version = row?.v ?? 0;
  for (; version < migrations.length; version++) {
    await conn.query('BEGIN TRANSACTION');
    try {
      await conn.query(migrations[version]);
      await conn.query('DELETE FROM schema_version');
      await conn.query(`INSERT INTO schema_version VALUES (${version + 1})`);
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    }
  }
  return version;
}

/**
 * Wrap an open DuckDB connection (async browser or blocking node) as the store API.
 * @param {any} conn
 * @param {() => Promise<void>} [closeDb]
 */
export async function createStore(conn, closeDb = async () => conn.close()) {
  await conn.query('SET autoload_known_extensions = false');
  await migrate(conn);

  let tail = Promise.resolve();
  const serial = (fn) => (...args) => {
    const p = tail.then(() => fn(...args));
    tail = p.catch(() => {});
    return p;
  };

  async function insert(table, rows, conflict) {
    if (!TABLES.has(table)) throw new Error(`store.insert: unknown table ${table}`);
    if (!(conflict in VERBS)) throw new Error(`store.insert: bad conflict ${conflict}`);
    if (!rows.length) return 0;
    const columns = Object.keys(rows[0]);
    for (const c of columns) if (!IDENT.test(c)) throw new Error(`store.insert: bad column ${c}`);
    const tuple = `(${columns.map(() => '?').join(',')})`;
    let n = 0;
    await conn.query('BEGIN TRANSACTION');
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const sql = `${VERBS[conflict]} INTO ${table} (${columns.join(',')}) VALUES ${chunk.map(() => tuple).join(',')}`;
        const res = await query(conn, sql, chunk.flatMap((r) => columns.map((c) => r[c] ?? null)));
        n += plain(res.toArray()[0]?.Count ?? 0);
      }
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    }
    return n;
  }

  return {
    rows: serial(async (sql, ...params) => toRows(await query(conn, sql, params))),
    run: serial(async (sql, ...params) => void (await query(conn, sql, params))),
    get: serial(async (key, fallback) => {
      const [row] = toRows(await query(conn, 'SELECT value FROM settings WHERE key = ?', [key]));
      return row ? JSON.parse(row.value) : fallback;
    }),
    set: serial(async (key, value) => {
      if (value == null) return void (await query(conn, 'DELETE FROM settings WHERE key = ?', [key]));
      await query(conn, 'INSERT OR REPLACE INTO settings VALUES (?, ?)', [key, JSON.stringify(value)]);
    }),
    insert: serial(insert),
    values: serial(async (stream, provider, limit = null) => {
      const res = await query(conn,
        `SELECT value FROM (SELECT value, observed_at FROM observations
           WHERE stream_name = ? AND provider_pubkey = ? AND value IS NOT NULL
           ORDER BY observed_at DESC LIMIT ?) ORDER BY observed_at`,
        [stream, provider, limit ?? 2 ** 31 - 1]);
      return /** @type {Float64Array} */ (res.getChild('value')?.toArray() ?? new Float64Array(0));
    }),
    checkpoint: serial(async () => void (await conn.query('CHECKPOINT'))),
    close: serial(async () => {
      await conn.query('CHECKPOINT');
      await closeDb();
    }),
  };
}

/**
 * Open the OPFS database with the startup self-test (storage.md): write a token,
 * close, reopen, read it back. Throws if it did not survive.
 * @param {{open?: () => Promise<{conn: any, close: () => Promise<void>}>}} [opts]
 */
export async function openStore({ open } = {}) {
  open ??= (await import('./opfs.js')).openOPFS;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let h = await open();
  let store = await createStore(h.conn, h.close);
  await store.set('selftest', token);
  await store.close();
  h = await open();
  store = await createStore(h.conn, h.close);
  const back = await store.get('selftest');
  if (back !== token) {
    await store.close();
    throw new Error(`store self-test failed: wrote ${token} to the database, read back ${back} after reopen`);
  }
  return store;
}
