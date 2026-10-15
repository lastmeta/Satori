// Test helper (never imported by the app): DuckDB-WASM's node blocking bundle,
// the same duckdb-eh.wasm as the browser, in memory. Each call returns a fresh,
// empty database; the wasm is instantiated once per test file.
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import duckdb from '@duckdb/duckdb-wasm/blocking';
import { openDb } from '../src/db/index.js';

let duck;

/** A connection to a fresh, empty in-memory database. */
export async function memoryConn() {
  if (duck) {
    duck.reset();
  } else {
    const dist = dirname(createRequire(import.meta.url).resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));
    duck = await duckdb.createDuckDB({
      mvp: { mainModule: `${dist}/duckdb-mvp.wasm`, mainWorker: '' },
      eh: { mainModule: `${dist}/duckdb-eh.wasm`, mainWorker: '' },
    }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await duck.instantiate();
  }
  duck.open({});
  return duck.connect();
}

export const memoryDb = async () => openDb(await memoryConn());
