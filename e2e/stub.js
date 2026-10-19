// The e2e's central: the dev server's default, central2, routed to a stub
// (prod is aborted and recorded). It answers register, the observations batch,
// the login and the predictions batch (checking the identity's signature as
// central does: EIP-191 only, anything else is a 401), the
// relay list and config, the merkle proof, and a stream's history when
// `history` is set (else 404, as central2 today); anything else is a 404, as
// prod's /base/config is. Satorian and the owner's dev relay (7778) are never
// reached; /rpc is aborted unless a fake chain is given (e2e/base.spec.js).
import { secp256k1 } from '@noble/curves/secp256k1';
import { verifyMessage } from 'viem';
import { evmAddress } from '../src/keys/keys.js';

export const CENTRAL = 'https://central2.satorinet.io';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, wallet-pubkey, vault-pubkey, nostr-pubkey, neuron-version, message, signature',
};

/**
 * Central's login check (base-upgrade f4d72f5, src/utils/auth.py verify_wallet_signature), EIP-191 only:
 * 0x + r ‖ s ‖ v in 130 hex, v 27/28 or 0/1, low s, recovering the Ethereum address of `wallet-pubkey`.
 * Anything else (another scheme's signature, a high s, garbage) is refused.
 */
async function eip191(h) {
  const sig = h.signature ?? '';
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig) || !['1b', '1c', '00', '01'].includes(sig.slice(-2).toLowerCase())) return false;
  if (BigInt(`0x${sig.slice(66, 130)}`) > secp256k1.CURVE.n / 2n) return false;
  try {
    return await verifyMessage({ address: evmAddress(h['wallet-pubkey']), message: h.message, signature: sig });
  } catch {
    return false;
  }
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {{url?: string, relays?: string[], rpc?: {http: Function}}} [o] relays: central's relay list
 * @returns the stub: set `batch`, `vaults` (vault pubkey → register's `vault_base_address` for it, else null), `otherVault` (the
 *   `vault_base_address` for any vault), `noVaultBase` (no such field: a central on main, as prod), `fail` (statuses for the next
 *   predictions batches), `failRegister` (how many registers answer 503: each register() is resent once on a 5xx), `refuseLogin` (every login is a 401, as for a signature central does not take), `delayMs` (the observations batch), `root` and `proofs` (address → central's proof),
 *   `history` (stream uuid → its rows, oldest first; null: the route 404s), `historyDelayMs` (the n-th history call answers
 *   after n × that: the streams come in one by one); hold(what) keeps the observations batch
 *   (what 'batch', the default: a poll, seen while it runs), register's answer ('register': nothing the neuron does
 *   after it, the poll schedule's write included) or the predictions batch ('submit') until the function it returns is called; read `registered`, `polls` (per observations
 *   batch: how many registers came before it), `logins`, `batches`, `merkleCalls`, `historyCalls`, `prod`, `blocked`.
 */
export async function stubCentral(context, { url = CENTRAL, relays = [], rpc = null } = {}) {
  const held = { batch: null, register: null, submit: null };
  const stub = { batch: [], vaults: {}, otherVault: null, noVaultBase: false, fail: [], failRegister: 0, refuseLogin: false, delayMs: 0, root: null, proofs: {}, history: null,
    historyDelayMs: 0,
    registered: [], polls: [], logins: [], batches: [], merkleCalls: [], historyCalls: [], prod: [], blocked: [],
    hold(what = 'batch') {
      let release;
      held[what] = new Promise((r) => { release = r; });
      return () => { held[what] = null; release(); };
    } };
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
    if (req.method() === 'GET' && pathname === '/api/v1/observations/history') {
      const q = Object.fromEntries(new URL(req.url()).searchParams);
      stub.historyCalls.push(q);
      if (stub.historyDelayMs) await new Promise((r) => setTimeout(r, stub.historyDelayMs * stub.historyCalls.length));
      if (!stub.history) return reply(route, 404, { detail: 'Not Found' });
      const since = Number(q.since ?? -Infinity);
      return reply(route, 200, (stub.history[q.stream_uuid] ?? []).filter((o) => Number(o.observed_at) > since).slice(-Number(q.limit ?? 500)));
    }
    switch (`${req.method()} ${pathname}${search}`) {
      case 'POST /api/v1/peer/register': {
        stub.registered.push(h);
        await held.register;
        if (stub.failRegister > 0) { // central down for a moment: a 503 (the client resends it once)
          stub.failRegister--;
          return reply(route, 503, { detail: 'unavailable' });
        }
        // central base-upgrade d8a2085's answer; wallet_address and vault_address are its other forms, never read
        const answer = { success: true, peer_id: 7, wallet_address: 'Eid', vault_address: 'Evault', message: 'Peer registered successfully' };
        if (!stub.noVaultBase) answer.vault_base_address = stub.otherVault ?? stub.vaults[h['vault-pubkey']] ?? null;
        return reply(route, 200, answer);
      }
      case 'GET /api/v1/peer/relays':
        return reply(route, 200, relays.map((r) => ({ relay_url: r, nostr_pubkey: 'x' })));
      case 'GET /api/v1/peer/relay-config':
        return reply(route, 200, { max_streams: 60 });
      case 'GET /api/v1/observations/batch?limit=100': {
        stub.polls.push(stub.registered.length);
        await held.batch;
        const { batch } = stub;
        if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
        return reply(route, 200, batch);
      }
      case 'GET /api/v1/auth/challenge':
        return reply(route, 200, { challenge: `c-${stub.logins.length}` });
      case 'POST /api/v1/auth/login': {
        const ok = !stub.refuseLogin && await eip191(h);
        stub.logins.push({ ...h, ok });
        return ok ? reply(route, 200, { access_token: `jwt-${stub.logins.length}`, expires_in: 3600 })
          : reply(route, 401, { detail: 'Invalid signature' });
      }
      case 'POST /api/v1/predictions/batch': {
        await held.submit;
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
