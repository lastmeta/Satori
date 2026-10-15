import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  pyFloatStr, predictionItem, normalizeObservation, createCentral, CentralError,
} from './index.js';

const parity = JSON.parse(readFileSync(new URL('../../test/fixtures/central-parity.json', import.meta.url)));
const fromBits = (hex) => new DataView(Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16)).buffer).getFloat64(0);

describe('pyFloatStr (parity with the Docker image)', () => {
  test('fixture is non-trivial', () => expect(parity.floats.length).toBeGreaterThan(400));
  test.each(parity.floats.map((f) => [f.np, f.bits]))('%s', (np, bits) => {
    expect(pyFloatStr(fromBits(bits))).toBe(np);
  });
});

describe('predictionItem', () => {
  test.each(parity.hashes)('hash of $value + $observed_at', (h) => {
    const item = predictionItem({
      streamUuid: 'u1', streamName: 'btc', t2: fromBits(h.value_bits), t1: 1.5,
      now: fromBits(h.observed_at_bits),
    });
    expect(item).toEqual({
      stream_uuid: 'u1', stream_name: 'btc', value: h.value, t1_value: '1.5',
      observed_at: h.observed_at, hash: h.hash,
    });
  });
  test('t1 absent → null; observed_at defaults to wall clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1760000000123);
    const item = predictionItem({ streamUuid: 'u', streamName: 'n', t2: 100 });
    vi.restoreAllMocks();
    expect(item.t1_value).toBeNull();
    expect(item.observed_at).toBe('1760000000.123');
    expect(item.value).toBe('100.0');
  });
});

describe('normalizeObservation', () => {
  const obs = {
    id: 201570, value: '0.00083', observed_at: '1779426055.9544094',
    ts: '2026-05-22T05:00:55.955559', hash: '', stream_id: 66,
    stream: { id: 66, uuid: 'b4bf', name: 'safetrade_xtm' },
  };
  test('maps to an observations row', () => {
    expect(normalizeObservation(obs, 1779430000)).toEqual({
      stream_name: 'b4bf', provider_pubkey: 'central', seq_num: 201570,
      observed_at: 1779426055.9544094, received_at: 1779430000,
      value_raw: '0.00083', value: 0.00083, display_name: 'safetrade_xtm',
    });
  });
  test('falls back to ts (ISO, no zone = UTC) when observed_at is missing', () => {
    expect(normalizeObservation({ ...obs, observed_at: null }).observed_at)
      .toBeCloseTo(Date.UTC(2026, 4, 22, 5, 0, 55, 955.559) / 1000, 3);
  });
  test('drops unusable rows', () => {
    expect(normalizeObservation({ ...obs, value: 'abc' })).toBeNull();
    expect(normalizeObservation({ ...obs, value: '' })).toBeNull();
    expect(normalizeObservation({ ...obs, stream: null })).toBeNull();
    expect(normalizeObservation({ ...obs, observed_at: null, ts: 'x' })).toBeNull();
  });
});

// --- HTTP client, with a mocked fetch -------------------------------------

const URL0 = 'http://central.test';
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/** routes: { 'GET /path': (req) => Response | Response[] in order } */
function mockFetch(routes) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = url.slice(URL0.length);
    calls.push({ method, path, headers: init.headers || {}, body: init.body });
    let r = routes[`${method} ${path}`];
    if (Array.isArray(r)) r = r.shift();
    if (!r) return json(404, { detail: 'Not Found' });
    return typeof r === 'function' ? r() : r;
  });
  return { fetch, calls };
}

const sign = vi.fn(async (message) => ({ pubkey: '02ab', signature: `sig(${message})` }));
const loginRoutes = () => ({
  'GET /api/v1/auth/challenge': () => json(200, { challenge: 'c-uuid' }),
  'POST /api/v1/auth/login': () => json(200, { access_token: 'jwt', expires_in: 3600 }),
});
const client = (fetch) => createCentral({ url: URL0, fetch, sign, version: '0.1.0' });

describe('createCentral', () => {
  test('login signs the challenge and posts the three headers', async () => {
    const { fetch, calls } = mockFetch(loginRoutes());
    const token = await client(fetch).login();
    expect(token).toBe('jwt');
    expect(sign).toHaveBeenCalledWith('c-uuid');
    expect(calls[1]).toMatchObject({
      method: 'POST', path: '/api/v1/auth/login',
      headers: { 'wallet-pubkey': '02ab', message: 'c-uuid', signature: 'sig(c-uuid)' },
    });
  });

  test('login failure throws CentralError with status and detail', async () => {
    const { fetch } = mockFetch({
      ...loginRoutes(), 'POST /api/v1/auth/login': json(401, { detail: 'Invalid signature' }),
    });
    const err = await client(fetch).login().catch((e) => e);
    expect(err).toBeInstanceOf(CentralError);
    expect(err).toMatchObject({ status: 401, detail: 'Invalid signature' });
  });

  test('register sends all three pubkeys, browser version and the JWT', async () => {
    const { fetch, calls } = mockFetch({
      ...loginRoutes(),
      'POST /api/v1/peer/register': json(200, { success: true, peer_id: 7 }),
    });
    const res = await client(fetch).register({ vaultPubkey: '03cd', nostrPubkey: 'ee'.repeat(32) });
    expect(res).toEqual({ success: true, peer_id: 7 });
    expect(calls[2].headers).toEqual({
      'wallet-pubkey': '02ab', 'vault-pubkey': '03cd', 'nostr-pubkey': 'ee'.repeat(32),
      'neuron-version': 'browser-0.1.0', authorization: 'Bearer jwt',
    });
  });

  test('register omits a missing nostr key instead of sending "undefined"', async () => {
    const { fetch, calls } = mockFetch({ ...loginRoutes(), 'POST /api/v1/peer/register': json(200, {}) });
    await client(fetch).register({ vaultPubkey: '03cd' });
    expect(calls[2].headers).not.toHaveProperty('nostr-pubkey');
  });

  test('relays, base config, info', async () => {
    const { fetch } = mockFetch({
      'GET /api/v1/peer/relays': json(200, [{ relay_url: 'ws://r' }]),
      'GET /api/v1/base/config': json(200, { chainId: 84532 }),
      'GET /': json(200, { name: 'Satori', version: '1' }),
    });
    const c = client(fetch);
    expect(await c.relays()).toEqual([{ relay_url: 'ws://r' }]);
    expect(await c.baseConfig()).toEqual({ chainId: 84532 });
    expect(await c.info()).toEqual({ name: 'Satori', version: '1' });
  });

  test('base config 404 (prod today) → null', async () => {
    const { fetch } = mockFetch({});
    expect(await client(fetch).baseConfig()).toBeNull();
  });

  test('observations: GET batch with limit, no auth', async () => {
    const { fetch, calls } = mockFetch({ 'GET /api/v1/observations/batch?limit=100': json(200, [{ id: 1 }]) });
    expect(await client(fetch).observations()).toEqual([{ id: 1 }]);
    expect(calls[0].headers).toEqual({});
  });

  test('submitPredictions: one login, one POST with the JWT', async () => {
    const { fetch, calls } = mockFetch({
      ...loginRoutes(),
      'POST /api/v1/predictions/batch': json(200, { total_submitted: 1, successful: 1 }),
    });
    const preds = [{ stream_uuid: 'u', value: '1.0' }];
    expect(await client(fetch).submitPredictions(preds)).toEqual({ total_submitted: 1, successful: 1 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/auth/challenge', 'POST /api/v1/auth/login', 'POST /api/v1/predictions/batch',
    ]);
    expect(calls[2].headers).toEqual({ authorization: 'Bearer jwt', 'content-type': 'application/json' });
    expect(JSON.parse(calls[2].body)).toEqual({ predictions: preds });
  });

  test('submitPredictions: retries once on 401 with a fresh login', async () => {
    const { fetch, calls } = mockFetch({
      ...loginRoutes(),
      'POST /api/v1/predictions/batch': [json(401, { detail: 'expired' }), json(200, { successful: 1 })],
    });
    expect(await client(fetch).submitPredictions([])).toEqual({ successful: 1 });
    expect(calls.filter((c) => c.path === '/api/v1/auth/login')).toHaveLength(2);
    expect(calls.filter((c) => c.path === '/api/v1/predictions/batch')).toHaveLength(2);
  });

  test('submitPredictions: a second 401 throws, no third try', async () => {
    const { fetch, calls } = mockFetch({
      ...loginRoutes(),
      'POST /api/v1/predictions/batch': () => json(401, { detail: 'no' }),
    });
    const err = await client(fetch).submitPredictions([]).catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(calls.filter((c) => c.path === '/api/v1/predictions/batch')).toHaveLength(2);
  });

  test('submitPredictions: other errors are not retried', async () => {
    const { fetch, calls } = mockFetch({
      ...loginRoutes(),
      'POST /api/v1/predictions/batch': () => json(500, { detail: 'boom' }),
    });
    await expect(client(fetch).submitPredictions([])).rejects.toMatchObject({ status: 500, detail: 'boom' });
    expect(calls.filter((c) => c.path === '/api/v1/predictions/batch')).toHaveLength(1);
  });

  test('trailing slash on url is tolerated', async () => {
    const { fetch, calls } = mockFetch({ 'GET /': json(200, {}) });
    await createCentral({ url: `${URL0}/`, fetch, sign, version: '1' }).info();
    expect(calls[0].path).toBe('/');
  });
});

describe('merkleProof', () => {
  const addr = '0xAbC';
  const proofPath = `GET /api/v1/merkle/proof/${addr}`;
  test('root first, then the proof', async () => {
    const entry = { root: '0xr', address: addr, amountWei: '1000000000000000000000', amount: 1000, proof: ['0x1'] };
    const { fetch, calls } = mockFetch({
      'GET /api/v1/merkle/root': json(200, { root: '0xr', total: 5, recipients: 2 }),
      [proofPath]: json(200, entry),
    });
    expect(await client(fetch).merkleProof(addr)).toEqual({ status: 'ok', ...entry });
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/merkle/root', `/api/v1/merkle/proof/${addr}`]);
  });
  test('route missing (prod today) → unavailable', async () => {
    const { fetch, calls } = mockFetch({});
    expect(await client(fetch).merkleProof(addr)).toEqual({ status: 'unavailable' });
    expect(calls).toHaveLength(1);
  });
  test('no drop published → no-drop', async () => {
    const { fetch } = mockFetch({
      'GET /api/v1/merkle/root': json(404, { detail: 'no reward drop has been published yet' }),
    });
    expect(await client(fetch).merkleProof(addr)).toEqual({ status: 'no-drop' });
  });
  test('address not in the drop → not-in-drop with the root', async () => {
    const { fetch } = mockFetch({
      'GET /api/v1/merkle/root': json(200, { root: '0xr', total: 5, recipients: 2 }),
      [proofPath]: json(404, { detail: `${addr} is not in the current drop (nothing to claim, …)` }),
    });
    expect(await client(fetch).merkleProof(addr)).toEqual({ status: 'not-in-drop', root: '0xr' });
  });
  test('other errors throw', async () => {
    const { fetch } = mockFetch({ 'GET /api/v1/merkle/root': json(503, { detail: 'down' }) });
    await expect(client(fetch).merkleProof(addr)).rejects.toMatchObject({ status: 503 });
  });
});
