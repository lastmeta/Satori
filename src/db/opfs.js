// Browser opener: DuckDB-WASM 1.32.0 (eh bundle, mvp fallback) on OPFS.
// DuckDB runs in its own worker; this returns an async connection.
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { openDb } from './index.js';

export const DB_PATH = 'opfs://satori.duckdb';

export async function openOpfsDb(path = DB_PATH) {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const duck = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker));
  await duck.instantiate(bundle.mainModule);
  await duck.open({ path, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  const conn = await duck.connect();
  return openDb(conn, async () => { await conn.close(); await duck.terminate(); });
}
