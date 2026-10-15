import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  pyFloatStr, predictionItem, normalizeObservation, createCentral, CentralError, TIMEOUT_MS,
} from './index.js';

const parity = JSON.parse(readFileSync(new URL('../../test/fixtures/central-parity.json', import.meta.url)));
const fromBits = (hex) => new DataView(Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16)).buffer).getFloat64(0);

describe('pyFloatStr (parity with the Docker image)', () => {
  test('the fixture is non-trivial', () => expect(parity.floats.length).toBeGreaterThan(400));
  test.each(parity.floats.map((f) => [f.np, f.bits]))('%s', (np, bits) => {
    expect(pyFloatStr(fromBits(bits))).toBe(np);
  });
});

describe('predictionItem', () => {
  test.each(parity.hashes)('hash of $value + $observed_at', (h) => {
    const item = predictionItem({
      streamUuid: 'u1', streamName: 'btc', t2: fromBits(h.value_bits), t1: 1.5, now: fromBits(h.observed_at_bits),
    });
    expect(item).toEqual({
      stream_uuid: 'u1', stream_name: 'btc', value: h.value, t1_value: '1.5', observed_at: h.observed_at, hash: h.hash,
    });
  });
  test('observed_at defaults to the wall clock in seconds', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1760000000123);
    const item = predictionItem({ streamUuid: 'u', streamName: 'n', t1: 99, t2: 100 });
    vi.restoreAllMocks();
    expect(item).toMatchObject({ value: '100.0', t1_value: '99.0', observed_at: '1760000000.123' });
  });
});

describe('normalizeObservation', () => {
  // As central2 sent it on 2026-10-15.
  const obs = {
    id: 429264, observed_at: '1792018812.6853862', value: '0.3003', hash: '', stream_id: 68,
    stream: { id: 68, uuid: '98d3', name: 'safetrade_zeph', author: null, secondary: null, target: null, meta: null, description: null },
    ts: '2026-10-14T23:00:12.756973', stream_uuid: '98d3',
  };
  test('a stream, a float value and a whole-second time', () => {
    expect(normalizeObservation(obs)).toEqual({ stream_uuid: '98d3', name: 'safetrade_zeph', meta: null, ts: 1792018812, value: 0.3003 });
  });
  test('falls back to ts (ISO, no zone = UTC) when observed_at is missing', () => {
    expect(normalizeObservation({ ...obs, observed_at: null }).ts).toBe(Date.UTC(2026, 9, 14, 23, 0, 12) / 1000);
    expect(normalizeObservation({ ...obs, observed_at: '' }).ts).toBe(Date.UTC(2026, 9, 14, 23, 0, 12) / 1000);
  });
  test('the uuid from the stream when the top-level one is missing; meta kept as text', () => {
    expect(normalizeObservation({ ...obs, stream_uuid: undefined, stream: { ...obs.stream, meta: { unit: 'USD' } } }))
      .toMatchObject({ stream_uuid: '98d3', meta: '{"unit":"USD"}' });
    expect(normalizeObservation({ ...obs, stream: { ...obs.stream, meta: 'usd' } }).meta).toBe('usd');
    expect(normalizeObservation({ ...obs, stream: null }).name).toBe('unknown');
  });
  test('drops rows with no stream, no finite value or no time', () => {
    for (const bad of [
      { value: 'abc' }, { value: '' }, { value: null }, { value: 'nan' }, { value: 'inf' },
      { stream: null, stream_uuid: null }, { observed_at: null, ts: 'x' }, { observed_at: null, ts: null },
    ]) expect(normalizeObservation({ ...obs, ...bad })).toBeNull();
    expect(normalizeObservation(null)).toBeNull();
  });
});

// ── the HTTP client, with a mocked fetch ────────────────────────────────────

const BASE = 'https://central.test';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** routes: { 'GET /path': Response | () => Response | [in order] } */
function mockFetch(routes) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, path: url.slice(BASE.length), headers: init.headers || {}, body: init.body, signal: init.signal });
    let r = routes[`${method} ${url.slice(BASE.length)}`];
    if (Array.isArray(r)) r = r.shift();
    if (!r) return json(404, { detail: 'Not Found' });
    return typeof r === 'function' ? r() : r;
  });
  return { fetch, calls };
}

const identity = { pubkey: '02ab', sign: vi.fn((message) => `sig(${message})`) };
const login = () => ({
  'GET /api/v1/auth/challenge': () => json(200, { challenge: 'c-uuid' }),
  'POST /api/v1/auth/login': () => json(200, { access_token: 'jwt', expires_in: 3600 }),
});
const client = (fetch, url = BASE) => createCentral({ url, fetch, identity, version: '0.1.0' });
const paths = (calls) => calls.map((c) => `${c.method} ${c.path}`);

describe('register', () => {
  test('identity and vault pubkeys and our version as headers; no login, no token, no body', async () => {
    const res = { success: true, peer_id: 7, wallet_address: 'Ea', vault_address: 'Eb', message: 'Peer registered successfully' };
    const { fetch, calls } = mockFetch({ 'POST /api/v1/peer/register': json(200, res) });
    expect(await client(fetch).register({ vaultPubkey: '03cd' })).toEqual(res);
    expect(paths(calls)).toEqual(['POST /api/v1/peer/register']);
    expect(calls[0].headers).toEqual({ 'wallet-pubkey': '02ab', 'vault-pubkey': '03cd', 'neuron-version': 'browser-0.1.0' });
    expect(calls[0].body).toBeUndefined();
  });
  test('the Nostr pubkey as nostr-pubkey, when there is one (satorilib server.py:394-399)', async () => {
    const { fetch, calls } = mockFetch({ 'POST /api/v1/peer/register': json(200, {}) });
    await client(fetch).register({ vaultPubkey: '03cd', nostrPubkey: 'ee'.repeat(32) });
    expect(calls[0].headers).toEqual({ 'wallet-pubkey': '02ab', 'vault-pubkey': '03cd', 'nostr-pubkey': 'ee'.repeat(32),
      'neuron-version': 'browser-0.1.0' });
  });
  test('no vault pubkey: nothing is sent', async () => {
    const { fetch, calls } = mockFetch({});
    expect(await client(fetch).register({ vaultPubkey: null })).toBeNull();
    expect(calls).toEqual([]);
  });
  test('a refusal is a CentralError with the status and detail', async () => {
    const { fetch } = mockFetch({ 'POST /api/v1/peer/register': json(409, { detail: 'wallet conflicts' }) });
    const err = await client(fetch).register({ vaultPubkey: '03cd' }).catch((e) => e);
    expect(err).toBeInstanceOf(CentralError);
    expect(err).toMatchObject({ status: 409, detail: 'wallet conflicts', message: 'central 409: wallet conflicts' });
  });
});

test("relays and relay-config: central's GETs, no token (peer.py:123-173)", async () => {
  const relays = [{ relay_url: 'ws://satorian.satorinet.io:7777', nostr_pubkey: 'e5', evr_address: 'EM' }];
  const { fetch, calls } = mockFetch({ 'GET /api/v1/peer/relays': json(200, relays),
    'GET /api/v1/peer/relay-config': json(200, { max_streams: 60 }) });
  expect(await client(fetch).relays()).toEqual(relays);
  expect(await client(fetch).relayConfig()).toEqual({ max_streams: 60 });
  expect(calls.map((c) => c.headers)).toEqual([{}, {}]);
});

test('observations: GET the batch with a limit, no token', async () => {
  const { fetch, calls } = mockFetch({ 'GET /api/v1/observations/batch?limit=100': json(200, [{ id: 1 }]) });
  expect(await client(fetch).observations()).toEqual([{ id: 1 }]);
  expect(calls[0].headers).toEqual({});
});

describe('submitPredictions', () => {
  test('challenge → identity signs → login → POST with the token', async () => {
    const { fetch, calls } = mockFetch({
      ...login(), 'POST /api/v1/predictions/batch': json(200, { total_submitted: 1, successful: 1 }),
    });
    const items = [{ stream_uuid: 'u', value: '1.0' }];
    expect(await client(fetch).submitPredictions(items)).toEqual({ total_submitted: 1, successful: 1 });
    expect(paths(calls)).toEqual(['GET /api/v1/auth/challenge', 'POST /api/v1/auth/login', 'POST /api/v1/predictions/batch']);
    expect(identity.sign).toHaveBeenCalledWith('c-uuid');
    expect(calls[1].headers).toEqual({ 'wallet-pubkey': '02ab', message: 'c-uuid', signature: 'sig(c-uuid)' });
    expect(calls[2].headers).toEqual({ authorization: 'Bearer jwt', 'content-type': 'application/json' });
    expect(JSON.parse(calls[2].body)).toEqual({ predictions: items });
  });
  test('a 401 logs in again and retries once', async () => {
    const { fetch, calls } = mockFetch({
      ...login(), 'POST /api/v1/predictions/batch': [json(401, { detail: 'expired' }), json(200, { successful: 1 })],
    });
    expect(await client(fetch).submitPredictions([])).toEqual({ successful: 1 });
    expect(calls.filter((c) => c.path === '/api/v1/auth/login')).toHaveLength(2);
    expect(calls.filter((c) => c.path === '/api/v1/predictions/batch')).toHaveLength(2);
  });
  test('a second 401 throws; there is no third try', async () => {
    const { fetch, calls } = mockFetch({ ...login(), 'POST /api/v1/predictions/batch': () => json(401, { detail: 'no' }) });
    await expect(client(fetch).submitPredictions([])).rejects.toMatchObject({ status: 401 });
    expect(calls.filter((c) => c.path === '/api/v1/predictions/batch')).toHaveLength(2);
  });
  test('a 5xx is resent once with the same token; a second 5xx throws', async () => {
    const { fetch, calls } = mockFetch({ ...login(), 'POST /api/v1/predictions/batch': () => json(500, { detail: 'boom' }) });
    await expect(client(fetch).submitPredictions([])).rejects.toMatchObject({ status: 500, detail: 'boom' });
    expect(calls.filter((c) => c.path === '/api/v1/predictions/batch')).toHaveLength(2);
    expect(calls.filter((c) => c.path === '/api/v1/auth/login')).toHaveLength(1);
  });
  test('other 4xx are not retried', async () => {
    const { fetch, calls } = mockFetch({ ...login(), 'POST /api/v1/predictions/batch': () => json(422, { detail: 'bad' }) });
    await expect(client(fetch).submitPredictions([])).rejects.toMatchObject({ status: 422 });
    expect(calls.filter((c) => c.path === '/api/v1/predictions/batch')).toHaveLength(1);
  });
  test('a failed login is the error (signature refused)', async () => {
    const { fetch, calls } = mockFetch({ ...login(), 'POST /api/v1/auth/login': json(401, { detail: 'Invalid signature' }) });
    await expect(client(fetch).submitPredictions([])).rejects.toThrow('central 401: Invalid signature');
    expect(paths(calls)).toEqual(['GET /api/v1/auth/challenge', 'POST /api/v1/auth/login']);
  });
});

describe('transport', () => {
  test(`every call carries a ${TIMEOUT_MS / 1000} s timeout signal`, async () => {
    expect(TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    const { fetch, calls } = mockFetch({ 'GET /api/v1/observations/batch?limit=100': json(200, []) });
    await client(fetch).observations();
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });
  test('a timeout is a CentralError saying so, after one resend', async () => {
    const fetch = vi.fn(async () => { throw new DOMException('signal timed out', 'TimeoutError'); });
    await expect(client(fetch).observations()).rejects.toMatchObject({ status: 0, message: 'central timed out (15 s)' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test('a body that stalls past the timeout is a timeout too', async () => {
    const fetch = async () => ({ ok: true, status: 200,
      text: async () => { throw new DOMException('signal timed out', 'TimeoutError'); } });
    await expect(client(fetch).observations()).rejects.toMatchObject({ status: 0, message: 'central timed out (15 s)' });
  });
  test('a network TypeError (offline, or an nginx 429/502 with no CORS header) is wrapped, after one resend', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const err = await client(fetch).observations().catch((e) => e);
    expect(err).toBeInstanceOf(CentralError);
    expect(err).toMatchObject({ status: 0, message: 'central unreachable: Failed to fetch' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test('one network failure, then an answer: the answer', async () => {
    const { fetch: ok } = mockFetch({ 'GET /api/v1/observations/batch?limit=100': json(200, [{ id: 1 }]) });
    let n = 0;
    const fetch = async (...a) => { if (n++ === 0) throw new TypeError('Failed to fetch'); return ok(...a); };
    expect(await client(fetch).observations()).toEqual([{ id: 1 }]);
  });
  test('a non-JSON error body is the detail; a trailing slash on the URL is fine', async () => {
    const { fetch, calls } = mockFetch({ 'GET /api/v1/observations/batch?limit=100': () => new Response('Bad Gateway', { status: 502 }) });
    await expect(client(fetch, `${BASE}/`).observations()).rejects.toThrow('central 502: Bad Gateway');
    expect(calls[0].path).toBe('/api/v1/observations/batch?limit=100');
  });
});
