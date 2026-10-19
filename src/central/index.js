// Central's API as Satori Lite uses it (docs/design/central.md):
//   const c = createCentral({ url, identity, version })
//   await c.register({ vaultPubkey, nostrPubkey })   // POST /peer/register (its vault_base_address: neuron register())
//   await c.relays() / c.relayConfig()       // GET /peer/relays, /peer/relay-config (Nostr)
//   await c.observations()                   // GET /observations/batch?limit=100
//   await c.history(uuid, { limit, since })  // GET /observations/history: one stream's past (beyond Lite; may 404)
//   await c.submitPredictions(items)         // login (identity) → POST /predictions/batch; one retry on 401
//   await c.rewardAddress() / c.setRewardAddress(address | null)   // login → GET / POST /peer/reward-address
//   await c.baseConfig() / c.merkleProof(address)   // Base (docs/design/base.md); 404 is a CentralError
// Errors are CentralError: status 0 for a timeout or a network failure. A
// network error, a timeout or a 5xx is resent once.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { emit } from '../traffic.js';

export const TIMEOUT_MS = 15_000; // satorilib: 10 s register, 15 s login and calls (server.py:106,207,405)

/**
 * One `/predictions/batch` item with Lite's fields (engine.py:1044-1106,
 * 1188-1206): value = t2, t1_value = t1, observed_at = unix seconds at
 * prediction, each as text (central's schema has strings and reads them with
 * float(); the text is JS's, not Python's: docs/design/central.md#the-protocol-audit),
 * hash = sha256(value + observed_at)[:16].
 * @param {{streamUuid: string, streamName: string, t1: number, t2: number, now?: number}} p
 */
export function predictionItem({ streamUuid, streamName, t1, t2, now = Date.now() / 1000 }) {
  const value = String(t2);
  const observedAt = String(now);
  return {
    stream_uuid: streamUuid,
    stream_name: streamName,
    value,
    t1_value: String(t1),
    observed_at: observedAt,
    hash: bytesToHex(sha256(utf8ToBytes(value + observedAt))).slice(0, 16),
  };
}

/** Unix seconds Lite takes as a time: 2000–2100, exclusive (data_helper.py:_parse_epoch; start.py:1413-1424 for relays). */
export const EPOCH = [946_684_800, 4_102_444_800];

function parseEpoch(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (n > EPOCH[0] && n < EPOCH[1]) return n;
  const s = String(raw);
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`); // no zone = UTC
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * A `/observations/batch` entry → `{stream_uuid, name, meta, ts, value}`, or
 * null without a stream, a finite value or a time. As Lite: the time is
 * observed_at, else ts (data_helper.py:40-93), in whole seconds (engine.py:669-673).
 */
export function normalizeObservation(obs) {
  const stream = obs?.stream ?? {};
  const uuid = obs?.stream_uuid || stream.uuid;
  const raw = obs?.value;
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  const epoch = parseEpoch(obs?.observed_at || obs?.ts);
  if (!uuid || !Number.isFinite(value) || epoch == null) return null;
  const meta = stream.meta == null ? null : typeof stream.meta === 'string' ? stream.meta : JSON.stringify(stream.meta);
  return { stream_uuid: uuid, name: stream.name ?? 'unknown', meta, ts: Math.floor(epoch), value };
}

export class CentralError extends Error {
  constructor(status, detail, message = `Satori Network ${status}: ${detail}`) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @param {{url: string, identity: {pubkey: string, signCentralLogin: (msg: string) => string}, version: string, fetch?: typeof fetch,
 *   onTraffic?: () => void}} opts onTraffic: each request and each answer (Home's glow, src/traffic.js)
 */
export function createCentral({ url, identity, version, fetch: fetchFn = globalThis.fetch, onTraffic = () => emit('central') }) {
  const base = url.replace(/\/+$/, '');

  async function once(method, path, headers, body) {
    let res;
    let text;
    try {
      onTraffic();
      res = await fetchFn(base + path, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = await res.text();
      onTraffic();
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new CentralError(0, 'timeout', `Satori Network timed out (${TIMEOUT_MS / 1000} s)`);
      // nginx's 429/502 pages have no CORS header: the browser shows them as this TypeError too.
      throw new CentralError(0, 'network', `Satori Network unreachable: ${err?.message ?? err}`);
    }
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw new CentralError(res.status, typeof data?.detail === 'string' ? data.detail : text);
    return data;
  }

  /** One call, resent once on a network error, a timeout or a 5xx (as satorilib's _makeAuthenticatedCall, server.py:231-268). */
  async function call(method, path, headers = {}, body) {
    try {
      return await once(method, path, headers, body);
    } catch (err) {
      if (err.status === 0 || err.status >= 500) return once(method, path, headers, body);
      throw err;
    }
  }

  /**
   * A fresh token: the identity signs central's challenge, EIP-191 (login.js; satorilib server.py:87-118).
   * Central refusing it is a CentralError with `login: true` (Home's health tells it from a refused batch).
   */
  async function login() {
    const { challenge } = await call('GET', '/api/v1/auth/challenge');
    const signature = identity.signCentralLogin(challenge);
    try {
      return (await call('POST', '/api/v1/auth/login', { 'wallet-pubkey': identity.pubkey, message: challenge, signature })).access_token;
    } catch (err) {
      if (err instanceof CentralError && err.status > 0) err.login = true;
      throw err;
    }
  }

  /**
   * `send(token)` signed in: a fresh login, then the call with its Bearer token; a 401 logs in again and retries once
   * (server.py:210). onStep: 'login', then `step` once signed in (Settings' line, src/neuron/work.js).
   */
  async function signedIn(send, step, onStep = () => {}) {
    onStep('login');
    const token = await login();
    onStep(step);
    try {
      return await send(token);
    } catch (err) {
      if (err instanceof CentralError && err.status === 401) return send(await login());
      throw err;
    }
  }
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  const json = (token) => ({ ...bearer(token), 'content-type': 'application/json' });
  const REWARD = '/api/v1/peer/reward-address';

  return {
    url: base,

    /** POST /peer/register as satorilib's checkin (server.py:384-434): headers only, no token. */
    async register({ vaultPubkey, nostrPubkey }) {
      const headers = { 'wallet-pubkey': identity.pubkey, 'vault-pubkey': vaultPubkey };
      if (nostrPubkey) headers['nostr-pubkey'] = nostrPubkey;
      return call('POST', '/api/v1/peer/register', { ...headers, 'neuron-version': version }); // browser-0.1.0+3f11d8c
    },

    /** Central's relays, [{relay_url, nostr_pubkey, …}] (peer.py:123-163). */
    relays: () => call('GET', '/api/v1/peer/relays'),
    /** { max_streams } (peer.py:166-173). */
    relayConfig: () => call('GET', '/api/v1/peer/relay-config'),

    observations: (limit = 100) => call('GET', `/api/v1/observations/batch?limit=${limit}`),
    /**
     * One stream's past, oldest first: [{id, stream_uuid, observed_at, value, ts}] (limit 1..1000, the route's
     * default 500; since: unix seconds, exclusive). An addition beyond Lite (docs/design/central.md); a central
     * without the route answers 404.
     */
    history: (uuid, { limit = 500, since } = {}) => call('GET', `/api/v1/observations/history?stream_uuid=${
      encodeURIComponent(uuid)}&limit=${limit}${since == null ? '' : `&since=${since}`}`),

    /** Base's addresses (base.py:15-19); prod answers 404 (docs/issues/central-prod-missing-base-routes.md). */
    baseConfig: () => call('GET', '/api/v1/base/config'),
    /** { root, address, amountWei, amount, proof }; 404 = not in the drop, or none published (merkle.py:45-58). */
    merkleProof: (address) => call('GET', `/api/v1/merkle/proof/${encodeURIComponent(address)}`),

    /** Log in, POST the batch; on a 401 log in again and retry once (server.py:210). */
    submitPredictions(predictions) {
      const body = JSON.stringify({ predictions });
      return signedIn((token) => call('POST', '/api/v1/predictions/batch', json(token), body), 'send');
    },

    /**
     * Where the Satori Network sends this neuron's rewards, as central answers it: { reward_address } (a 0x address, or
     * null: the vault; src/neuron/reward.js reads it). Signed in (the owner, 2026-10-19; Lite asks by ?wallet_pubkey=).
     */
    rewardAddress: ({ onStep } = {}) => signedIn((token) => call('GET', REWARD, bearer(token)), 'read', onStep),
    /** Set it (a checked 0x address: src/neuron/reward.js) or clear it (null) → the stored { reward_address }. */
    setRewardAddress: (address, { onStep } = {}) => signedIn((token) => call('POST', REWARD, json(token),
      JSON.stringify({ reward_address: address ?? null })), address ? 'save' : 'clear', onStep),
  };
}
