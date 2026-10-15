// The app in Chrome against a stub central (the dev server's default,
// central2, routed here; prod is blocked): create (identity + vault) →
// register → Poll now: observations in, predictions out → reload keeps the
// schedule → Unlock/Lock, backup words and Docker files; Docker import (a
// vault mismatch); words restore; the agent API.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyMessage, deriveKeys, entropyFromWords } from '../src/keys/index.js';
import { readWallet } from '../src/keys/docker.js';
import { forecast, STEP_S } from '../src/engine/index.js';
import { pyFloatStr } from '../src/central/index.js';
import { openApp, reloadApp, LOAD_TIMEOUT } from './load.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/identity-parity.json', import.meta.url)));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const PASS = 'correct horse battery';
const ADDRESS = /^E[1-9A-HJ-NP-Za-km-z]{33}$/;
const CENTRAL = 'https://central2.satorinet.io';
const T0 = Math.floor(Date.now() / 1000) - 3600;

const entry = (uuid, name, at, value) => ({
  id: 1, observed_at: `${at}.6204007`, value, hash: '', stream_id: 1,
  stream: { id: 1, uuid, name, author: null, secondary: null, target: null, meta: null, description: null },
  ts: new Date(at * 1000).toISOString().slice(0, -1), stream_uuid: uuid,
});
const BATCH = [entry('u-btc', 'bitcoin', T0, '67000.5'), entry('u-eth', 'eth', T0, '2500.0')];

/**
 * A central for the tests, on `url`: register, observations batch, challenge,
 * login (checks the identity's signature), predictions batch. `fail` holds
 * statuses for the next predictions batches. Prod central is aborted and recorded.
 */
async function stubCentral(context, url = CENTRAL) {
  const stub = { batch: BATCH, vaults: {}, otherVault: null, fail: [], registered: [], logins: [], batches: [], prod: [] };
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, wallet-pubkey, vault-pubkey, nostr-pubkey, neuron-version, message, signature',
  };
  // No relay here (e2e/nostr.spec.js has its own): every socket but Vite's is closed at once.
  await context.routeWebSocket((u) => u.port !== '5180', (ws) => ws.close());
  const reply = (route, status, json) => route.fulfill({ status, json, headers: cors });
  await context.route('**/rpc', (route) => route.abort()); // no chain here (e2e/base.spec.js has a fake one)
  await context.route('https://network.satorinet.io/**', (route) => {
    stub.prod.push(route.request().url());
    return route.abort();
  });
  await context.route(`${url}/**`, (route) => {
    const req = route.request();
    const h = req.headers();
    const path = new URL(req.url()).pathname + new URL(req.url()).search;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    switch (`${req.method()} ${path}`) {
      case 'POST /api/v1/peer/register':
        stub.registered.push(h);
        return reply(route, 200, { success: true, peer_id: 7, wallet_address: 'Eid', message: 'Peer registered successfully',
          vault_address: stub.otherVault ?? stub.vaults[h['vault-pubkey']] ?? null });
      case 'GET /api/v1/observations/batch?limit=100':
        return reply(route, 200, stub.batch);
      case 'GET /api/v1/auth/challenge':
        return reply(route, 200, { challenge: `c-${stub.logins.length}` });
      case 'POST /api/v1/auth/login': {
        const ok = verifyMessage(h.message, h.signature, { pubkey: h['wallet-pubkey'] });
        stub.logins.push({ ...h, ok });
        return ok ? reply(route, 200, { access_token: `jwt-${stub.logins.length}`, expires_in: 3600 })
          : reply(route, 401, { detail: 'Invalid signature' });
      }
      case 'POST /api/v1/predictions/batch': {
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

const visible = (loc) => loc.filter({ visible: true });
const status = (page) => page.evaluate(() => window.satori.status());
const row = (page, name) => page.locator('[data-test=stream]').filter({ hasText: name });

test('create, register, Poll now (observations in, predictions out), reload keeps the schedule, unlock, backup, lock, one tab', async ({ context, page }) => {
  const stub = await stubCentral(context);
  await context.addInitScript(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });

  // Setup: create, the vault's words, confirm three, passphrase.
  await openApp(page);
  await page.getByRole('button', { name: 'Create a new neuron' }).click();
  const words = await visible(page.locator('ol.words li')).allTextContents();
  expect(words).toHaveLength(24);
  const vaultKeys = deriveKeys(entropyFromWords(words.join(' ')));
  stub.vaults[vaultKeys.pubkey] = vaultKeys.address; // central keeps our vault
  await page.getByRole('button', { name: 'I wrote them down' }).click();
  for (const input of await visible(page.getByLabel(/^Word #\d+/)).all()) {
    const n = Number((await input.evaluate((el) => el.closest('label').textContent)).match(/#(\d+)/)[1]);
    await input.fill(words[n - 1]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await visible(page.getByLabel('Passphrase', { exact: true })).fill('abc');
  await page.getByLabel('Repeat passphrase').fill('abc');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'at least 4' })).toBeVisible();
  await visible(page.getByLabel('Passphrase', { exact: true })).fill(PASS);
  await page.getByLabel('Repeat passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // Home: two addresses, the vault locked, registered with central2 (headers only, no token).
  const idAddr = page.locator('[data-test=identity]');
  const vaultAddr = page.locator('[data-test=vault]');
  await expect(idAddr).toHaveText(ADDRESS, { timeout: LOAD_TIMEOUT }); // the vault's encryption, then the neuron starts
  await expect(vaultAddr).toHaveText(vaultKeys.address);
  const identity = await idAddr.textContent();
  expect(identity).not.toBe(vaultKeys.address);
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  await expect(page.locator('[data-test=central-url]')).toHaveText(CENTRAL);
  await expect(page.locator('[data-test=registered]')).toHaveText('Yes · peer 7');
  await expect(page.locator('[data-test=mismatch]')).toBeHidden();
  expect(stub.registered).toHaveLength(1);
  const reg = stub.registered[0];
  expect(reg['wallet-pubkey']).toMatch(/^0[23][0-9a-f]{64}$/);
  expect(reg['vault-pubkey']).toBe(vaultKeys.pubkey);
  expect(reg['neuron-version']).toBe(`browser-${version}`);
  expect(reg.authorization).toBeUndefined();

  // The first poll is Lite's 5–30 min after start; nothing has been polled yet.
  const before = await status(page);
  const now = Date.now() / 1000;
  expect(before.central.nextPoll).toBeGreaterThan(now + 290);
  expect(before.central.nextPoll).toBeLessThan(now + 1810);
  await expect(page.locator('[data-test=last-poll]')).toHaveText('Not yet');
  await expect(page.getByText('None yet: they arrive with the first poll.')).toBeVisible();

  // Poll now: two streams stored, forecast, sent after an identity-signed login.
  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect(page.locator('[data-test=last-submit]')).toContainText('2 of 2 accepted');
  await expect(page.locator('[data-test=last-poll]')).toContainText('2 streams, 2 new, 2 predicted');
  await expect(page.locator('[data-test=pending]')).toHaveText('0');
  await expect(page.locator('[data-test=stream]')).toHaveCount(2);
  const btc = row(page, 'bitcoin');
  await expect(btc.locator('[data-test=obs]')).toHaveText('67,000.50');
  await expect(btc.locator('[data-test=t1]')).toHaveText('67,000.50');
  await expect(btc.locator('[data-test=t2]')).toHaveText('67,000.50');
  await expect(btc.locator('[data-test=status]')).toHaveText('Sent');
  expect(stub.logins).toHaveLength(1);
  expect(stub.logins[0]).toMatchObject({ ok: true, message: 'c-0', 'wallet-pubkey': reg['wallet-pubkey'] });
  expect(verifyMessage(stub.logins[0].message, stub.logins[0].signature, { address: identity })).toBe(true);
  const [items] = stub.batches;
  expect(items.map((i) => [i.stream_uuid, i.stream_name, i.value, i.t1_value]))
    .toEqual([['u-btc', 'bitcoin', '67000.5', '67000.5'], ['u-eth', 'eth', '2500.0', '2500.0']]);
  for (const i of items) {
    expect(Math.abs(Number(i.observed_at) - Date.now() / 1000)).toBeLessThan(60);
    expect(i.hash).toBe(createHash('sha256').update(i.value + i.observed_at).digest('hex').slice(0, 16));
  }
  const after = await status(page);
  expect(after.central.nextPoll - after.central.lastPoll.at).toBeCloseTo(11 * 3600, -1);

  // Second tab: told to use the first one.
  const other = await context.newPage();
  expect(await openApp(other)).toBe('elsewhere');
  await expect(other.getByText('Satori is open in another tab')).toBeVisible();
  await other.close();

  // Reload: running at once with no passphrase; registered again; the schedule and the data are kept.
  await reloadApp(page);
  await expect(idAddr).toHaveText(identity);
  await expect(page.locator('[data-test=registered]')).toHaveText('Yes · peer 7');
  expect(stub.registered).toHaveLength(2);
  expect((await status(page)).central.nextPoll).toBe(after.central.nextPoll);
  await expect(page.locator('[data-test=stream]')).toHaveCount(2);
  await expect(page.locator('[data-test=last-submit]')).toContainText('2 of 2 accepted');
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeHidden();

  // Unlock: wrong passphrase refused, then the vault opens.
  const pass = page.getByLabel('Vault passphrase');
  await pass.fill('wrong passphrase');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Wrong passphrase' })).toBeVisible();
  await pass.fill(PASS);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Unlocked');

  // Backup: the vault's words are the ones from setup; the identity's are its own; both files download.
  await page.getByText('Backup').click();
  await page.getByRole('button', { name: 'Vault words' }).click();
  await expect(visible(page.locator('ol.words li'))).toHaveText(words);
  await page.getByRole('button', { name: 'Identity words' }).click();
  const idWords = await visible(page.locator('ol.words li')).allTextContents();
  expect(idWords).toHaveLength(24);
  expect(idWords).not.toEqual(words);
  await expect(page.locator('[data-test=wif]')).toHaveText(/^[KL][1-9A-HJ-NP-Za-km-z]{51}$/);
  const download = async (name) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: `Download ${name}` }).click()]);
    expect(dl.suggestedFilename()).toBe(name);
    return readFileSync(await dl.path(), 'utf8');
  };
  const walletFile = await readWallet(await download('wallet.yaml'));
  expect(walletFile.keys.address).toBe(identity);
  expect(walletFile.keys.pubkey).toBe(reg['wallet-pubkey']);
  expect(walletFile.keys.words).toBe(idWords.join(' '));
  const vaultText = await download('vault.yaml');
  await expect(readWallet(vaultText)).rejects.toThrow(/encrypted/);
  const vaultFile = await readWallet(vaultText, { password: PASS });
  expect(vaultFile.keys.address).toBe(vaultKeys.address);
  expect(vaultFile.mismatches).toEqual([]);

  // Lock: the vault and the backup are gone; the neuron still polls and submits.
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  await expect(visible(page.locator('ol.words li'))).toHaveCount(0);
  await expect(page.getByText('Unlock the vault to back up your keys.')).toBeVisible();
  stub.batch = [entry('u-btc', 'bitcoin', T0 + 3600, '67100.5'), BATCH[1]];
  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect(page.locator('[data-test=last-poll]')).toContainText('2 streams, 1 new, 1 predicted');
  await expect(btc.locator('[data-test=t1]')).toHaveText('67,100.50'); // two observations: naive, the last value
  await expect(btc.locator('[data-test=t2]')).toHaveText('67,100.50');
  await expect(btc.locator('[data-test=model]')).toHaveText('naive');
  expect(stub.batches).toHaveLength(2);

  expect(stub.prod).toEqual([]);
  expect(await page.evaluate(() => window.violations)).toEqual([]);
});

test('agent API: poll, dedupe, a kept queue resent, the central URL setting', async ({ context, page }) => {
  const stub = await stubCentral(context);
  const elsewhere = await stubCentral(context, 'https://central.test');
  const v = fx.vectors[2];
  stub.vaults[v.pubkey] = v.address;
  await openApp(page);
  await expect(page.getByRole('button', { name: 'Create a new neuron' })).toBeVisible();
  await expect(page.evaluate(() => window.satori.poll())).rejects.toThrow(/Set up first/);
  const s0 = await page.evaluate((w) => window.satori.setup({ passphrase: 'pass', vaultWords: w }), v.words);
  expect(s0).toMatchObject({ screen: 'home', vault: v.address, unlocked: false });
  expect(s0.identity).toMatch(ADDRESS);
  expect(s0.central).toMatchObject({ url: CENTRAL, pending: 0, lastPoll: null, lastSubmit: null });
  await expect.poll(async () => (await status(page)).central.registration?.ok).toBe(true);
  expect((await status(page)).central.registration).toMatchObject({ peer_id: 7, vault_address: v.address, vaultMismatch: false });

  const poll = () => page.evaluate(() => window.satori.poll());
  const r1 = await poll();
  expect(r1.poll).toMatchObject({ streams: 2, new: 2, predicted: 2 });
  expect(r1.submit).toMatchObject({ total_submitted: 2, successful: 2 });
  // The same batch again: nothing new, nothing sent.
  expect(await poll()).toMatchObject({ poll: { streams: 2, new: 0, predicted: 0 }, submit: null });
  expect(stub.batches).toHaveLength(1);

  // A new bitcoin row; central fails the batch: the prediction is kept.
  stub.batch = [entry('u-btc', 'bitcoin', T0 + 60, '67001.5'), BATCH[1]];
  stub.fail.push(500, 500); // a 5xx is resent once
  const r3 = await poll();
  expect(r3.poll).toMatchObject({ new: 1, predicted: 1 });
  expect(r3.submit.error).toBe('central 500: boom');
  expect((await status(page)).central.pending).toBe(1);
  await expect(page.locator('[data-test=pending]')).toHaveText('1');
  await expect(row(page, 'bitcoin').locator('[data-test=status]')).toHaveText('Pending');
  await expect(page.locator('[data-test=last-submit]')).toContainText('kept for the next poll');

  // A 401 on the batch: one fresh login and one retry; the kept prediction goes with the next poll.
  stub.fail.push(401);
  const r4 = await poll();
  expect(r4).toMatchObject({ poll: { new: 0 }, submit: { successful: 1 } });
  expect(stub.batches.at(-1)).toEqual([expect.objectContaining({ stream_uuid: 'u-btc', value: '67001.5', t1_value: '67001.5' })]);
  expect((await status(page)).central.pending).toBe(0);
  const preds = await page.evaluate(() => window.satori.predictions('bitcoin'));
  expect(preds.map((p) => [p.status, p.t1])).toEqual([['sent', 67001.5], ['sent', 67000.5]]);
  expect(preds[0]).toMatchObject({ stream_uuid: 'u-btc', name: 'bitcoin', model: 'naive', phi: null, weight: null,
    hash: stub.batches.at(-1)[0].hash });
  const streams = await page.evaluate(() => window.satori.streams());
  expect(streams.map((s) => [s.name, s.observations, s.obs_value])).toEqual([['bitcoin', 2, 67001.5], ['eth', 1, 2500]]);

  // The engine: naive until a stream has 8 buckets of 12 h, then bar1, with the same numbers as in node.
  const ZIG = [67100.5, 67000.5, 67200.5, 67100.5, 67300.5, 67200.5, 67400.5];
  for (const [k, value] of ZIG.entries()) {
    stub.batch = [entry('u-btc', 'bitcoin', T0 + (k + 1) * STEP_S, String(value)), BATCH[1]];
    expect((await poll()).poll).toMatchObject({ new: 1, predicted: 1 });
    if (k === 0) await expect(row(page, 'bitcoin').locator('[data-test=model]')).toHaveText('naive');
  }
  const [bar1] = await page.evaluate(() => window.satori.predictions('bitcoin', 1));
  const history = [[T0, 67000.5], [T0 + 60, 67001.5], ...ZIG.map((v, k) => [T0 + (k + 1) * STEP_S, v])];
  const expected = forecast(history.map(([ts, value]) => ({ ts, value })));
  expect(bar1).toMatchObject({ model: 'bar1', t1: expected.t1, t2: expected.t2, phi: expected.phi, weight: expected.weight });
  expect(bar1.t2).not.toBe(67400.5);
  expect(stub.batches.at(-1)).toEqual([expect.objectContaining({ value: pyFloatStr(expected.t2), t1_value: pyFloatStr(expected.t1) })]);
  await expect(row(page, 'bitcoin').locator('[data-test=model]')).toHaveText('bar1');
  await expect(row(page, 'bitcoin').locator('[data-test=model]')).toHaveAttribute('title', /^Bayesian AR\(1\) on 12 h returns · φ /);

  // The central URL: https only; a new one registers at once. Its uuids differ, so the
  // pending queue and the stream list are dropped and refill from it.
  stub.batch = [entry('u-btc', 'bitcoin', T0 + 120, '67005.5'), BATCH[1]];
  stub.fail.push(500, 500);
  expect((await poll()).submit.error).toBe('central 500: boom');
  await expect(page.evaluate(() => window.satori.setCentral('http://central.test'))).rejects.toThrow(/https:\/\//);
  expect((await status(page)).central.pending).toBe(1); // a refused URL changes nothing
  elsewhere.batch = [{ ...entry('u-btc-2', 'bitcoin', T0 + 120, '67005.5'), stream: { uuid: 'u-btc-2', name: 'bitcoin', meta: '{"unit":"USD"}' } }];
  const c = await page.evaluate(() => window.satori.setCentral('https://central.test/'));
  expect(c).toMatchObject({ url: 'https://central.test', registration: { ok: true, peer_id: 7 }, pending: 0, lastPoll: null, lastSubmit: null });
  expect(elsewhere.registered).toHaveLength(1);
  await expect(page.locator('[data-test=central-url]')).toHaveText('https://central.test');
  expect(await page.evaluate(() => window.satori.streams())).toEqual([]);
  await expect(page.locator('[data-test=stream]')).toHaveCount(0);
  expect((await poll()).submit).toMatchObject({ successful: 1 });
  expect(elsewhere.batches).toEqual([[expect.objectContaining({ stream_uuid: 'u-btc-2' })]]);
  expect(await page.evaluate(() => window.satori.streams())).toMatchObject([{ uuid: 'u-btc-2', meta: { unit: 'USD' } }]);
  expect((await page.evaluate(() => window.satori.setCentral(''))).url).toBe(CENTRAL);
  expect(await page.evaluate(() => window.satori.streams())).toEqual([]);

  // The keys, as in step 2.
  await expect(page.evaluate(() => window.satori.backup('vault'))).rejects.toThrow(/Unlock the vault first/);
  await expect(page.evaluate(() => window.satori.unlock('nope'))).rejects.toThrow(/Wrong passphrase/);
  await page.evaluate(() => window.satori.unlock('pass'));
  expect(await page.evaluate(() => window.satori.backup('vault'))).toEqual({ words: v.words, wif: v.wif });
  expect(await page.evaluate(() => window.satori.file('vault.yaml'))).toContain(`address: ${v.address}`);
  expect(await page.evaluate(() => window.satori.file('wallet.yaml'))).toContain(`address: ${s0.identity}`);
  for (const which of ['Vault', 'vaults', '', null]) {
    await expect(page.evaluate((w) => window.satori.backup(w), which)).rejects.toThrow(/'identity' or 'vault'/);
  }
  for (const name of ['vault.yml', 'Vault.yaml', 'vault', null]) {
    await expect(page.evaluate((n) => window.satori.file(n), name)).rejects.toThrow(/'wallet.yaml', 'vault.yaml' or 'nostr.yaml'/);
  }
  await page.evaluate(() => window.satori.lock());
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  expect(stub.prod).toEqual([]);
});

test('import Docker files; central has another vault for this identity: a mismatch is shown; Settings', async ({ context, page }) => {
  const stub = await stubCentral(context);
  stub.otherVault = 'EOtherVau1tAddressXXXXXXXXXXXXXXXX';
  const wallet = fx.vectors[0];
  const vault = fx.vectors[fx.vaults.current.vector];
  const file = (name, text) => ({ name, mimeType: 'application/x-yaml', buffer: Buffer.from(text) });

  await openApp(page);
  await page.getByRole('button', { name: 'Import Docker files' }).click();
  // In the wrong slots: refused, and the message says so.
  await page.getByLabel('wallet.yaml (identity)').setInputFiles(file('vault.yaml', fx.vaults.current.yaml));
  await page.getByLabel('vault.yaml').setInputFiles(file('wallet.yaml', wallet.walletYaml));
  await page.getByLabel('Vault password').fill(fx.vaults.password);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The files are swapped' })).toBeVisible();
  await page.getByLabel('wallet.yaml (identity)').setInputFiles(file('wallet.yaml', wallet.walletYaml));
  await page.getByLabel('vault.yaml').setInputFiles(file('vault.yaml', fx.vaults.current.yaml));
  await page.getByLabel('Vault password').fill(fx.vaults.wrongPassword);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'vault.yaml: Wrong passphrase' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Vault password').fill(fx.vaults.password);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('[data-test=identity]')).toHaveText(wallet.address, { timeout: 30_000 });
  await expect(page.locator('[data-test=vault]')).toHaveText(vault.address);

  // Registered with Docker's keys; central answers with another vault.
  await expect(page.locator('[data-test=registered]')).toHaveText('Yes · peer 7');
  expect(stub.registered[0]).toMatchObject({ 'wallet-pubkey': wallet.pubkey, 'vault-pubkey': vault.pubkey });
  await expect(page.locator('[data-test=mismatch]'))
    .toHaveText(`Vault mismatch: central has ${stub.otherVault} for this identity, not this vault (${vault.address}).`);

  // Settings: https only; an unreachable central is shown, not thrown.
  await page.locator('summary', { hasText: 'Settings' }).click();
  const url = page.getByLabel('Central URL');
  await url.fill('http://central.test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'https://' })).toBeVisible();
  await context.route('https://down.test/**', (route) => route.abort());
  await url.fill('https://down.test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('[data-test=central-url]')).toHaveText('https://down.test');
  await expect(page.locator('[data-test=registered]')).toHaveText(/^No: central unreachable: /);
  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect(page.locator('[data-test=last-poll]')).toContainText('failed: central unreachable');
  await url.fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('[data-test=central-url]')).toHaveText(CENTRAL);

  // The imported vault unlocks with the Docker password and shows the same words.
  await page.getByLabel('Vault passphrase').fill(fx.vaults.password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByText('Backup').click();
  await page.getByRole('button', { name: 'Vault words' }).click();
  await expect(visible(page.locator('ol.words li'))).toHaveText(vault.words.split(' '));
});

test('restore from words', async ({ context, page }) => {
  await stubCentral(context);
  const [v, id] = [fx.vectors[0], fx.vectors[3]];
  await openApp(page);
  await page.getByRole('button', { name: 'Restore from words' }).click();
  await page.getByLabel('Vault words (24)').fill('abandon '.repeat(23) + 'art'); // valid words, but key 0
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'vault words are not 24 valid' })).toBeVisible();
  await page.getByLabel('Vault words (24)').fill(v.words);
  await page.getByLabel(/Identity words/).fill(id.words);
  await page.getByRole('button', { name: 'Continue' }).click();
  await visible(page.getByLabel('Passphrase', { exact: true })).fill(PASS);
  await page.getByLabel('Repeat passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-test=vault]')).toHaveText(v.address, { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=identity]')).toHaveText(id.address);
});

test('setup: one at a time, and it leaves rows it does not own', async ({ context, page }) => {
  await stubCentral(context);
  // A meta row this app does not own (the step-1 prototype kept its key as meta.vault).
  await page.goto('/e2e/store/');
  const row0 = { v: 1, note: 'not ours' };
  expect(await page.evaluate((r) => window.probe({ cmd: 'app-meta', key: 'vault', value: r }), row0)).toEqual({ value: row0 });

  await openApp(page);
  await expect(page.getByRole('button', { name: 'Create a new neuron' })).toBeVisible();
  await expect(page.getByText(/prototype/)).toHaveCount(0);
  // Two setups at once (an agent retrying, or an agent and the UI): one wins, the other is refused.
  const results = await page.evaluate(() => Promise.allSettled([
    window.satori.setup({ passphrase: 'pass' }), window.satori.setup({ passphrase: 'pass' }),
  ]).then((all) => all.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason.message }))));
  const done = results.filter((r) => r.screen === 'home');
  expect(done).toHaveLength(1);
  expect(results.find((r) => r.error)?.error).toMatch(/busy|already set up/i);
  await expect(page.getByRole('button', { name: 'Create a new neuron' })).toBeHidden();

  // What was stored is what the winner reported.
  await reloadApp(page);
  await expect(page.locator('[data-test=identity]')).toHaveText(done[0].identity);
  await expect(page.locator('[data-test=vault]')).toHaveText(done[0].vault);
  await expect(page.evaluate(() => window.satori.setup({ passphrase: 'pass' }))).rejects.toThrow(/already set up/i);

  await page.goto('/e2e/store/');
  expect(await page.evaluate(() => window.probe({ cmd: 'app-meta', key: 'vault' }))).toEqual({ value: row0 });
});
