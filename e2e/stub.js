// The e2e's central: the dev server's default, central2, routed to a stub
// (prod is aborted and recorded). It answers register (checking the wallet's link to the alias as central does,
// docs/design/wallets.md), the observations batch,
// the login and the predictions batch (checking the alias's signature as
// central does: EIP-191 only, anything else is a 401), the
// relay list and config, the merkle proof, the reward address (signed in,
// checked for a Base address as central's base-upgrade change does), and a
// stream's history when `history` is set (else 404, as central2 today);
// anything else is a 404, as prod's /base/config is. A token is good until the
// stub ends, as central's last an hour. Satorian, its wss stand-in (wss://relay.satorinet.io) and the owner's dev
// relay (7778) are never reached; /rpc is aborted unless a fake chain is given (e2e/base.spec.js).
import { secp256k1 } from '@noble/curves/secp256k1';
import { getAddress, isAddress, recoverMessageAddress, verifyMessage, zeroAddress } from 'viem';
import { evmAddress } from '../src/keys/keys.js';

export const CENTRAL = 'https://central2.satorinet.io';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, alias-pubkey, wallet-link, wallet-signature, nostr-pubkey, neuron-version, message, signature',
};

/**
 * Central's login check (base-upgrade f4d72f5, src/utils/auth.py verify_wallet_signature), EIP-191 only:
 * 0x + r ‖ s ‖ v in 130 hex, v 27/28 or 0/1, low s, recovering the Ethereum address of `alias-pubkey`.
 * Anything else (another scheme's signature, a high s, garbage) is refused.
 */
async function eip191(h) {
  const sig = h.signature ?? '';
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig) || !['1b', '1c', '00', '01'].includes(sig.slice(-2).toLowerCase())) return false;
  if (BigInt(`0x${sig.slice(66, 130)}`) > secp256k1.CURVE.n / 2n) return false;
  try {
    return await verifyMessage({ address: evmAddress(h['alias-pubkey']), message: h.message, signature: sig });
  } catch {
    return false;
  }
}

/** Register's link check, as central: → { wallet } (the linked wallet's address) or { error }; {} with no link.
 * heldIssued: the issued of a newer link central holds for the wallet (another alias's), so an older one is refused. */
async function linkOf(h, heldIssued = 0) {
  if (!h['wallet-link']) return {};
  try {
    const message = Buffer.from(h['wallet-link'], 'base64').toString('utf8');
    const [title, alias, wallet] = message.split('\n');
    if (title !== 'Satori: link this alias to my wallet') return { error: 'not a link' };
    if (alias !== `alias: ${evmAddress(h['alias-pubkey'])}`) return { error: 'the link names another alias' };
    const signer = await recoverMessageAddress({ message, signature: h['wallet-signature'] });
    if (wallet !== `wallet: ${signer}`) return { error: 'the signature is not the wallet\'s' };
    const issued = /^issued: (\d+)$/.exec(message.split('\n')[3] ?? ''); // as central: whole unix seconds
    if (!issued) return { error: "the link message's issued line must be 'issued: <unix seconds>'" };
    if (Number(issued[1]) < heldIssued) return { error: 'the link is older than the one held for this wallet' };
    return { wallet: signer };
  } catch {
    return { error: 'not a link' };
  }
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {{url?: string, relays?: string[], rpc?: {http: Function}}} [o] relays: central's relay list
 * @returns the stub: set `batch`, `otherWallet` (register's `wallet_address` whatever the link: central pays another
 *   address), `noWalletAddress` (no such field: a central that does not say), `fail` (statuses for the next
 *   predictions batches), `failRegister` (how many registers answer 503: each register() is resent once on a 5xx), `refuseLogin` (every login is a 401, as for a signature central does not take), `delayMs` (the observations batch), `root` and `proofs` (address → central's proof),
 *   `history` (stream uuid → its rows, oldest first; null: the route 404s), `reward` (the reward address central keeps:
 *   null or a 0x address, as central answers it since 8dcc016), `rewardHold` (a promise the reward-address calls wait
 *   for), `rewardRefuse` (the detail every POST is refused with, a 400, e.g. 'Invalid Base address'), `historyDelayMs` (the n-th history call answers
 *   after n × that: the streams come in one by one); hold(what) keeps the observations batch
 *   (what 'batch', the default: a poll, seen while it runs), register's answer ('register': nothing the neuron does
 *   after it, the poll schedule's write included) or the predictions batch ('submit') until the function it returns is called; read `registered`, `polls` (per observations
 *   batch: how many registers came before it), `logins`, `batches`, `merkleCalls`, `historyCalls`, `rewardCalls` ({ method, body,
 *   authorization }), `prod`, `blocked`.
 */
export async function stubCentral(context, { url = CENTRAL, relays = [], rpc = null } = {}) {
  const held = { batch: null, register: null, submit: null };
  const stub = { batch: [], otherWallet: null, noWalletAddress: false, fail: [], failRegister: 0, refuseLogin: false, delayMs: 0, root: null, proofs: {}, history: null,
    historyDelayMs: 0, reward: null, rewardHold: null, rewardRefuse: null,
    registered: [], polls: [], logins: [], batches: [], merkleCalls: [], historyCalls: [], rewardCalls: [], prod: [], blocked: [],
    hold(what = 'batch') {
      let release;
      held[what] = new Promise((r) => { release = r; });
      return () => { held[what] = null; release(); };
    } };
  const reply = (route, status, json) => route.fulfill({ status, json, headers: CORS });
  const issued = new Set(); // every token a login gave: good until the stub ends (central's last an hour)
  const signedIn = (h) => issued.has(String(h.authorization ?? '').replace(/^Bearer /, ''));
  await context.routeWebSocket((u) => ['satorian.satorinet.io', 'relay.satorinet.io'].includes(u.hostname) || u.port === '7778', (ws) => {
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
    if (pathname === '/api/v1/peer/reward-address' && ['GET', 'POST'].includes(req.method())) {
      const body = req.postData();
      stub.rewardCalls.push({ method: req.method(), body: body == null ? null : JSON.parse(body), authorization: h.authorization });
      await stub.rewardHold;
      if (!signedIn(h)) return reply(route, 401, { detail: 'bad token' });
      if (req.method() === 'GET') return reply(route, 200, { reward_address: stub.reward });
      // central base-upgrade: a 20-byte 0x address, not the zero address, stored EIP-55; null clears
      const a = JSON.parse(body).reward_address;
      if (stub.rewardRefuse) return reply(route, 400, { detail: stub.rewardRefuse });
      if (a !== null && !(typeof a === 'string' && isAddress(a, { strict: false }) && a.toLowerCase() !== zeroAddress)) {
        return reply(route, 400, { detail: 'Invalid Base address' });
      }
      stub.reward = a === null ? null : getAddress(a);
      return reply(route, 200, { reward_address: stub.reward });
    }
    switch (`${req.method()} ${pathname}${search}`) {
      case 'POST /api/v1/peer/register': {
        stub.registered.push(h);
        await held.register;
        if (stub.failRegister > 0) { // central down for a moment: a 503 (the client resends it once)
          stub.failRegister--;
          return reply(route, 503, { detail: 'unavailable' });
        }
        const answer = { success: true, peer_id: 7, message: 'Peer registered successfully' };
        if (!stub.noWalletAddress) {
          const link = await linkOf(h, stub.heldIssued);
          answer.wallet_address = stub.otherWallet ?? link.wallet ?? null;
          if (link.error) answer.wallet_link_error = link.error;
        }
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
        if (ok) issued.add(`jwt-${stub.logins.length}`);
        return ok ? reply(route, 200, { access_token: `jwt-${stub.logins.length}`, expires_in: 3600 })
          : reply(route, 401, { detail: 'Invalid signature' });
      }
      case 'POST /api/v1/predictions/batch': {
        await held.submit;
        if (!signedIn(h)) return reply(route, 401, { detail: 'bad token' });
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
