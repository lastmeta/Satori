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
import { verifyEvent, nostrPubkey } from '../src/nostr/event.js';
import { relayUuid } from '../src/nostr/satori.js';
import { keysFromWallet } from '../src/keys/derive.js';
import { openApp, reloadApp } from './load.js';
import { stubCentral as stubAt } from './stub.js';

const CENTRAL_RELAY = 'ws://localhost:7782';
const USER_RELAY = 'ws://localhost:7781';
const PASS = 'correct horse battery';
const fx = JSON.parse(readFileSync(new URL('../test/fixtures/alias-parity.json', import.meta.url)));

/** The stub central (e2e/stub.js), listing 7782 as its relay. */
const stubCentral = (context) => stubAt(context, { relays: [CENTRAL_RELAY] });

/** A node-side reader of a test relay. */
async function reader(url) {
  const r = createRelay(url, { WebSocket });
  r.connect();
  await expect.poll(() => r.state).toBe('open');
  return r;
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
  await expect(page.getByRole('button', { name: 'Create a wallet' })).toBeVisible();
  const s0 = await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  expect(s0.nostr.pubkey).toMatch(/^[0-9a-f]{64}$/);
  const me = s0.nostr.pubkey;
  await expect.poll(() => stub.registered.length).toBe(1);
  expect(stub.registered[0]['nostr-pubkey']).toBe(me);
  const aliasPubkey = stub.registered[0]['alias-pubkey'];
  await expect(page.locator('[data-test=nostr-pubkey]')).toHaveText(me);

  // Relays: central's (read only on the dev server) and the user's, set to the e2e relay.
  const s1 = await page.evaluate((u) => window.satori.setRelays({ relays: [u] }), USER_RELAY);
  expect(s1.relays.map((r) => [r.url, r.from, r.write])).toEqual([[CENTRAL_RELAY, ['central'], false], [USER_RELAY, ['user'], true]]);
  await expect.poll(async () => (await nostr(page)).relays.map((r) => r.state)).toEqual(['open', 'open']);
  await expect(page.locator('[data-test=relay]').filter({ hasText: CENTRAL_RELAY })).toContainText('Connected · read only');

  // Network Streams (on Streams): discover, search, subscribe from the UI.
  await page.evaluate(() => window.satori.go('streams'));
  await page.getByText('Network Streams', { exact: true }).click();
  await page.getByLabel('Search streams').fill(stream);
  const row = page.locator('[data-test=catalog-row]').filter({ hasText: stream });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('E2E walk');
  await expect(row).toContainText('1 min');
  await expect(row.locator('[data-test=catalog-action]')).toHaveText('Predict'); // no Subscribe there: Predict follows and predicts
  await page.evaluate(([p, s]) => window.satori.subscribe(p, s), [provider.pubkey, stream]); // a follow alone: the agent's call
  await expect(row.locator('[data-test=catalog-action]')).toHaveText('Predict');

  // Followed: the stored observation arrives with the follow REQ and is kept; nothing is predicted or published yet.
  await page.locator('[data-test=relay-streams] > summary').click(); // Published Network Streams: folded by default
  const sub = page.locator('[data-test=sub]').filter({ hasText: 'E2E walk' });
  await expect(sub.locator('[data-test=sub-obs]')).toHaveText('100');
  await expect(sub.locator('[data-test=sub-pred]')).toHaveText('–');
  // Predict: the latest observation at once, `_pred` seq 1 published to 7781.
  await sub.locator('[data-test=sub-predict]').click();
  await expect(sub.locator('[data-test=sub-predict]')).toHaveText('Stop predicting');
  await expect(row.locator('[data-test=catalog-action]')).toHaveText('Stop predicting');
  await expect(sub.locator('[data-test=sub-pred]')).toHaveText('100');
  await expect(sub.locator('[data-test=sub-pred]')).toHaveAttribute('title', `${stream}_pred · naive · sent as "100"`);
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
  expect(history.map((h) => [h.seq, h.value, h.obs_seq, h.relays])).toEqual([[2, '101.5', 2, 1], [1, '100', 1, 1]]);
  expect(history[0].event_id).toMatch(/^[0-9a-f]{64}$/);

  // What the user's relay holds from us, read back and checked.
  const user = await reader(USER_RELAY);
  const pred = `${stream}_pred`;
  const [obs] = await user.fetch([{ kinds: [34601], authors: [me], '#d': [pred] }]);
  expect(verifyEvent(obs)).toBe(true);
  expect(obs.tags).toEqual([['d', pred], ['stream', pred], ['seq', '2'], ['satori', 'observation']]);
  // compact JSON with satorilib's fields (docs/design/nostr.md#the-protocol-audit)
  expect(obs.content).toBe(JSON.stringify({ stream_name: pred, timestamp: obs.created_at, value: '101.5', seq_num: 2 }));
  const [ann] = await user.fetch([{ kinds: [34600], authors: [me], '#d': [pred] }]);
  expect(verifyEvent(ann)).toBe(true);
  expect(ann.tags).toEqual([['d', pred], ['satori', 'datastream'], ['stream', `satori:stream:${pred}`],
    ['source_stream', stream], ['source_pubkey', provider.pubkey], ['a', `34600:${provider.pubkey}:${stream}`]]); // `a`: the source, addressable
  expect(JSON.parse(ann.content)).toEqual({ stream_name: pred, nostr_pubkey: me, name: 'Predictions for E2E walk',
    description: '', encrypted: false, price_per_obs: 0, created_at: expect.any(Number), cadence_seconds: 60, tags: [],
    approval_required: false, metadata: { source_stream_name: stream, source_provider_pubkey: provider.pubkey,
      alias_pubkey: aliasPubkey } });
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
  await page.locator('[data-test=relay-streams] > summary').click(); // folded again after the reload
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
  await page.waitForTimeout(1100); // not in seq 3's second (NIP-01's tie rule, as above)
  await provider.observe({ stream, value: '103', seq: 4, timestamp: t0 + 180 });
  await page.waitForTimeout(500);
  const [last] = await user.fetch([{ kinds: [34601], authors: [me], '#d': [pred] }]);
  expect(last.tags).toContainEqual(['seq', '3']);
  expect(await centralRelay.fetch([{ authors: [me] }])).toEqual([]);

  // Network Streams' one button: Predict follows and predicts at once; Stop predicting unfollows.
  await page.getByText('Network Streams', { exact: true }).click(); // folded again after the reload
  await page.getByLabel('Search streams').fill(stream);
  await row.locator('[data-test=catalog-action]').click();
  await expect(row.locator('[data-test=catalog-action]')).toHaveText('Stop predicting');
  await expect(row.locator('[data-test=catalog-action]')).toHaveAttribute('aria-pressed', 'true');
  await expect(sub.locator('[data-test=sub-predict]')).toHaveText('Stop predicting');
  await row.locator('[data-test=catalog-action]').click();
  await expect(row.locator('[data-test=catalog-action]')).toHaveText('Predict');
  await expect(page.locator('[data-test=sub]')).toHaveCount(0);

  // The key's backup (the wallet's passphrase each time, as the others'): nsec and hex; it is random, not from the words.
  await expect(page.evaluate(() => window.satori.backup('nostr'))).rejects.toThrow(/passphrase is needed/);
  const backup = await page.evaluate((p) => window.satori.backup('nostr', p), PASS);
  expect(nostrPubkey(backup.secret)).toBe(me);
  expect(backup.nsec).toMatch(/^nsec1/);

  expect(stub.prod).toEqual([]);
  expect(stub.blocked.every((u) => /7778|satorian/.test(u))).toBe(true);
  expect(await page.evaluate(() => window.violations)).toEqual([]);
  provider.close();
  user.close();
  centralRelay.close();
});

test("Dockerized Neuron import: the wallet file alone, its Nostr key derived from the wallet (NIP-06); refused subscriptions are explained", async ({ context, page }) => {
  const stub = await stubCentral(context);
  const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
  const derived = nostrPubkey(keysFromWallet(hex(fx.vectors[fx.wallets.current.vector].entropyHex)).nostr); // docs/design/wallets.md#derived-keys
  const file = (name, text) => ({ name, mimeType: 'application/x-yaml', buffer: Buffer.from(text) });
  await openApp(page);
  await page.getByRole('button', { name: 'Import Docker files' }).click();
  await page.getByLabel('Wallet file').setInputFiles(file('vault.yaml', fx.wallets.current.yaml));
  await page.getByLabel('Wallet password').fill(fx.wallets.password);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('[data-test=nostr-pubkey]')).toHaveText(derived, { timeout: 30_000 });
  await expect.poll(() => stub.registered.length).toBe(1);
  expect(stub.registered[0]['nostr-pubkey']).toBe(derived);

  await expect.poll(async () => (await nostr(page)).relays.find((r) => r.url === CENTRAL_RELAY)?.state).toBe('open');
  await expect(page.evaluate(() => window.satori.subscribe('ab', 'x'))).rejects.toThrow(/64 hex/);
  await expect(page.evaluate((p) => window.satori.subscribe(p, 'x_pred'), fx.nostr.pubkeyHex)).rejects.toThrow(/prediction stream/);
  await expect(page.evaluate((p) => window.satori.subscribe(p, 'never-announced'), fx.nostr.pubkeyHex)).rejects.toThrow(/not announced/);
  await expect(page.evaluate(() => window.satori.setRelays({ relays: ['http://x.test'] }))).rejects.toThrow(/ws:\/\/ or wss:\/\//);
});

test("an https page: a ws:// relay is blocked, said once, and neither down nor counted; satorian is reached at its wss stand-in; a relay that drops gets its grace", async ({ context, page }) => {
  test.setTimeout(240_000);
  const BLOCKED = 'ws://relay.example:7777'; // a ws:// relay with no wss stand-in: an https page can never open it
  const RELAY = 'wss://relay.test'; // a wss:// relay, this test's proxy to the test relay on 7782
  const SATORIAN = 'ws://satorian.satorinet.io:7777'; // what central lists today: an https page can't open it either
  const STAND_IN = 'wss://relay.satorinet.io'; // its wss stand-in (src/config.js's default), here this test's proxy to 7782
  const stub = await stubAt(context, { relays: [RELAY, BLOCKED, SATORIAN] });
  // the dev server's files under https://neuron.test (a secure page, as https://neuron.satorinet.io), through this test
  await context.route('https://neuron.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/rpc') return route.fallback();
    return route.fulfill({ response: await route.fetch({ url: `http://localhost:5180${url.pathname}${url.search}` }) });
  });
  // the wss:// relays: proxied to the test relay on 7782 by this test, which can cut them: then every reconnect is refused
  // (registered after the stub's, which routes the real stand-in to nothing: this route wins)
  let cut = false;
  const sockets = [];
  await context.routeWebSocket((u) => ['relay.test', 'relay.satorinet.io'].includes(u.hostname), (ws) => {
    if (cut) return ws.close();
    const upstream = new WebSocket(CENTRAL_RELAY);
    const queue = [];
    upstream.on('open', () => queue.splice(0).forEach((m) => upstream.send(m)));
    upstream.on('message', (d) => ws.send(d.toString()));
    upstream.on('close', () => ws.close());
    ws.onMessage((m) => (upstream.readyState === 1 ? upstream.send(m) : queue.push(m)));
    ws.onClose(() => upstream.close());
    sockets.push(ws);
  });
  const stream = `e2e-https-${Date.now().toString(36)}`;
  const provider = await connectProvider({ url: CENTRAL_RELAY });
  await provider.announce({ stream, name: 'E2E https', description: '', cadence: 60, tags: [] });
  await provider.observe({ stream, value: '7', seq: 1, timestamp: Math.floor(Date.now() / 1000) - 60 });

  expect(await openApp(page, 'https://neuron.test/')).toBe('setup');
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await page.evaluate(() => window.satori.setRelays({ relays: [] })); // central's three only
  // satorian goes to its stand-in, as central's relay (read only on the dev server), saying which relay it stands in for
  await expect.poll(async () => (await nostr(page)).relays.map((r) => [r.url, r.from, r.state, r.error, r.for]), { timeout: 20_000 })
    .toEqual([[RELAY, ['central'], 'open', '', null], [BLOCKED, ['central'], 'blocked', 'ws:// cannot be opened from an https page', null],
      [STAND_IN, ['central'], 'open', '', SATORIAN]]);
  await page.evaluate(([p, s]) => window.satori.subscribe(p, s, { predict: true }), [provider.pubkey, stream]);

  // the blocked relay is not down: the chip counts the two that can open, nothing amber, no card for it
  let h = await page.evaluate(() => window.satori.health());
  expect(h.channels.relays).toMatchObject({ state: 'ok', text: '2 relays' }); // it read "1 of 3 relays down"
  expect(h.reasons.map((r) => r.id)).not.toContain('relay-down');
  // said once, in the relays' detail (Settings); the stand-in says what it stands in for, in small words
  await page.evaluate(() => window.satori.go('settings'));
  await page.locator('#settings-advanced > summary').click(); // folded under Advanced
  await expect(page.locator('[data-test=relay]').filter({ hasText: BLOCKED }).locator('[data-test=relay-state]')).toHaveText('Not reachable here');
  await expect(page.locator('[data-test=relays-blocked]')).toHaveText("A ws:// relay can't be reached from this page (only wss:// can), so it is left out: it doesn't count as down.");
  const standIn = page.locator('[data-test=relay]').filter({ hasText: STAND_IN });
  await expect(standIn.locator('[data-test=relay-for]')).toHaveText(`for ${SATORIAN}`);
  await expect(standIn.locator('[data-test=relay-state]')).toHaveText('Connected · read only');
  await expect(page.locator('[data-test=relay-for]')).toHaveCount(1);
  await page.locator('#settings-relays').screenshot({ path: test.info().outputPath('relays.png') });
  await page.evaluate(() => window.satori.go('streams'));
  await expect.poll(async () => (await nostr(page)).relays.filter((r) => r.state === 'open').length).toBe(2);

  // the usable relays drop and refuse reconnects: within the grace it is not red ("Every relay is down" waits 10 min)
  cut = true;
  for (const ws of sockets) await ws.close();
  await expect.poll(async () => (await nostr(page)).relays.filter((r) => r.state === 'open').length).toBe(0);
  const r = (await nostr(page)).relays.find((x) => x.url === RELAY);
  expect(Date.now() - r.downSince).toBeLessThan(60_000); // since when it is down: the grace counts from there
  h = await page.evaluate(() => window.satori.health());
  expect(h.reasons.map((x) => x.id)).not.toContain('relays-down');
  expect(h.status).not.toBe('bad');
  expect(stub.prod).toEqual([]);
  expect(stub.blocked.filter((u) => /satorian|relay\.satorinet/.test(u))).toEqual([]); // ws://satorian never tried, the real stand-in never reached
  provider.close?.();
});
