// Central's API as Satori Lite uses it (docs/design/central.md):
//   const c = createCentral({ url, identity, version })
//   await c.register({ vaultPubkey, nostrPubkey })   // POST /peer/register
//   await c.relays() / c.relayConfig()       // GET /peer/relays, /peer/relay-config (Nostr)
//   await c.observations()                   // GET /observations/batch?limit=100
//   await c.submitPredictions(items)         // login (identity) → POST /predictions/batch; one retry on 401
//   await c.baseConfig() / c.merkleProof(address)   // Base (docs/design/base.md); 404 is a CentralError
// Errors are CentralError: status 0 for a timeout or a network failure. A
// network error, a timeout or a 5xx is resent once.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const TIMEOUT_MS = 15_000; // satorilib: 10 s register, 15 s login and calls (server.py:106,207,405)

/**
 * Python `str(float)` / `str(numpy.float64)`: shortest round-trip digits,
 * positional for 1e-4 <= |x| < 1e16, else `d.ddde±XX`. Checked against
 * test/fixtures/central-parity.json (made in the Docker image).
 * @param {number} x
 */
export function pyFloatStr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [m, e] = x.toExponential().split('e'); // shortest digits, like repr
  const exp = Number(e);
  const sign = x < 0 ? '-' : '';
  const digits = m.replace(/[-.]/g, '');
  if (exp < -4 || exp >= 16) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${mant}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return `${sign}${digits}${'0'.repeat(exp + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

/**
 * One `/predictions/batch` item as Lite's engine makes it (engine.py:1044-1106,
 * 1188-1206): value = str(t2), t1_value = str(t1), observed_at = str(unix
 * seconds at prediction), hash = sha256(value + observed_at)[:16].
 * @param {{streamUuid: string, streamName: string, t1: number, t2: number, now?: number}} p
 */
export function predictionItem({ streamUuid, streamName, t1, t2, now = Date.now() / 1000 }) {
  const value = pyFloatStr(t2);
  const observedAt = pyFloatStr(now);
  return {
    stream_uuid: streamUuid,
    stream_name: streamName,
    value,
    t1_value: pyFloatStr(t1),
    observed_at: observedAt,
    hash: bytesToHex(sha256(utf8ToBytes(value + observedAt))).slice(0, 16),
  };
}

const EPOCH_MIN = 946684800; // 2000, as data_helper.py:_parse_epoch
const EPOCH_MAX = 4102444800; // 2100

function parseEpoch(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (n > EPOCH_MIN && n < EPOCH_MAX) return n;
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
  constructor(status, detail, message = `central ${status}: ${detail}`) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @param {{url: string, identity: {pubkey: string, sign: (msg: string) => string}, version: string, fetch?: typeof fetch}} opts
 */
export function createCentral({ url, identity, version, fetch: fetchFn = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '');

  async function once(method, path, headers, body) {
    let res;
    let text;
    try {
      res = await fetchFn(base + path, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = await res.text();
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new CentralError(0, 'timeout', `central timed out (${TIMEOUT_MS / 1000} s)`);
      // nginx's 429/502 pages have no CORS header: the browser shows them as this TypeError too.
      throw new CentralError(0, 'network', `central unreachable: ${err?.message ?? err}`);
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

  /** A fresh token: sign central's challenge with the identity (server.py:87-118 signs a timestamp). */
  async function login() {
    const { challenge } = await call('GET', '/api/v1/auth/challenge');
    const signature = identity.sign(challenge);
    return (await call('POST', '/api/v1/auth/login', { 'wallet-pubkey': identity.pubkey, message: challenge, signature })).access_token;
  }

  return {
    url: base,

    /** POST /peer/register as satorilib's checkin (server.py:384-434): headers only, no token. */
    async register({ vaultPubkey, nostrPubkey }) {
      const headers = { 'wallet-pubkey': identity.pubkey, 'vault-pubkey': vaultPubkey };
      if (nostrPubkey) headers['nostr-pubkey'] = nostrPubkey;
      return call('POST', '/api/v1/peer/register', { ...headers, 'neuron-version': `browser-${version}` });
    },

    /** Central's relays, [{relay_url, nostr_pubkey, evr_address}] (peer.py:123-163). */
    relays: () => call('GET', '/api/v1/peer/relays'),
    /** { max_streams } (peer.py:166-173). */
    relayConfig: () => call('GET', '/api/v1/peer/relay-config'),

    observations: (limit = 100) => call('GET', `/api/v1/observations/batch?limit=${limit}`),

    /** Base's addresses (base.py:15-19); prod answers 404 (docs/future/issues/central-prod-missing-base-routes.md). */
    baseConfig: () => call('GET', '/api/v1/base/config'),
    /** { root, address, amountWei, amount, proof }; 404 = not in the drop, or none published (merkle.py:45-58). */
    merkleProof: (address) => call('GET', `/api/v1/merkle/proof/${encodeURIComponent(address)}`),

    /** Log in, POST the batch; on a 401 log in again and retry once (server.py:210). */
    async submitPredictions(predictions) {
      const body = JSON.stringify({ predictions });
      const post = (token) => call('POST', '/api/v1/predictions/batch',
        { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body);
      const token = await login();
      try {
        return await post(token);
      } catch (err) {
        if (err instanceof CentralError && err.status === 401) return post(await login());
        throw err;
      }
    },
  };
}
