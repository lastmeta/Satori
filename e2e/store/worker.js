// Worker side of the store probe: the real store module on opfs://satori.duckdb.
// 'write' leaves the database open: the page reload is the only shutdown, as in a tab.
import { openStore } from '../../src/store/index.js';

let store;
const violations = [];
self.addEventListener('securitypolicyviolation', (e) =>
  violations.push(`${e.violatedDirective} ${e.blockedURI}`));

async function handle({ cmd, token }) {
  store ??= await openStore();
  if (cmd === 'write') {
    await store.set('e2e', token);
    await store.insert('observations', [1, 2, 3].map((i) => ({
      stream_name: token, provider_pubkey: 'base', seq_num: i, observed_at: i, value: i * 10, round: i,
    })), 'ignore');
    await store.checkpoint();
  }
  return {
    setting: await store.get('e2e'),
    values: [...(await store.values(token, 'base'))],
    version: (await store.rows('SELECT version FROM schema_version'))[0].version,
  };
}

self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ ...(await handle(data)), violations });
  } catch (err) {
    self.postMessage({ error: String(err?.stack ?? err), violations });
  }
};
