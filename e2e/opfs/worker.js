// Worker side of the OPFS probe: DuckDB eh bundle, opfs://satori.duckdb.
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const violations = [];
self.addEventListener('securitypolicyviolation', (e) =>
  violations.push(`${e.violatedDirective} ${e.blockedURI}`));

async function open() {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker));
  await db.instantiate(bundle.mainModule);
  await db.open({ path: 'opfs://satori.duckdb', accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  const conn = await db.connect();
  await conn.query('SET autoload_known_extensions = false');
  return { db, conn };
}

async function close({ db, conn }) {
  await conn.close();
  await db.terminate();
}

async function readAll(conn) {
  const t = await conn.query('SELECT v FROM probe ORDER BY v');
  return t.getChild('v').toArray().map(String);
}

async function roundtrip(token) {
  let h = await open();
  await h.conn.query('CREATE TABLE IF NOT EXISTS probe (v VARCHAR)');
  await h.conn.query(`INSERT INTO probe VALUES ('${token}')`);
  await h.conn.query('CHECKPOINT');
  const autoloadRow = (await h.conn.query(
    "SELECT value FROM duckdb_settings() WHERE name = 'autoload_known_extensions'")).toArray()[0];
  await close(h);
  h = await open();
  const values = await readAll(h.conn);
  await close(h);
  return { readAfterReopen: values.at(-1), autoload: String(autoloadRow.value) === 'true' };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.cmd === 'roundtrip') self.postMessage({ ...(await roundtrip(data.token)), violations });
    else {
      const h = await open();
      const values = await readAll(h.conn);
      await close(h);
      self.postMessage({ values, violations });
    }
  } catch (err) {
    self.postMessage({ error: String(err?.stack ?? err), violations });
  }
};
