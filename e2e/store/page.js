// The real db module on OPFS (its own file, not the app's), for e2e/store.spec.js and e2e/wal.spec.js.
// 'app-meta' reads (and with a value, writes) one meta row of the app's own db; 'app-activity' adds rows to its
// activity log (and with clear, empties it first).
// 'raw' runs SQL on a plain DuckDB connection (no openDb, DuckDB's own settings), then
// leaves without a checkpoint, as an older version of the app would have.
import { openOpfsDb, connectOpfs, DB_PATH } from '../../src/db/opfs.js';

window.violations = [];
document.addEventListener('securitypolicyviolation', (e) =>
  window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));

let db;
window.probe = async ({ cmd, token, key, value, path = 'opfs://e2e-smoke.duckdb', sql = [], rows = [], clear = false }) => {
  try {
    if (cmd === 'app-meta') {
      const app = await openOpfsDb(DB_PATH);
      try {
        if (value !== undefined) await app.set(key, value);
        return { value: await app.get(key) };
      } finally {
        await app.close();
      }
    }
    if (cmd === 'app-activity') { // the app's activity log (docs/design/health.md): `rows` added, after all of it went if `clear`
      const app = await openOpfsDb(DB_PATH);
      try {
        if (clear) await app.pruneActivity(Number.MAX_SAFE_INTEGER);
        for (const r of rows) await app.addActivity(r);
        return { rows: await app.activity(0) };
      } finally {
        await app.close();
      }
    }
    if (cmd === 'raw') {
      const { conn } = await connectOpfs(path);
      const out = [];
      for (const s of sql) out.push((await conn.query(s)).toArray().map((r) => r.toJSON()));
      return { rows: JSON.parse(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? Number(v) : v))) };
    }
    db ??= await openOpfsDb(path);
    if (cmd === 'write' || cmd === 'write-no-checkpoint') {
      await db.set('e2e', token);
      await db.addObservations([1, 2, 3].map((i) => ({ stream_uuid: token, name: token, meta: null, ts: i, value: i * 10 })));
      if (cmd === 'write') await db.checkpoint(); // as cycle() does; the reload is the only shutdown, as in a tab
    }
    return { setting: await db.get('e2e'), values: (await db.history(token)).map((o) => o.value), version: db.version,
      recovered: db.recovered };
  } catch (err) {
    return { error: String(err?.stack ?? err) };
  }
};
