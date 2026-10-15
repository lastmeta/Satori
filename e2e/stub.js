// The e2e's central: the dev server's default, central2, routed to a stub
// (prod is aborted and recorded). It answers register, the observations batch,
// the login and the predictions batch (checking the identity's signature), the
// relay list and config, and the merkle proof; anything else is a 404, as
// prod's /base/config is. Satorian and the owner's dev relay (7778) are never
// reached; /rpc is aborted unless a fake chain is given (e2e/base.spec.js).
import { verifyMessage } from '../src/keys/index.js';

export const CENTRAL = 'https://central2.satorinet.io';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, wallet-pubkey, vault-pubkey, nostr-pubkey, neuron-version, message, signature',
};

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {{url?: string, relays?: string[], rpc?: {http: Function}}} [o] relays: central's relay list
 * @returns the stub: set `batch`, `vaults` (vault pubkey → address), `otherVault`, `fail` (statuses for the next
 *   predictions batches), `delayMs` (the observations batch), `root` and `proofs` (address → central's proof);
 *   read `registered`, `logins`, `batches`, `merkleCalls`, `prod`, `blocked`.
 */
export async function stubCentral(context, { url = CENTRAL, relays = [], rpc = null } = {}) {
  const stub = { batch: [], vaults: {}, otherVault: null, fail: [], delayMs: 0, root: null, proofs: {},
    registered: [], logins: [], batches: [], merkleCalls: [], prod: [], blocked: [] };
  const reply = (route, status, json) => route.fulfill({ status, json, headers: CORS });
  await context.routeWebSocket((u) => u.hostname === 'satorian.satorinet.io' || u.port === '7778', (ws) => {
    stub.blocked.push(ws.url());
    ws.close();
  });
  await context.route('https://network.satorinet.io/**', (route) => {
    stub.prod.push(route.request().url());
    return route.abort();
  });
  await context.route('**/rpc', async (route) => (rpc
    ? route.fulfill({ json: await rpc.http(JSON.parse(route.request().postData())) }) : route.abort()));
  await context.route(`${url}/**`, async (route) => {
    const req = route.request();
    const h = req.headers();
    const { pathname, search } = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (pathname.startsWith('/api/v1/merkle/proof/')) {
      stub.merkleCalls.push(pathname);
      if (!stub.root) return reply(route, 404, { detail: 'no reward drop has been published yet' });
      const p = stub.proofs[pathname.split('/').pop().toLowerCase()];
      return p ? reply(route, 200, p) : reply(route, 404, { detail: 'not in the current drop' });
    }
    switch (`${req.method()} ${pathname}${search}`) {
      case 'POST /api/v1/peer/register':
        stub.registered.push(h);
        return reply(route, 200, { success: true, peer_id: 7, wallet_address: 'Eid', message: 'Peer registered successfully',
          vault_address: stub.otherVault ?? stub.vaults[h['vault-pubkey']] ?? null });
      case 'GET /api/v1/peer/relays':
        return reply(route, 200, relays.map((r) => ({ relay_url: r, nostr_pubkey: 'x', evr_address: 'E' })));
      case 'GET /api/v1/peer/relay-config':
        return reply(route, 200, { max_streams: 60 });
      case 'GET /api/v1/observations/batch?limit=100': {
        const { batch } = stub;
        if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
        return reply(route, 200, batch);
      }
      case 'GET /api/v1/auth/challenge':
        return reply(route, 200, { challenge: `c-${stub.logins.length}` });
      case 'POST /api/v1/auth/login': {
        const ok = verifyMessage(h.message, h.signature, { pubkey: h['wallet-pubkey'] });
        stub.logins.push({ ...h, ok });
        return ok ? reply(route, 200, { access_token: `jwt-${stub.logins.length}`, expires_in: 3600 })
          : reply(route, 401, { detail: 'Invalid signature' });
      }
      case 'POST /api/v1/predictions/batch': {
        if (h.authorization !== `Bearer jwt-${stub.logins.length}`) return reply(route, 401, { detail: 'bad token' });
        const status = stub.fail.shift();
        if (status) return reply(route, status, { detail: 'boom' });
        const { predictions } = JSON.parse(req.postData());
        stub.batches.push(predictions);
        return reply(route, 200, { total_submitted: predictions.length, successful: predictions.length, failed: 0,
          prediction_ids: predictions.map((_, i) => i + 1), errors: null });
      }
      default:
        return reply(route, 404, { detail: 'Not Found' });
    }
  });
  return stub;
}
