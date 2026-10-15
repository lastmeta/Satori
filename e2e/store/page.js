// The real db module on OPFS (its own file, not the app's), for e2e/store.spec.js.
import { openOpfsDb } from '../../src/db/opfs.js';

window.violations = [];
document.addEventListener('securitypolicyviolation', (e) =>
  window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));

let db;
window.probe = async ({ cmd, token }) => {
  try {
    db ??= await openOpfsDb('opfs://e2e-smoke.duckdb');
    if (cmd === 'write') {
      await db.set('e2e', token);
      await db.addStream({ name: token, url: 'https://x', path: 'v', interval_s: 60 });
      for (const i of [1, 2, 3]) await db.addObservation(token, i, i * 10);
      await db.checkpoint(); // as tick() does; the reload is the only shutdown, as in a tab
    }
    return { setting: await db.get('e2e'), values: (await db.recent(token, 10)).map((o) => o.value), version: db.version };
  } catch (err) {
    return { error: String(err?.stack ?? err) };
  }
};
