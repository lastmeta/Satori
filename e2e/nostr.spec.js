// Nostr in Chrome against two test relays (scripts/test-relay.mjs): 7782 plays
// central's relay (read only on the dev server, as satorian is) and 7781 the
// user's relay. A provider (scripts/provider.mjs) announces and publishes a
// stream on 7782; the app discovers it, subscribes, takes each observation and
// publishes `<stream>_pred` (and its 34600, the 34602) on 7781 only; the test
// reads them back and checks them. Satorian and the dev relay (7778) are never
// contacted: their sockets are routed to nothing.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { connectProvider } from '../scripts/provider.mjs';
import { createRelay } from '../src/nostr/relay.js';
import { verifyEvent } from '../src/nostr/event.js';
import { relayUuid } from '../src/nostr/satori.js';
import { readNostrYaml } from '../src/keys/docker.js';
import { openApp, reloadApp } from './load.js';

const CENTRAL = 'https://central2.satorinet.io';
const CENTRAL_RELAY = 'ws://localhost:7782';
const USER_RELAY = 'ws://localhost:7781';
const PASS = 'correct horse battery';
const fx = JSON.parse(readFileSync(new URL('../test/fixtures/identity-parity.json', import.meta.url)));

/** A node-side reader of a test relay. */
async function reader(url) {
  const r = createRelay(url, { WebSocket });
  r.connect();
  await expect.poll(() => r.state).toBe('open');
  return r;
}

async function stubCentral(context) {
  const stub = { registered: [], prod: [], blocked: [] };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'wallet-pubkey, vault-pubkey, nostr-pubkey, neuron-version' };
  await context.route('**/rpc', (route) => route.abort()); // no chain here (e2e/base.spec.js has a fake one)
  await context.route('https://network.satorinet.io/**', (route) => {
    stub.prod.push(route.request().url());
    return route.abort();
  });
  await context.route(`${CENTRAL}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const reply = (json) => route.fulfill({ status: 200, json, headers: cors });
    switch (`${req.method()} ${new URL(req.url()).pathname}`) {
      case 'POST /api/v1/peer/register':
        stub.registered.push(req.headers());
        return reply({ success: true, peer_id: 9, wallet_address: 'E', vault_address: null, message: 'ok' });
      case 'GET /api/v1/peer/relays': return reply([{ relay_url: CENTRAL_RELAY, nostr_pubkey: 'x', evr_address: 'E' }]);
      case 'GET /api/v1/peer/relay-config': return reply({ max_streams: 60 });
      case 'GET /api/v1/observations/batch': return reply([]);
      default: return route.fulfill({ status: 404, json: { detail: 'Not Found' }, headers: cors });
    }
  });
  // Production's relay and the owner's dev relay: never reached from a test.
  await context.routeWebSocket((u) => u.hostname === 'satorian.satorinet.io' || u.port === '7778', (ws) => {
    stub.blocked.push(ws.url());
    ws.close();
  });
  return stub;
}

const nostr = (page) => page.evaluate(() => window.satori.nostr());

test('discover, subscribe, observations in, `_pred` out on the relay we write to; central\'s relay read only; unsubscribe', async ({ context, page }) => {
  const stub = await stubCentral(context);
  await context.addInitScript(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const stream = `e2e-${Date.now().toString(36)}`;
  const provider = await connectProvider({ url: CENTRAL_RELAY });
  await provider.announce({ stream, name: 'E2E walk', description: 'from the e2e', cadence: 60, tags: ['e2e'] });
  const t0 = Math.floor(Date.now() / 1000) - 60;
  await provider.observe({ stream, value: '100', seq: 1, timestamp: t0 });

  // Setup: the Nostr key is made and registered with central.
  await openApp(page);
  await expect(page.getByRole('button', { name: 'Create a new neuron' })).toBeVisible();
  const s0 = await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  expect(s0.nostr.pubkey).toMatch(/^[0-9a-f]{64}$/);
  const me = s0.nostr.pubkey;
  await expect.poll(() => stub.registered.length).toBe(1);
  expect(stub.registered[0]['nostr-pubkey']).toBe(me);
  const walletPubkey = stub.registered[0]['wallet-pubkey'];
  await expect(page.locator('[data-test=nostr-pubkey]')).toHaveText(me);

  // Relays: central's (read only on the dev server) and the user's, set to the e2e relay.
  const s1 = await page.evaluate((u) => window.satori.setRelays({ relays: [u] }), USER_RELAY);
  expect(s1.relays.map((r) => [r.url, r.from, r.write])).toEqual([[CENTRAL_RELAY, ['central'], false], [USER_RELAY, ['user'], true]]);
  await expect.poll(async () => (await nostr(page)).relays.map((r) => r.state)).toEqual(['open', 'open']);
  await expect(page.locator('[data-test=relay]').filter({ hasText: CENTRAL_RELAY })).toContainText('Connected · read only');

  // Network streams: discover, search, subscribe from the UI.
  await page.getByText('Network streams', { exact: true }).click();
  await page.getByLabel('Search streams').fill(stream);
  const row = page.locator('[data-test=catalog-row]').filter({ hasText: stream });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('E2E walk');
  await expect(row).toContainText('1 min');
  await row.getByRole('button', { name: 'Subscribe' }).click();
  await expect(row.getByRole('button', { name: 'Unsubscribe' })).toBeVisible();

  // The stored observation arrives with the follow REQ: stored, forecast, `_pred` seq 1 published to 7781.
  const sub = page.locator('[data-test=sub]').filter({ hasText: 'E2E walk' });
  await expect(sub.locator('[data-test=sub-obs]')).toHaveText('100');
  await expect(sub.locator('[data-test=sub-pred]')).toHaveText('100');
  await expect(sub.locator('[data-test=sub-pred]')).toHaveAttribute('title', `${stream}_pred · naive · sent as "100.0"`);
  await expect(sub.locator('[data-test=sub-seq]')).toHaveText('1');
  await expect(sub.locator('[data-test=sub-relays]')).toHaveText('1 relay');

  // A live observation: `_pred` seq 2. (Not in the same second as seq 1: a relay keeps one of two
  // replaceable events with the same created_at, NIP-01's tie rule, for Lite's events too.)
  await page.waitForTimeout(1100);
  await provider.observe({ stream, value: '101.5', seq: 2, timestamp: t0 + 60 });
  await expect(sub.locator('[data-test=sub-seq]')).toHaveText('2');
  await expect(sub.locator('[data-test=sub-obs]')).toHaveText('101.5');
  // (how many relays took it is known when they answer, just after)
  await expect.poll(async () => (await nostr(page)).subscriptions).toMatchObject([{ uuid: relayUuid(provider.pubkey, stream), stream, provider: provider.pubkey,
    cadence_seconds: 60, observations: 2, observation: { seq: 2, value: 101.5, raw: '101.5', ts: t0 + 60 },
    prediction: { stream: `${stream}_pred`, seq: 2, value: '101.5', model: 'naive', relays: 1 } }]);

  const history = await page.evaluate(([p, s]) => window.satori.relayPredictions(p, s), [provider.pubkey, stream]);
  expect(history.map((h) => [h.seq, h.value, h.obs_seq, h.relays])).toEqual([[2, '101.5', 2, 1], [1, '100.0', 1, 1]]);
  expect(history[0].event_id).toMatch(/^[0-9a-f]{64}$/);

  // What the user's relay holds from us, read back and checked.
  const user = await reader(USER_RELAY);
  const pred = `${stream}_pred`;
  const [obs] = await user.fetch([{ kinds: [34601], authors: [me], '#d': [pred] }]);
  expect(verifyEvent(obs)).toBe(true);
  expect(obs.tags).toEqual([['d', pred], ['stream', pred], ['seq', '2'], ['satori', 'observation']]);
  expect(obs.content).toBe(`{"stream_name": "${pred}", "timestamp": ${obs.created_at}, "value": "101.5", "seq_num": 2}`);
  const [ann] = await user.fetch([{ kinds: [34600], authors: [me], '#d': [pred] }]);
  expect(verifyEvent(ann)).toBe(true);
  expect(ann.tags).toEqual([['d', pred], ['satori', 'datastream'], ['stream', `satori:stream:${pred}`],
    ['source_stream', stream], ['source_pubkey', provider.pubkey]]);
  expect(JSON.parse(ann.content)).toEqual({ stream_name: pred, nostr_pubkey: me, name: 'Predictions for E2E walk',
    description: '', encrypted: false, price_per_obs: 0, created_at: expect.any(Number), cadence_seconds: 60, tags: [],
    approval_required: false, metadata: { source_stream_name: stream, source_provider_pubkey: provider.pubkey,
      wallet_pubkey: walletPubkey } });
  const [subEv] = await user.fetch([{ kinds: [34602], authors: [me], '#d': [stream] }]);
  expect(subEv.tags).toEqual([['d', stream], ['p', provider.pubkey], ['stream', stream], ['satori', 'subscription']]);
  const [list] = await user.fetch([{ kinds: [10002], authors: [me] }]);
  expect(list.tags).toContainEqual(['r', USER_RELAY]); // NIP-65: the relays open at the time

  // Central's relay got nothing from us: it is read only on the dev server.
  const centralRelay = await reader(CENTRAL_RELAY);
  expect(await centralRelay.fetch([{ authors: [me] }])).toEqual([]);

  // A reload: the subscription, the key and the `_pred` seq are kept; the next observation is seq 3.
  await reloadApp(page);
  await expect(page.locator('[data-test=nostr-pubkey]')).toHaveText(me);
  await expect(sub.locator('[data-test=sub-seq]')).toHaveText('2');
  await expect.poll(async () => (await nostr(page)).relays.map((r) => r.state)).toEqual(['open', 'open']);
  await provider.observe({ stream, value: '102', seq: 3, timestamp: t0 + 120 });
  await expect(sub.locator('[data-test=sub-seq]')).toHaveText('3');

  // Unsubscribe: the 34602 unsubscribe and the `_pred` tombstone; no more `_pred`.
  await sub.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page.locator('[data-test=sub]')).toHaveCount(0);
  await expect.poll(async () => (await user.fetch([{ kinds: [34600], authors: [me], '#d': [pred] }]))[0].tags)
    .toEqual([['d', pred], ['satori', 'datastream'], ['status', 'deleted']]);
  const [unsub] = await user.fetch([{ kinds: [34602], authors: [me], '#d': [stream] }]);
  expect(unsub.tags).toEqual([['d', stream], ['p', provider.pubkey], ['stream', stream], ['action', 'unsubscribe'],
    ['satori', 'unsubscription']]);
  await provider.observe({ stream, value: '103', seq: 4, timestamp: t0 + 180 });
  await page.waitForTimeout(500);
  const [last] = await user.fetch([{ kinds: [34601], authors: [me], '#d': [pred] }]);
  expect(last.tags).toContainEqual(['seq', '3']);
  expect(await centralRelay.fetch([{ authors: [me] }])).toEqual([]);

  // The key moves as Docker's nostr.yaml (needs Unlock, as the other files).
  await expect(page.evaluate(() => window.satori.file('nostr.yaml'))).rejects.toThrow(/Unlock/);
  await page.evaluate((p) => window.satori.unlock(p), PASS);
  expect(readNostrYaml(await page.evaluate(() => window.satori.file('nostr.yaml'))).pubkeyHex).toBe(me);

  expect(stub.prod).toEqual([]);
  expect(stub.blocked.every((u) => /7778|satorian/.test(u))).toBe(true);
  expect(await page.evaluate(() => window.violations)).toEqual([]);
  provider.close();
  user.close();
  centralRelay.close();
});

test('Docker import with nostr.yaml keeps the Docker Nostr key; refused subscriptions are explained', async ({ context, page }) => {
  const stub = await stubCentral(context);
  const wallet = fx.vectors[0];
  const file = (name, text) => ({ name, mimeType: 'application/x-yaml', buffer: Buffer.from(text) });
  await openApp(page);
  await page.getByRole('button', { name: 'Import Docker files' }).click();
  await page.getByLabel('wallet.yaml (identity)').setInputFiles(file('wallet.yaml', wallet.walletYaml));
  await page.getByLabel('vault.yaml').setInputFiles(file('vault.yaml', fx.vaults.current.yaml));
  await page.getByLabel(/nostr.yaml/).setInputFiles(file('nostr.yaml', fx.nostr.yaml));
  await page.getByLabel('Vault password').fill(fx.vaults.password);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('[data-test=nostr-pubkey]')).toHaveText(fx.nostr.pubkeyHex, { timeout: 30_000 });
  await expect.poll(() => stub.registered.length).toBe(1);
  expect(stub.registered[0]['nostr-pubkey']).toBe(fx.nostr.pubkeyHex);

  await expect.poll(async () => (await nostr(page)).relays.find((r) => r.url === CENTRAL_RELAY)?.state).toBe('open');
  await expect(page.evaluate(() => window.satori.subscribe('ab', 'x'))).rejects.toThrow(/64 hex/);
  await expect(page.evaluate((p) => window.satori.subscribe(p, 'x_pred'), fx.nostr.pubkeyHex)).rejects.toThrow(/prediction stream/);
  await expect(page.evaluate((p) => window.satori.subscribe(p, 'never-announced'), fx.nostr.pubkeyHex)).rejects.toThrow(/not announced/);
  await expect(page.evaluate(() => window.satori.setRelays({ relays: ['http://x.test'] }))).rejects.toThrow(/ws:\/\/ or wss:\/\//);
});
