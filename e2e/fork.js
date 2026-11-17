// The local test chain for the e2e that need the real contracts (docs/design/base.md#the-local-fork-dev): an anvil fork of
// Base Sepolia on :8545 (node scripts/fork.mjs start). Those specs run only while it answers (dev tests, the owner,
// 2026-11-06); the stub central (stub.js) sends the page's /rpc to it with forkRpc.
export const FORK = 'http://127.0.0.1:8545';

/** The fork answers. */
export const forkUp = async () => {
  try {
    const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
    return r.ok;
  } catch {
    return false;
  }
};

/** stubCentral's `rpc`: the page's /rpc to the fork (the stub aborts it otherwise). */
export const forkRpc = { http: async (body) => (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() };
