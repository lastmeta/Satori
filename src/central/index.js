// central module. Design: docs/design/central.md
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Python `str(float)` / `str(numpy.float64)`: shortest round-trip digits,
 * positional for 1e-4 <= |x| < 1e16, else `d.ddde±XX`. Verified against
 * test/fixtures/central-parity.json (generated from the Docker image).
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
 * One `/predictions/batch` item, formatted as Docker's engine does
 * (neuron/engine-lite/engine.py:1044-1106): value/t1_value = str(float),
 * observed_at = str(wall-clock unix seconds at prediction),
 * hash = sha256(value + observed_at)[:16].
 * @param {{streamUuid: string, streamName: string, t2: number, t1?: number, now?: number}} p
 */
export function predictionItem({ streamUuid, streamName, t2, t1, now = Date.now() / 1000 }) {
  const value = pyFloatStr(t2);
  const observedAt = pyFloatStr(now);
  return {
    stream_uuid: streamUuid,
    stream_name: streamName,
    value,
    t1_value: t1 == null ? null : pyFloatStr(t1),
    observed_at: observedAt,
    hash: bytesToHex(sha256(utf8ToBytes(value + observedAt))).slice(0, 16),
  };
}

const EPOCH_MIN = 946684800; // 2000; same range as data_helper.py:_parse_epoch
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
 * A central `/observations/batch` entry → an `observations` row (storage.md)
 * plus `display_name` for `stream_names`. Mirrors
 * neuron/engine-lite/satoriengine/data_helper.py:normalize_central_observation.
 * Returns null for rows without a stream, a finite value or a timestamp.
 */
export function normalizeObservation(obs, receivedAt = Date.now() / 1000) {
  const uuid = obs.stream?.uuid ?? obs.stream_uuid;
  const raw = obs.value;
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const observedAt = parseEpoch(obs.observed_at || obs.ts);
  if (!uuid || !Number.isFinite(value) || observedAt == null) return null;
  return {
    stream_name: uuid,
    provider_pubkey: 'central',
    seq_num: obs.id,
    observed_at: observedAt,
    received_at: receivedAt,
    value_raw: raw,
    value,
    display_name: obs.stream?.name ?? 'unknown',
  };
}

export class CentralError extends Error {
  constructor(status, detail) {
    super(`central ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @typedef {(message: string) => ({pubkey: string, signature: string} | Promise<{pubkey: string, signature: string}>)} Sign
 *   Evrmore message signature by the identity (identity module).
 * @param {{url: string, fetch: typeof fetch, sign: Sign, version: string}} opts
 */
export function createCentral({ url, fetch, sign, version }) {
  const base = url.replace(/\/+$/, '');

  async function call(method, path, headers = {}, body) {
    const res = await fetch(base + path, { method, headers, body });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw new CentralError(res.status, data?.detail ?? text);
    return data;
  }

  /** Sign a fresh challenge; returns {token, pubkey}. Tokens are not kept. */
  async function auth() {
    const { challenge } = await call('GET', '/api/v1/auth/challenge');
    const { pubkey, signature } = await sign(challenge);
    const { access_token: token } = await call('POST', '/api/v1/auth/login', {
      'wallet-pubkey': pubkey, message: challenge, signature,
    });
    return { token, pubkey };
  }

  const nullOn404 = (p) => p.catch((e) => {
    if (e instanceof CentralError && e.status === 404) return null;
    throw e;
  });

  return {
    /** @returns {Promise<string>} access token */
    login: async () => (await auth()).token,

    /** POST /peer/register with all three pubkeys (and a JWT, forward-compatible). */
    async register({ vaultPubkey, nostrPubkey }) {
      const { token, pubkey } = await auth();
      const headers = {
        'wallet-pubkey': pubkey,
        'vault-pubkey': vaultPubkey,
        'nostr-pubkey': nostrPubkey,
        'neuron-version': `browser-${version}`,
        authorization: `Bearer ${token}`,
      };
      for (const k in headers) if (headers[k] == null) delete headers[k];
      return call('POST', '/api/v1/peer/register', headers);
    },

    /** GET / — reachability for Status (nginx /health has no CORS). */
    info: () => call('GET', '/'),
    relays: () => call('GET', '/api/v1/peer/relays'),
    /** Base config, or null where central lacks the route (prod today). */
    baseConfig: () => nullOn404(call('GET', '/api/v1/base/config')),
    observations: (limit = 100) => call('GET', `/api/v1/observations/batch?limit=${limit}`),

    /** One login, one POST; on 401 log in again and retry once. */
    async submitPredictions(predictions) {
      const body = JSON.stringify({ predictions });
      const post = async () => call('POST', '/api/v1/predictions/batch', {
        authorization: `Bearer ${(await auth()).token}`,
        'content-type': 'application/json',
      }, body);
      try {
        return await post();
      } catch (e) {
        if (e instanceof CentralError && e.status === 401) return post();
        throw e;
      }
    },

    /**
     * Merkle claim payload for a vault's Base address. Root first, so the
     * Claim page can tell the 404s apart:
     * unavailable (route missing) | no-drop | not-in-drop | ok.
     */
    async merkleProof(address) {
      const kind = (e) => {
        if (!(e instanceof CentralError) || e.status !== 404) throw e;
        if (e.detail === 'Not Found') return { status: 'unavailable' };
        if (String(e.detail).startsWith('no reward drop')) return { status: 'no-drop' };
        return null;
      };
      let root;
      try {
        ({ root } = await call('GET', '/api/v1/merkle/root'));
      } catch (e) {
        return kind(e) ?? { status: 'no-drop' };
      }
      try {
        return { status: 'ok', ...(await call('GET', `/api/v1/merkle/proof/${address}`)) };
      } catch (e) {
        return kind(e) ?? { status: 'not-in-drop', root };
      }
    },
  };
}
