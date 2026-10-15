// Browser opener: DuckDB-WASM 1.32.0, eh bundle (mvp fallback), on
// opfs://satori.duckdb. Call only from the leader tab's neuron worker.
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

export const DB_PATH = 'opfs://satori.duckdb';

/** @returns {Promise<{conn: any, close: () => Promise<void>}>} */
export async function openOPFS(path = DB_PATH) {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker));
  await db.instantiate(bundle.mainModule);
  await db.open({ path, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  const conn = await db.connect();
  return { conn, close: async () => { await conn.close(); await db.terminate(); } };
}
