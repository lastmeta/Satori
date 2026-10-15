// Test helper: DuckDB-WASM's node blocking bundle (same duckdb-eh.wasm as the
// browser), in memory. Not imported by the app. Other modules' tests can use
//   const duck = await nodeDuckDB(); const store = await createStore(duck.connect());
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import duckdb from '@duckdb/duckdb-wasm/blocking';

/** @returns {Promise<{db: any, connect: () => any, reset: () => void}>} */
export async function nodeDuckDB() {
  const dist = dirname(createRequire(import.meta.url).resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));
  const db = await duckdb.createDuckDB({
    mvp: { mainModule: `${dist}/duckdb-mvp.wasm`, mainWorker: '' },
    eh: { mainModule: `${dist}/duckdb-eh.wasm`, mainWorker: '' },
  }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  db.open({});
  return {
    db,
    connect: () => db.connect(),
    /** Drop everything: a fresh in-memory database. */
    reset: () => { db.reset(); db.open({}); },
  };
}
