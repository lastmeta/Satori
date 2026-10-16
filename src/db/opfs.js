// Browser opener: DuckDB-WASM 1.32.0 (eh bundle, mvp fallback) on OPFS.
// DuckDB runs in its own worker; this returns an async connection. A WAL an
// older version left is settled first (recover.js, docs/design/storage.md#recovery).
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { openDb } from './index.js';
import { settleWal, setAsideWal, fileBytes } from './recover.js';

// Not 'satori.duckdb': the draft/v1-full app left a different schema under that name on this origin.
export const DB_PATH = 'opfs://satori-mvp.duckdb';

/** DuckDB in its own worker with `path` open → { conn, close }. On a failure the worker is ended, letting go of the files. */
export async function connectOpfs(path) {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const duck = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker));
  try {
    await duck.instantiate(bundle.mainModule);
    await duck.open({ path, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    const conn = await duck.connect();
    return { conn, close: async () => { await conn.close(); await duck.terminate(); } };
  } catch (err) {
    await duck.terminate().catch(() => {});
    throw err;
  }
}

/**
 * The database, migrated. `recovered`: the name a WAL DuckDB could not replay
 * was set aside under (its changes are not in the database), or null.
 */
export async function openOpfsDb(path = DB_PATH) {
  const name = path.slice('opfs://'.length);
  const dir = await navigator.storage.getDirectory();
  const recovered = await settleWal({
    walBytes: () => fileBytes(dir, `${name}.wal`),
    async checkpoint() {
      const { conn, close } = await connectOpfs(path);
      try {
        await conn.query('CHECKPOINT');
      } finally {
        await close();
      }
    },
    setAside: (kind) => setAsideWal(dir, name, kind),
  });
  const { conn, close } = await connectOpfs(path);
  const db = await openDb(conn, close).catch(async (err) => {
    await close().catch(() => {});
    throw err;
  });
  return Object.assign(db, { recovered });
}
