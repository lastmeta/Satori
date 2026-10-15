// The real db module on OPFS (its own file, not the app's), for e2e/store.spec.js.
// 'app-meta' reads (and with a value, writes) one meta row of the app's own db.
import { openOpfsDb, DB_PATH } from '../../src/db/opfs.js';

window.violations = [];
document.addEventListener('securitypolicyviolation', (e) =>
  window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));

let db;
window.probe = async ({ cmd, token, key, value }) => {
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
    db ??= await openOpfsDb('opfs://e2e-smoke.duckdb');
    if (cmd === 'write') {
      await db.set('e2e', token);
      await db.addObservations([1, 2, 3].map((i) => ({ stream_uuid: token, name: token, meta: null, ts: i, value: i * 10 })));
      await db.checkpoint(); // as cycle() does; the reload is the only shutdown, as in a tab
    }
    return { setting: await db.get('e2e'), values: (await db.history(token)).map((o) => o.value), version: db.version };
  } catch (err) {
    return { error: String(err?.stack ?? err) };
  }
};
