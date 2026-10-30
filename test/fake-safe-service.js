// Safe's transaction service, faked (docs/design/safe.md): the three calls src/chain/safe.js makes, kept in memory.
// `fetch` for unit tests; `route` for Playwright (context.route(`${SAFE_SERVICE}/**`, svc.route)). Owners are taken
// from the signatures, as the service does.
import { getAddress, recoverAddress } from 'viem';
import { safeTx, safeTxHash } from '../src/chain/safe.js';

export function fakeSafeService({ chainId = 84532 } = {}) {
  const txs = []; // { safe, safeTxHash, nonce, to, value, data, operation, isExecuted, confirmations: [{ owner, signature }] }
  async function handle(method, url, body) {
    const path = new URL(url).pathname.replace(/^\/tx-service\/basesep/, '');
    let m = path.match(/^\/api\/v2\/safes\/(0x[0-9a-fA-F]{40})\/multisig-transactions\/$/);
    if (m && method === 'GET') {
      const q = new URL(url).searchParams;
      const from = BigInt(q.get('nonce__gte') ?? 0);
      const results = txs.filter((t) => t.safe === getAddress(m[1]) && !t.isExecuted && BigInt(t.nonce) >= from).sort((a, b) => Number(a.nonce) - Number(b.nonce));
      return { status: 200, json: { count: results.length, results } };
    }
    if (m && method === 'POST') {
      const b = JSON.parse(body);
      const tx = safeTx({ safe: m[1], to: b.to, data: b.data, nonce: b.nonce });
      const hash = safeTxHash(chainId, tx);
      if (hash !== b.contractTransactionHash) return { status: 422, json: { detail: 'contractTransactionHash is not valid' } };
      const owner = await recoverAddress({ hash, signature: b.signature });
      if (owner !== getAddress(b.sender)) return { status: 422, json: { detail: 'signature is not the sender\'s' } };
      txs.push({ safe: tx.safe, safeTxHash: hash, nonce: b.nonce, to: tx.to, value: '0', data: b.data, operation: 0, isExecuted: false,
        confirmations: [{ owner, signature: b.signature }] });
      return { status: 201 };
    }
    m = path.match(/^\/api\/v1\/multisig-transactions\/(0x[0-9a-fA-F]{64})\/confirmations\/$/);
    if (m && method === 'POST') {
      const t = txs.find((x) => x.safeTxHash === m[1]);
      if (!t) return { status: 404, json: { detail: 'Not found' } };
      const { signature } = JSON.parse(body);
      const owner = await recoverAddress({ hash: t.safeTxHash, signature });
      if (t.confirmations.some((c) => c.owner === owner)) return { status: 400, json: { detail: 'already signed' } };
      t.confirmations.push({ owner, signature });
      return { status: 201 };
    }
    return { status: 404, json: { detail: `fake Safe service: ${method} ${path}` } };
  }
  const response = (r) => new Response(r.json ? JSON.stringify(r.json) : null, { status: r.status, headers: { 'content-type': 'application/json' } });
  return {
    txs,
    /** Executed on chain: the service learns it (as it would from the chain). */
    executed: (nonce) => { for (const t of txs) if (BigInt(t.nonce) === BigInt(nonce)) t.isExecuted = true; },
    fetch: async (url, init = {}) => response(await handle(init.method ?? 'GET', url, init.body)),
    route: async (route) => {
      const r = await handle(route.request().method(), route.request().url(), route.request().postData());
      await route.fulfill({ status: r.status, contentType: 'application/json', body: r.json ? JSON.stringify(r.json) : '', headers: { 'access-control-allow-origin': '*' } });
    },
  };
}
