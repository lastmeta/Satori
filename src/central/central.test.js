import { describe, test, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  predictionItem, normalizeObservation, createCentral, CentralError, TIMEOUT_MS,
} from './index.js';

describe('predictionItem', () => {
  // Central keeps the text as given and reads it with float() (docs/design/central.md#the-protocol-audit),
  // so a number is sent as JS prints it: shortest round-trip digits, as Python's, laid out JS's way.
  test.each([
    [80100.5, 1.5, 1792000000.25], [100, 99, 1792000000], [1e-7, -0, 1792000000.5], [1e21, 2 / 3, 1792000001.125],
  ])('t2 %s, t1 %s at %s', (t2, t1, now) => {
    const item = predictionItem({ streamUuid: 'u1', streamName: 'btc', t2, t1, now });
    const [value, observed] = [String(t2), String(now)];
    expect(item).toEqual({
      stream_uuid: 'u1', stream_name: 'btc', value, t1_value: String(t1), observed_at: observed,
      hash: createHash('sha256').update(value + observed).digest('hex').slice(0, 16),
    });
    expect(Number(item.value)).toBe(t2); // what central's float() reads back
  });
  test('observed_at defaults to the wall clock in seconds', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1760000000123);
    const item = predictionItem({ streamUuid: 'u', streamName: 'n', t1: 99, t2: 100.5 });
    vi.restoreAllMocks();
    expect(item).toMatchObject({ value: '100.5', t1_value: '99', observed_at: '1760000000.123' });
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

const identity = { pubkey: '02ab', signCentralLogin: vi.fn((message) => `sig(${message})`) };
const login = () => ({
  'GET /api/v1/auth/challenge': () => json(200, { challenge: 'c-uuid' }),
  'POST /api/v1/auth/login': () => json(200, { access_token: 'jwt', expires_in: 3600 }),
});
const client = (fetch, url = BASE) => createCentral({ url, fetch, identity, version: 'browser-0.1.0+3f11d8c' });
const paths = (calls) => calls.map((c) => `${c.method} ${c.path}`);

test('traffic: each request to central and each answer', async () => {
  const fired = [];
  const { fetch } = mockFetch({ 'GET /api/v1/observations/batch?limit=100': json(200, []) });
  await createCentral({ url: BASE, fetch, identity, version: '0.1.0', onTraffic: () => fired.push(1) }).observations();
  expect(fired).toHaveLength(2);
  const down = async () => { throw new TypeError('Failed to fetch'); };
  await expect(createCentral({ url: BASE, fetch: down, identity, version: '0.1.0', onTraffic: () => fired.push(1) }).observations())
    .rejects.toThrow('Satori Network unreachable');
  expect(fired).toHaveLength(4); // two tries, no answer
});

describe('register', () => {
  test('identity and vault pubkeys and our version as headers; no login, no token, no body', async () => {
    // central base-upgrade d8a2085's answer (PeerRegisterResponse); its other address forms are not read
    const res = { success: true, peer_id: 7, wallet_address: 'w', vault_address: 'v',
      vault_base_address: '0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7', nostr_pubkey: null, message: 'Peer registered successfully' };
    const { fetch, calls } = mockFetch({ 'POST /api/v1/peer/register': json(200, res) });
    expect(await client(fetch).register({ vaultPubkey: '03cd' })).toEqual(res);
    expect(paths(calls)).toEqual(['POST /api/v1/peer/register']);
    expect(calls[0].headers).toEqual({ 'wallet-pubkey': '02ab', 'vault-pubkey': '03cd', 'neuron-version': 'browser-0.1.0+3f11d8c' });
    expect(calls[0].body).toBeUndefined();
  });
  test('the Nostr pubkey as nostr-pubkey, when there is one (satorilib server.py:394-399)', async () => {
    const { fetch, calls } = mockFetch({ 'POST /api/v1/peer/register': json(200, {}) });
    await client(fetch).register({ vaultPubkey: '03cd', nostrPubkey: 'ee'.repeat(32) });
    expect(calls[0].headers).toEqual({ 'wallet-pubkey': '02ab', 'vault-pubkey': '03cd', 'nostr-pubkey': 'ee'.repeat(32),
      'neuron-version': 'browser-0.1.0+3f11d8c' });
  });
  test('a refusal is a CentralError with the status and detail', async () => {
    const { fetch } = mockFetch({ 'POST /api/v1/peer/register': json(409, { detail: 'wallet conflicts' }) });
    const err = await client(fetch).register({ vaultPubkey: '03cd' }).catch((e) => e);
    expect(err).toBeInstanceOf(CentralError);
    expect(err).toMatchObject({ status: 409, detail: 'wallet conflicts', message: 'Satori Network 409: wallet conflicts' });
  });
});

test("relays and relay-config: central's GETs, no token (peer.py:123-173)", async () => {
  const relays = [{ relay_url: 'ws://satorian.satorinet.io:7777', nostr_pubkey: 'e5' }];
  const { fetch, calls } = mockFetch({ 'GET /api/v1/peer/relays': json(200, relays),
    'GET /api/v1/peer/relay-config': json(200, { max_streams: 60 }) });
  expect(await client(fetch).relays()).toEqual(relays);
  expect(await client(fetch).relayConfig()).toEqual({ max_streams: 60 });
  expect(calls.map((c) => c.headers)).toEqual([{}, {}]);
});

test("Base: the config and the merkle proof, central's GETs; both 404 kinds keep their detail (merkle.py:45-58)", async () => {
  const proof = { root: '0xr', address: '0xV', amountWei: '5000000000000000000', amount: 5, proof: ['0xp'] };
  const { fetch, calls } = mockFetch({
    'GET /api/v1/base/config': json(200, { chainId: 84532 }),
    'GET /api/v1/merkle/proof/0xV': json(200, proof),
    'GET /api/v1/merkle/proof/0xW': json(404, { detail: '0xW is not in the current drop (nothing to claim, …)' }),
  });
  const c = client(fetch);
  expect(await c.baseConfig()).toEqual({ chainId: 84532 });
  expect(await c.merkleProof('0xV')).toEqual(proof);
  expect(await c.merkleProof('0xW').catch((e) => e)).toMatchObject({ status: 404, detail: expect.stringMatching(/not in the current drop/) });
  expect(calls.map((x) => x.headers)).toEqual([{}, {}, {}]);
  const none = mockFetch({ 'GET /api/v1/merkle/proof/0xV': json(404, { detail: 'no reward drop has been published yet' }) });
  expect(await client(none.fetch).merkleProof('0xV').catch((e) => e)).toMatchObject({ status: 404, detail: 'no reward drop has been published yet' });
});

test('history: GET one stream\'s past with a limit and since, no token; a 404 is a CentralError', async () => {
  const path = '/api/v1/observations/history?stream_uuid=u%2F1&limit=1000&since=1788400000';
  const { fetch, calls } = mockFetch({ [`GET ${path}`]: json(200, [{ id: 1 }]) });
  expect(await client(fetch).history('u/1', { limit: 1000, since: 1788400000 })).toEqual([{ id: 1 }]);
  expect(calls).toMatchObject([{ method: 'GET', path, headers: {} }]);
  const { fetch: plain, calls: c2 } = mockFetch({});
  await expect(client(plain).history('u1')).rejects.toMatchObject({ status: 404, detail: 'Not Found' });
  expect(c2[0].path).toBe('/api/v1/observations/history?stream_uuid=u1&limit=500'); // the route's default, no since
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
    expect(identity.signCentralLogin).toHaveBeenCalledWith('c-uuid');
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
    const err = await client(fetch).submitPredictions([]).catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(err.login).toBeUndefined(); // the batch's 401, not the login's
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
    const { fetch, calls } = mockFetch({ ...login(), 'POST /api/v1/auth/login': () => json(401, { detail: 'Invalid signature' }) });
    await expect(client(fetch).submitPredictions([])).rejects.toThrow('Satori Network 401: Invalid signature');
    await expect(client(fetch).submitPredictions([])).rejects.toMatchObject({ status: 401, login: true }); // health: login refused
    expect(paths(calls).slice(0, 2)).toEqual(['GET /api/v1/auth/challenge', 'POST /api/v1/auth/login']);
    expect(calls.filter((c) => c.path === '/api/v1/predictions/batch')).toHaveLength(0);
  });
});

describe('the reward address (peer.py:26-120): signed in, as the predictions batch', () => {
  const PATH = '/api/v1/peer/reward-address';
  const ADDR = '0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7';
  test('read: challenge → identity signs → login → GET with the token alone; the steps said', async () => {
    const { fetch, calls } = mockFetch({ ...login(), [`GET ${PATH}`]: json(200, { reward_address: ADDR }) });
    const steps = [];
    expect(await client(fetch).rewardAddress({ onStep: (s) => steps.push(s) })).toEqual({ reward_address: ADDR });
    expect(paths(calls)).toEqual(['GET /api/v1/auth/challenge', 'POST /api/v1/auth/login', `GET ${PATH}`]);
    expect(calls[2].headers).toEqual({ authorization: 'Bearer jwt' });
    expect(calls[2].body).toBeUndefined();
    expect(steps).toEqual(['login', 'read']);
  });
  test('set: POST { reward_address } as JSON with the token; clear: null', async () => {
    const { fetch, calls } = mockFetch({ ...login(), [`POST ${PATH}`]: () => json(200, { reward_address: ADDR }) });
    const steps = [];
    expect(await client(fetch).setRewardAddress(ADDR, { onStep: (s) => steps.push(s) })).toEqual({ reward_address: ADDR });
    expect(calls[2]).toMatchObject({ method: 'POST', path: PATH, headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' } });
    expect(JSON.parse(calls[2].body)).toEqual({ reward_address: ADDR });
    await client(fetch).setRewardAddress(null, { onStep: (s) => steps.push(s) });
    expect(calls[5].body).toBe('{"reward_address":null}');
    expect(steps).toEqual(['login', 'save', 'login', 'clear']);
  });
  test('a 401 logs in again and retries once; central\'s refusal keeps its words', async () => {
    const { fetch, calls } = mockFetch({ ...login(), [`POST ${PATH}`]: [json(401, { detail: 'expired' }), json(200, { reward_address: null })] });
    expect(await client(fetch).setRewardAddress(null)).toEqual({ reward_address: null });
    expect(calls.filter((c) => c.path === '/api/v1/auth/login')).toHaveLength(2);
    const bad = mockFetch({ ...login(), [`POST ${PATH}`]: () => json(400, { detail: 'Invalid Base address' }) });
    await expect(client(bad.fetch).setRewardAddress(ADDR)).rejects.toMatchObject({ status: 400, message: 'Satori Network 400: Invalid Base address' });
    expect(bad.calls.filter((c) => c.path === PATH)).toHaveLength(1); // a 4xx is not resent
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
    await expect(client(fetch).observations()).rejects.toMatchObject({ status: 0, message: 'Satori Network timed out (15 s)' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test('a body that stalls past the timeout is a timeout too', async () => {
    const fetch = async () => ({ ok: true, status: 200,
      text: async () => { throw new DOMException('signal timed out', 'TimeoutError'); } });
    await expect(client(fetch).observations()).rejects.toMatchObject({ status: 0, message: 'Satori Network timed out (15 s)' });
  });
  test('a network TypeError (offline, or an nginx 429/502 with no CORS header) is wrapped, after one resend', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const err = await client(fetch).observations().catch((e) => e);
    expect(err).toBeInstanceOf(CentralError);
    expect(err).toMatchObject({ status: 0, message: 'Satori Network unreachable: Failed to fetch' });
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
    await expect(client(fetch, `${BASE}/`).observations()).rejects.toThrow('Satori Network 502: Bad Gateway');
    expect(calls[0].path).toBe('/api/v1/observations/batch?limit=100');
  });
});
