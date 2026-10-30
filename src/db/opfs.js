// Browser opener: DuckDB-WASM 1.32.0 (eh bundle, mvp fallback) on OPFS.
// DuckDB runs in its own worker; this returns an async connection. A WAL an
// older version left is settled first (recover.js, docs/design/storage.md#recovery).
// Its steps (the wasm's download, in bytes on the wire; starting; opening) are
// reported as they go, so a first visit's wait is never silent
// (docs/design/storage.md#the-first-visit).
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { openDb } from './index.js';
import { settleWal, setAsideWal, setAsideDatabase, fileBytes } from './recover.js';
import { transferProgress } from './progress.js';

/* global __DUCKDB_EH_BYTES__ */
const EH_BYTES = typeof __DUCKDB_EH_BYTES__ === 'number' ? __DUCKDB_EH_BYTES__ : null; // the eh wasm, decoded (vite.config.js)

// Not 'satori.duckdb': the draft/v1-full app left a different schema under that name on this origin.
export const DB_PATH = 'opfs://satori-mvp.duckdb';

/** Whether this origin has the database yet: none means a first visit (Setup shows at once, before DuckDB loads). */
export async function hasDatabase(path = DB_PATH) {
  const dir = await navigator.storage.getDirectory();
  try {
    await dir.getFileHandle(path.slice('opfs://'.length));
    return true;
  } catch (err) {
    if (err?.name === 'NotFoundError') return false;
    throw err;
  }
}

/**
 * A failure of the database file itself (DuckDB's open, or the migrations; not the engine's download, not a newer
 * version's database): the app offers "Set aside and start again" (docs/design/storage.md#recovery). `dbFile: true`.
 */
function fileError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  // DuckDB-WASM's worker sends "Opening the database failed with error: {…"exception_message":"Corrupt database file: …"}"
  const m = /"exception_message":"((?:[^"\\]|\\.)*)"/.exec(e.message);
  if (m) {
    try { e.message = JSON.parse(`"${m[1]}"`); } catch { /* as it was */ }
  }
  return Object.assign(e, { dbFile: true });
}

/**
 * DuckDB in its own worker with `path` open → { conn, close }. On a failure the worker is ended, letting go of the files.
 * onStep({ step: 'download', loaded, total } | { step: 'start' } | { step: 'open' }): the wasm's download in bytes on
 * the wire (transferProgress), its start (compiled), the database opening.
 */
export async function connectOpfs(path, { onStep = () => {}, readOnly = false } = {}) {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const raw = bundle.mainModule === ehWasm ? EH_BYTES : null;
  const duck = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker));
  try {
    onStep({ step: 'download', loaded: 0, total: null });
    await duck.instantiate(bundle.mainModule, null, (p) => {
      const t = transferProgress(p, raw);
      onStep(t.total && t.loaded >= t.total ? { step: 'start' } : { step: 'download', ...t });
    });
    onStep({ step: 'open' });
    let conn;
    try {
      await duck.open({ path, accessMode: readOnly ? duckdb.DuckDBAccessMode.READ_ONLY : duckdb.DuckDBAccessMode.READ_WRITE });
      conn = await duck.connect();
    } catch (err) {
      throw fileError(err);
    }
    return { conn, close: async () => { await conn.close(); await duck.terminate(); } };
  } catch (err) {
    await duck.terminate().catch(() => {});
    throw err;
  }
}

/**
 * The database, migrated. `recovered`: the name a WAL DuckDB could not replay
 * was set aside under (its changes are not in the database), or null. onStep: connectOpfs's.
 */
export async function openOpfsDb(path = DB_PATH, { onStep } = {}) {
  const name = path.slice('opfs://'.length);
  const dir = await navigator.storage.getDirectory();
  const recovered = await settleWal({
    walBytes: () => fileBytes(dir, `${name}.wal`),
    async checkpoint() {
      const { conn, close } = await connectOpfs(path, { onStep });
      try {
        await conn.query('CHECKPOINT');
      } finally {
        await close();
      }
    },
    setAside: (kind) => setAsideWal(dir, name, kind),
  });
  const { conn, close } = await connectOpfs(path, { onStep });
  const db = await openDb(conn, close).catch(async (err) => {
    await close().catch(() => {});
    throw err?.newer ? err : fileError(err); // a newer version's database is no damage: its words, and Reload
  });
  return Object.assign(db, { recovered });
}

/**
 * "Set aside and start again": the database file (and its WAL) renamed `…corrupt-<time>`, never deleted
 * (recover.js setAsideDatabase). Only once DuckDB has let go of it: after a failed open, its worker is ended.
 * → the file's new name
 */
export async function setAsideOpfsDb(path = DB_PATH) {
  return setAsideDatabase(await navigator.storage.getDirectory(), path.slice('opfs://'.length));
}

/**
 * Another wallet's stored keys record (meta `keys`), read from its database file without opening it for the app: a
 * second DuckDB, read only, ended at once. → the record as stored (its alias and Nostr key may be sealed), or null when
 * the file has none (a wallet never set up).
 */
export async function readStoredKeys(file) {
  if (!(await hasDatabase(`opfs://${file}`))) return null;
  const { conn, close } = await connectOpfs(`opfs://${file}`, { readOnly: true });
  try {
    const t = await conn.query("SELECT value FROM meta WHERE key = 'keys'");
    const v = t.toArray()[0]?.value;
    return v == null ? null : JSON.parse(String(v));
  } finally {
    await close();
  }
}
