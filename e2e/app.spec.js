// The app in Chrome against a stub central (the dev server's default,
// central2, routed here; prod is blocked): create (identity + vault) with a
// non-Latin passphrase → register → Poll now: observations in, predictions out
// → reload keeps the schedule → Unlock/Lock, backup (words, keys, the Nostr
// key); Dockerized Neuron import (a vault mismatch; a short Docker password
// asks for a new passphrase); words restore; the agent API.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { secretFromWords, publicKey, evmAddress, wordsOf } from '../src/keys/keys.js';
import { verifyMessage } from 'viem';
import { nostrPubkey, nsec } from '../src/nostr/event.js';
import { forecast, STEP_S } from '../src/engine/index.js';
import { runModels } from '../src/engine/evolve.js';
import { openApp, reloadApp, polled, LOAD_TIMEOUT } from './load.js';
import { stubCentral as stubAt, CENTRAL } from './stub.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/identity-parity.json', import.meta.url)));
const { profiles } = JSON.parse(readFileSync(new URL('../test/fixtures/profiles.json', import.meta.url)));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const PASS = '密码 correct horse 🔑'; // any Unicode (docs/design/keys.md)
const ADDRESS = /^0x[0-9a-fA-F]{40}$/; // a Base address: the only one shown
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const T0 = Math.floor(Date.now() / 1000) - 3600;

const entry = (uuid, name, at, value) => ({
  id: 1, observed_at: `${at}.6204007`, value, hash: '', stream_id: 1,
  stream: { id: 1, uuid, name, author: null, secondary: null, target: null, meta: null, description: null },
  ts: new Date(at * 1000).toISOString().slice(0, -1), stream_uuid: uuid,
});
const BATCH = [entry('u-btc', 'bitcoin', T0, '67000.5'), entry('u-eth', 'eth', T0, '2500.0')];

/** The stub central (e2e/stub.js) on `url`, serving BATCH. */
async function stubCentral(context, url) {
  const stub = await stubAt(context, { url });
  stub.batch = BATCH;
  return stub;
}

const visible = (loc) => loc.filter({ visible: true });
const status = (page) => page.evaluate(() => window.satori.status());
/** Show a tab (Home · Streams · Wallet · Settings), as the nav does. */
const go = (page, tab) => page.evaluate((t) => window.satori.go(t), tab);
/** A stream's row by its name (another row's Model column may name it as a companion). */
const row = (page, name) => page.locator('[data-test=stream]').filter({ has: page.locator('.sname', { hasText: new RegExp(`^${name}$`) }) });

test('create (a non-Latin passphrase), register, the first poll at once, reload keeps the schedule, unlock, backup, lock, one tab', async ({ context, page }) => {
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
  const vaultPub = publicKey(secretFromWords(words.join(' ')));
  const vaultAddress = evmAddress(vaultPub);
  stub.vaults[vaultPub] = vaultAddress; // central pays this vault: its vault_base_address
  await page.getByRole('button', { name: 'I wrote them down' }).click();
  for (const input of await visible(page.getByLabel(/^Word #\d+/)).all()) {
    const n = Number((await input.evaluate((el) => el.closest('label').textContent)).match(/#(\d+)/)[1]);
    await input.fill(words[n - 1]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Latin-1')).toHaveCount(0);
  await visible(page.getByLabel('Passphrase', { exact: true })).fill('密码密码'); // 4 characters
  await page.getByLabel('Repeat passphrase').fill('密码密码');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'at least 8 characters' })).toBeVisible();
  await visible(page.getByLabel('Passphrase', { exact: true })).fill(PASS);
  await page.getByLabel('Repeat passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // Home: two Base addresses, the vault locked, registered with central2 (headers only, no token).
  const idAddr = page.locator('[data-test=identity]');
  const vaultAddr = page.locator('[data-test=vault]');
  await expect(idAddr).toHaveText(ADDRESS, { timeout: LOAD_TIMEOUT }); // the vault's encryption, then the neuron starts
  await expect.poll(() => page.evaluate(() => document.body.dataset.screen)).toBe('home'); // was 'setup': kept current
  await expect(vaultAddr).toHaveText(vaultAddress);
  const identity = await idAddr.textContent();
  expect(identity).not.toBe(vaultAddress);
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  await expect(page.locator('[data-test=central-url]')).toHaveText(CENTRAL);
  await expect(page.locator('[data-test=registered]')).toHaveText('Yes · peer 7');
  await expect(page.locator('[data-test=mismatch]')).toBeHidden();
  expect(stub.registered).toHaveLength(1);
  const reg = stub.registered[0];
  expect(reg['wallet-pubkey']).toMatch(/^0[23][0-9a-f]{64}$/);
  expect(reg['vault-pubkey']).toBe(vaultPub);
  expect(evmAddress(reg['wallet-pubkey'])).toBe(identity);
  expect(reg['neuron-version']).toBe(`browser-${version}`);
  expect(reg.authorization).toBeUndefined();

  // The first poll runs at once, right after register (no 5–30 min wait, no Poll now): two streams stored,
  // forecast, sent after an identity-signed login.
  await go(page, 'streams');
  await expect(page).toHaveURL(/#streams$/);
  await expect(page.locator('[data-test=last-submit]')).toContainText('2 of 2 accepted');
  expect(stub.polls).toEqual([1]); // one poll, after the register
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
  expect(stub.logins[0].signature).toMatch(/^0x[0-9a-f]{128}1[bc]$/); // EIP-191: r ‖ s ‖ v, v 27/28
  expect(await verifyMessage({ address: identity, message: 'c-0', signature: stub.logins[0].signature })).toBe(true);
  const [items] = stub.batches;
  expect(items.map((i) => [i.stream_uuid, i.stream_name, i.value, i.t1_value]))
    .toEqual([['u-btc', 'bitcoin', '67000.5', '67000.5'], ['u-eth', 'eth', '2500', '2500']]);
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

  // Reload: running at once with no passphrase; registered again; the schedule and the data are kept; the tab too.
  await reloadApp(page);
  await expect(page.locator('[data-test=streams-tab]')).toBeVisible();
  await expect(idAddr).toHaveText(identity);
  await expect(page.locator('[data-test=registered]')).toHaveText('Yes · peer 7');
  expect(stub.registered).toHaveLength(2);
  await expect.poll(async () => (await status(page)).central.nextPoll).toBe(after.central.nextPoll);
  expect(stub.polls).toEqual([1]); // not due yet: it waits
  await expect(page.locator('[data-test=stream]')).toHaveCount(2);
  await expect(page.locator('[data-test=last-submit]')).toContainText('2 of 2 accepted');
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeHidden();

  // Unlock (Settings, Keys): wrong passphrase refused, then the vault opens.
  await go(page, 'settings');
  const pass = page.getByLabel('Vault passphrase', { exact: true });
  await pass.fill('wrong passphrase');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Wrong passphrase' })).toBeVisible();
  await pass.fill(PASS);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Unlocked');

  // Backup: the vault's words are the ones from setup; the identity's are its own; each private key is its
  // address's; the Nostr key (random, not from the words) as nsec and hex. Nothing to download.
  await expect(page.getByRole('button', { name: /^Download/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Vault words' }).click();
  await expect(visible(page.locator('ol.words li'))).toHaveText(words);
  const key = page.locator('[data-test=backup-key]');
  await expect(key).toHaveText(/^0x[0-9a-f]{64}$/);
  expect(evmAddress(publicKey(hex((await key.textContent()).slice(2))))).toBe(vaultAddress);
  await page.getByRole('button', { name: 'Identity words' }).click();
  const idWords = await visible(page.locator('ol.words li')).allTextContents();
  expect(idWords).toHaveLength(24);
  expect(idWords).not.toEqual(words);
  const idSecret = hex((await key.textContent()).slice(2));
  expect(wordsOf(idSecret)).toBe(idWords.join(' '));
  expect(publicKey(idSecret)).toBe(reg['wallet-pubkey']);
  await page.getByRole('button', { name: 'Nostr key' }).click();
  await expect(visible(page.locator('ol.words li'))).toHaveCount(0);
  await expect(key).toHaveText(/^nsec1[02-9ac-hj-np-z]{58}$/);
  const nostrHex = await page.locator('[data-test=backup-hex]').textContent();
  expect(nostrPubkey(nostrHex)).toBe(reg['nostr-pubkey']);

  // Lock: the vault and the backup are gone (showing it again asks for the passphrase, in place); the neuron
  // still polls and submits.
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  await expect(visible(page.locator('ol.words li'))).toHaveCount(0);
  await page.getByRole('button', { name: 'Vault words' }).click();
  await expect(page.getByLabel('Vault passphrase to back up')).toBeVisible();
  await page.locator('[data-unlock-for=backup]').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('Vault passphrase to back up')).toBeHidden();
  stub.batch = [entry('u-btc', 'bitcoin', T0 + 3600, '67100.5'), BATCH[1]];
  await go(page, 'streams');
  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect(page.locator('[data-test=last-poll]')).toContainText('2 streams, 1 new, 1 predicted');
  await expect(btc.locator('[data-test=t1]')).toHaveText('67,100.50'); // two observations: naive, the last value
  await expect(btc.locator('[data-test=t2]')).toHaveText('67,100.50');
  await expect(btc.locator('[data-test=model]')).toHaveText('naive · spec +eth'); // its bvar spec waits for aligned history
  expect(stub.batches).toHaveLength(2);
  await go(page, 'home');
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting');

  expect(stub.prod).toEqual([]);
  expect(await page.evaluate(() => window.violations)).toEqual([]);

  // What is stored: this app's record, the vault sealed (PBKDF2-SHA256 600,000, AES-256-GCM), nothing of Docker's.
  await page.goto('/e2e/store/'); // the app's tab is gone: its database can be read
  const { value: keys } = await page.evaluate(() => window.probe({ cmd: 'app-meta', key: 'keys' }));
  expect(keys).toMatchObject({ v: 1, identity: Buffer.from(idSecret).toString('hex'), nostr: nostrHex,
    vault: { pubkey: vaultPub, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 }, cipher: { name: 'AES-GCM' } } });
  expect(Object.keys(keys.vault).sort()).toEqual(['cipher', 'data', 'kdf', 'pubkey']);
});

test('agent API: poll, dedupe, a kept queue resent, the central URL setting', async ({ context, page }) => {
  const stub = await stubCentral(context);
  const elsewhere = await stubCentral(context, 'https://central.test');
  const v = fx.vectors[2];
  stub.vaults[v.pubkey] = v.ethAddress; // central pays this vault: its vault_base_address
  await openApp(page);
  await expect(page.getByRole('button', { name: 'Create a new neuron' })).toBeVisible();
  await expect(page.evaluate(() => window.satori.poll())).rejects.toThrow(/Set up first/);
  const s0 = await page.evaluate((w) => {
    const { setup } = window.satori; // destructured: no `this`
    return setup({ passphrase: 'pass phrase', vaultWords: w });
  }, v.words);
  expect(s0).toMatchObject({ screen: 'home', vault: v.ethAddress, unlocked: false });
  expect(s0.identity).toMatch(ADDRESS);
  expect(s0.central).toMatchObject({ url: CENTRAL });
  await expect.poll(async () => (await status(page)).central.registration?.ok).toBe(true);
  const registration = (await status(page)).central.registration;
  expect(registration).toMatchObject({ peer_id: 7, vault: v.ethAddress, vault_base_address: v.ethAddress, vaultMismatch: false });
  expect(registration).not.toHaveProperty('vault_address'); // central's other address forms are not passed on
  expect(registration).not.toHaveProperty('wallet_address');
  await expect(page.evaluate(() => window.satori.setup({ passphrase: 'short' }))).rejects.toThrow(/already set up/i);

  const poll = () => page.evaluate(() => window.satori.poll());
  const first = await polled(page); // at once after register
  expect(first.lastPoll).toMatchObject({ streams: 2, new: 2, predicted: 2 });
  expect(first.lastSubmit).toMatchObject({ total_submitted: 2, successful: 2 });
  // The same batch again: nothing new, nothing sent.
  expect(await poll()).toMatchObject({ poll: { streams: 2, new: 0, predicted: 0 }, submit: null });
  expect(stub.batches).toHaveLength(1);

  // A new bitcoin row; central fails the batch: the prediction is kept.
  stub.batch = [entry('u-btc', 'bitcoin', T0 + 60, '67001.5'), BATCH[1]];
  stub.fail.push(500, 500); // a 5xx is resent once
  const r3 = await poll();
  expect(r3.poll).toMatchObject({ new: 1, predicted: 1 });
  expect(r3.submit.error).toBe('Satori Network 500: boom');
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
    if (k === 0) await expect(row(page, 'bitcoin').locator('[data-test=model]')).toHaveText('naive · spec +eth');
  }
  const [bar1] = await page.evaluate(() => window.satori.predictions('bitcoin', 1));
  const history = [[T0, 67000.5], [T0 + 60, 67001.5], ...ZIG.map((v, k) => [T0 + (k + 1) * STEP_S, v])];
  const expected = forecast(history.map(([ts, value]) => ({ ts, value })));
  expect(bar1).toMatchObject({ model: 'bar1', t1: expected.t1, t2: expected.t2, phi: expected.phi, weight: expected.weight });
  expect(bar1.t2).not.toBe(67400.5);
  expect(stub.batches.at(-1)).toEqual([expect.objectContaining({ value: String(expected.t2), t1_value: String(expected.t1) })]);
  await expect(row(page, 'bitcoin').locator('[data-test=model]')).toHaveText('bar1 · spec +eth'); // eth has one row: bar1
  await expect(row(page, 'bitcoin').locator('[data-test=model]')).toHaveAttribute('title', /^Bayesian AR\(1\) on 12 h returns · φ /);

  // The central URL: https only; a new one registers at once. Its uuids differ, so the
  // pending queue and the stream list are dropped and refill from it.
  stub.batch = [entry('u-btc', 'bitcoin', T0 + (ZIG.length + 1) * STEP_S, '67005.5'), BATCH[1]]; // newer than its latest: predicted
  stub.fail.push(500, 500);
  expect((await poll()).submit.error).toBe('Satori Network 500: boom');
  await expect(page.evaluate(() => window.satori.setCentral('http://central.test'))).rejects.toThrow(/https:\/\//);
  expect((await status(page)).central.pending).toBe(1); // a refused URL changes nothing
  elsewhere.batch = [{ ...entry('u-btc-2', 'bitcoin', T0 + 120, '67005.5'), stream: { uuid: 'u-btc-2', name: 'bitcoin', meta: '{"unit":"USD"}' } }];
  elsewhere.noVaultBase = true; // a central without vault_base_address (prod, on main): unknown, no mismatch
  const c = await page.evaluate(() => window.satori.setCentral('https://central.test/'));
  expect(c).toMatchObject({ url: 'https://central.test', registration: { ok: true, peer_id: 7, vault: v.ethAddress, vault_base_address: null,
    vaultMismatch: null }, pending: 0, lastPoll: null, lastSubmit: null });
  expect((await page.evaluate(() => window.satori.health())).reasons.map((r) => r.id)).not.toContain('vault-mismatch');
  await expect(page.locator('[data-test=mismatch]')).toHaveText('');
  expect(elsewhere.registered).toHaveLength(1);
  await expect(page.locator('[data-test=central-url]')).toHaveText('https://central.test');
  expect(await page.evaluate(() => window.satori.streams())).toEqual([]);
  await expect(page.locator('[data-test=stream]')).toHaveCount(0);
  expect((await poll()).submit).toMatchObject({ successful: 1 });
  expect(elsewhere.batches).toEqual([[expect.objectContaining({ stream_uuid: 'u-btc-2' })]]);
  expect(await page.evaluate(() => window.satori.streams())).toMatchObject([{ uuid: 'u-btc-2', meta: { unit: 'USD' } }]);
  expect((await page.evaluate(() => window.satori.setCentral(''))).url).toBe(CENTRAL);
  expect(await page.evaluate(() => window.satori.streams())).toEqual([]);

  // A poll still running when the URL changes: its rows land before the reset, never after it.
  stub.batch = [entry('u-late', 'late', T0 + 180, '1.5')];
  stub.delayMs = 1500;
  await page.evaluate(() => void window.satori.poll());
  await expect.poll(async () => (await status(page)).central.polling).toBe(true);
  await page.evaluate(() => window.satori.setCentral('https://central.test'));
  await expect.poll(async () => (await status(page)).central.polling).toBe(false);
  stub.delayMs = 0;
  expect(await page.evaluate(() => window.satori.streams())).toEqual([]);
  expect((await status(page)).central).toMatchObject({ url: 'https://central.test', pending: 0, lastPoll: null });
  await page.evaluate(() => window.satori.setCentral(''));

  // The keys: Unlock, then backup() of one key or all three; file() is gone (no Docker files are made).
  await expect(page.evaluate(() => window.satori.backup('vault'))).rejects.toThrow(/Unlock the vault first/);
  await expect(page.evaluate(() => window.satori.unlock('nope'))).rejects.toThrow(/Wrong passphrase/);
  // One Unlock at a time, as the UI's: a second while one runs is refused.
  const unlocks = await page.evaluate(() => Promise.allSettled([window.satori.unlock('pass phrase'), window.satori.unlock('pass phrase')])
    .then((all) => all.map((r) => (r.status === 'fulfilled' ? r.value : r.reason.message))));
  expect(unlocks).toEqual([true, 'Busy (unlock). Try again when it is done.']);
  expect(await page.evaluate(() => window.satori.backup('vault'))).toEqual({ words: v.words, privateKey: `0x${v.entropyHex}` });
  const all = await page.evaluate(() => window.satori.backup());
  expect(Object.keys(all)).toEqual(['identity', 'vault', 'nostr']);
  expect(evmAddress(publicKey(hex(all.identity.privateKey.slice(2))))).toBe(s0.identity);
  expect(all.nostr).toEqual({ nsec: expect.stringMatching(/^nsec1/), secret: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(nostrPubkey(all.nostr.secret)).toBe((await status(page)).nostr.pubkey);
  expect(await page.evaluate(() => typeof window.satori.file)).toBe('undefined');
  for (const which of ['Vault', 'vaults', '', null, 'wallet.yaml']) {
    await expect(page.evaluate((w) => window.satori.backup(w), which)).rejects.toThrow(/'identity', 'vault' or 'nostr'/);
  }
  await page.evaluate(() => window.satori.lock());
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  expect(stub.prod).toEqual([]);
});

test('central with history: the first poll backfills each stream and forecasts it with bvar (its spec from the identity)', async ({ context, page }) => {
  const stub = await stubAt(context);
  const names = ['bitcoin', 'eth', 'gold'];
  const at = T0 - 3600; // the poll's rows; history ends an hour before
  const price = (i, k) => 100 * (i + 1) * (1 + 0.02 * Math.sin(k / (3 + i)) + 0.0002 * k);
  stub.history = Object.fromEntries(names.map((n, i) => [`u-${n}`,
    Array.from({ length: 600 }, (_, k) => ({ id: k, stream_uuid: `u-${n}`, observed_at: `${at - (600 - k) * 3600}.25`, value: String(price(i, k)),
      ts: '' }))]));
  stub.batch = names.map((n, i) => entry(`u-${n}`, n, at, String(price(i, 600))));
  await openApp(page);
  await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
  const { lastPoll } = await polled(page); // at once after register
  expect(stub.polls).toEqual([1]);
  expect(lastPoll).toMatchObject({ streams: 3, new: 3, predicted: 3, engine_ms: expect.any(Number) });
  expect(stub.historyCalls.map((q) => [q.stream_uuid, q.limit])).toEqual(names.map((n) => [`u-${n}`, '1000']));
  const models = await page.evaluate(() => window.satori.models());
  expect(models.map((m) => [m.name, m.model])).toEqual(names.map((n) => [n, 'bvar']));
  // node, from the same history and the identity's pubkey (the specs' seed), makes the same specs and numbers
  const seed = stub.registered[0]['wallet-pubkey'];
  const histories = new Map(names.map((n, i) => [`u-${n}`, [...stub.history[`u-${n}`].map((o) => ({ ts: Math.floor(Number(o.observed_at)), value: Number(o.value) })),
    { ts: at, value: price(i, 600) }]]));
  const out = runModels({ fresh: names.map((n) => `u-${n}`), histories, seed });
  for (const m of models) {
    const want = out.specs.get(m.uuid);
    expect(m.spec).toEqual({ ...want.spec, companions: want.spec.companions.map((u) => ({ uuid: u, name: u.slice(2) })) });
    expect([m.score, m.generation, m.accepted]).toEqual([want.score, want.generation, want.accepted]);
    const [p] = await page.evaluate((u) => window.satori.predictions(u, 1), m.uuid);
    const f = out.forecasts.get(m.uuid);
    expect(p).toMatchObject({ model: 'bvar', t1: f.t1, t2: f.t2, phi: f.phi, weight: f.weight });
  }
  expect(stub.batches[0].map((x) => x.value)).toEqual(models.map((m) => String(out.forecasts.get(m.uuid).t2)));
  await go(page, 'streams');
  const gold = row(page, 'gold').locator('[data-test=model]');
  const spec = models.find((m) => m.name === 'gold').spec;
  await expect(gold).toHaveText(`bvar · ${spec.companions.map((c) => `+${c.name}`).join(' ')}`);
  await expect(gold).toHaveAttribute('title', new RegExp(`^Bayesian VAR\\(1\\) on 12 h steps of this stream with .* · λ1 ${spec.lambda1} · λ2 ${spec.lambda2} · .*generation`));
  await expect(page.locator('[data-test=history]')).toContainText('3 streams, 1,800 rows');
  // a stream's detail: its model in words and its latest prediction
  await row(page, 'gold').locator('.sname').click();
  await expect(page.locator('[data-test=stream-detail]')).toContainText('Bayesian VAR(1)');
  await expect(page.locator('[data-test=stream-prediction]')).toHaveCount(1);
  expect(stub.prod).toEqual([]);
});

test("import Dockerized Neuron files; central pays this vault's rewards to another Base address: a mismatch shows both; Settings", async ({ context, page }) => {
  const stub = await stubCentral(context);
  stub.otherVault = fx.vectors[3].ethAddress; // central pays this vault's rewards to another Base address
  const wallet = fx.vectors[0];
  const vault = fx.vectors[fx.vaults.current.vector];
  const file = (name, text) => ({ name, mimeType: 'application/x-yaml', buffer: Buffer.from(text) });

  await openApp(page);
  await page.getByRole('button', { name: 'Import Dockerized Neuron files' }).click();
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
  // the same Base addresses as the Docker neuron's (satorilib's ethAddress)
  await expect(page.locator('[data-test=identity]')).toHaveText(wallet.ethAddress, { timeout: 30_000 });
  await expect(page.locator('[data-test=vault]')).toHaveText(vault.ethAddress);

  // Registered with Docker's keys; central pays this vault's rewards to another Base address.
  await expect(page.locator('[data-test=registered]')).toHaveText('Yes · peer 7');
  expect(stub.registered[0]).toMatchObject({ 'wallet-pubkey': wallet.pubkey, 'vault-pubkey': vault.pubkey });
  await expect(page.locator('[data-test=mismatch]')).toHaveText(
    `Vault mismatch: the Satori Network pays this vault's rewards to a different Base address, ${stub.otherVault}, not this vault's ${vault.ethAddress}.`);
  expect((await page.evaluate(() => window.satori.health())).action).toMatchObject({ id: 'vault-mismatch',
    text: expect.stringContaining(`a different Base address, ${stub.otherVault}, not this vault's ${vault.ethAddress}.`) });

  // Settings: https only; an unreachable central is shown, not thrown.
  await go(page, 'settings');
  const url = page.getByLabel('Satori Network server');
  await url.fill('http://central.test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'https://' })).toBeVisible();
  await context.route('https://down.test/**', (route) => route.abort());
  await url.fill('https://down.test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('[data-test=central-url]')).toHaveText('https://down.test');
  await expect(page.locator('[data-test=registered]')).toHaveText(/^No: Satori Network unreachable: /);
  await go(page, 'streams');
  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect(page.locator('[data-test=last-poll]')).toContainText('failed: Satori Network unreachable');
  await go(page, 'settings');
  await url.fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('[data-test=central-url]')).toHaveText(CENTRAL);

  // The imported vault unlocks with the Docker password (reused: 8 characters or more) and shows the same words.
  await page.getByLabel('Vault passphrase', { exact: true }).fill(fx.vaults.password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Unlocked');
  await page.getByRole('button', { name: 'Vault words' }).click();
  await expect(visible(page.locator('ol.words li'))).toHaveText(vault.words.split(' '));
});

test('import: a Docker vault password under 8 characters asks for a new passphrase, which then unlocks', async ({ context, page }) => {
  await stubCentral(context);
  // Docker files with the password 'pass' (written in satorilib's format by this app's step-2 code, test/fixtures/profiles.json)
  const p = profiles.find((x) => x.label.startsWith('steps 2-4'));
  const file = (name, text) => ({ name, mimeType: 'application/x-yaml', buffer: Buffer.from(text) });
  await openApp(page);
  await page.getByRole('button', { name: 'Import Dockerized Neuron files' }).click();
  await page.getByLabel('wallet.yaml (identity)').setInputFiles(file('wallet.yaml', p.meta.wallet_yaml));
  await page.getByLabel('vault.yaml').setInputFiles(file('vault.yaml', p.meta.vault_yaml));
  await page.getByLabel('Vault password').fill(p.passphrase);
  await expect(page.getByLabel(/Use it as this app’s passphrase too/)).toBeChecked();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('[data-test=pass-note]')).toHaveText(/vault password is shorter than 8 characters/, { timeout: 30_000 });
  const NEW = 'новый пароль';
  await visible(page.getByLabel('Passphrase', { exact: true })).fill(NEW);
  await page.getByLabel('Repeat passphrase').fill(NEW);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const vaultAddress = evmAddress(publicKey(hex(p.expect.vault)));
  await expect(page.locator('[data-test=vault]')).toHaveText(vaultAddress, { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=identity]')).toHaveText(evmAddress(publicKey(hex(p.expect.identity))));
  await expect.poll(() => page.evaluate(() => document.body.dataset.screen)).toBe('home');
  await expect(page.evaluate((x) => window.satori.unlock(x), p.passphrase)).rejects.toThrow(/Wrong passphrase/);
  expect(await page.evaluate((x) => window.satori.unlock(x), NEW)).toBe(true);
  expect((await page.evaluate(() => window.satori.backup('vault'))).words).toBe(wordsOf(hex(p.expect.vault)));
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
  await page.getByLabel(/^Nostr key \(nsec or hex/).fill('nsec1nope');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Not a Nostr key' })).toBeVisible();
  await page.getByLabel('Vault words (24)').fill(v.words);
  await page.getByLabel(/Identity words/).fill(id.words);
  await page.getByLabel(/^Nostr key \(nsec or hex/).fill(nsec(fx.nostr.secretHex)); // as Backup shows it
  await page.getByRole('button', { name: 'Continue' }).click();
  await visible(page.getByLabel('Passphrase', { exact: true })).fill(PASS);
  await page.getByLabel('Repeat passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-test=vault]')).toHaveText(v.ethAddress, { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=identity]')).toHaveText(id.ethAddress);
  await expect(page.locator('[data-test=nostr-pubkey]')).toHaveText(fx.nostr.pubkeyHex);
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
    window.satori.setup({ passphrase: 'pass phrase' }), window.satori.setup({ passphrase: 'pass phrase' }),
  ]).then((all) => all.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason.message }))));
  const done = results.filter((r) => r.screen === 'home');
  expect(done).toHaveLength(1);
  expect(results.find((r) => r.error)?.error).toMatch(/busy|already set up/i);
  await expect(page.getByRole('button', { name: 'Create a new neuron' })).toBeHidden();

  // What was stored is what the winner reported.
  await reloadApp(page);
  await expect(page.locator('[data-test=identity]')).toHaveText(done[0].identity);
  await expect(page.locator('[data-test=vault]')).toHaveText(done[0].vault);
  await expect(page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }))).rejects.toThrow(/already set up/i);

  await page.goto('/e2e/store/');
  expect(await page.evaluate(() => window.probe({ cmd: 'app-meta', key: 'vault' }))).toEqual({ value: row0 });
});

test('the dev server has no service worker, and removes one left on its origin; status() has storage and app (docs/design/pwa.md)', async ({ context, page }) => {
  await stubCentral(context);
  expect(await openApp(page)).toBe('setup');
  const registrations = () => page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length));
  expect(await registrations()).toBe(0);
  await page.evaluate(() => navigator.serviceWorker.register('/e2e/stale-sw.js'));
  expect(await registrations()).toBe(1);
  await reloadApp(page);
  await expect.poll(registrations).toBe(0);
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBe(null);

  const s = await status(page);
  expect(s.app).toEqual({ installed: false, canInstall: false, update: false }); // no install prompt in a Playwright context
  expect(s.storage).toEqual({ persisted: expect.any(Boolean), usage: expect.any(Number), quota: expect.any(Number) });
  expect(await page.evaluate(() => window.satori.install())).toBe('unavailable');
  expect(await page.evaluate(() => window.satori.update())).toBe(false);
});

test('Settings → Appearance: System, Light, Dark; kept on this device over a reload, set before the first paint; setTheme()', async ({ context, page }) => {
  await stubCentral(context);
  // what <html data-theme> is when the parser makes <body>: before the first paint, before the app's modules run
  await context.addInitScript(() => {
    new MutationObserver((_, o) => {
      if (!document.body) return;
      window.themeAtBody = document.documentElement.dataset.theme ?? null;
      o.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  const LIGHT = 'rgb(246, 247, 249)';
  const DARK = 'rgb(18, 21, 27)';
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  await openApp(page);
  await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
  expect(await bg()).toBe(LIGHT);
  await go(page, 'settings');
  const button = (name) => page.locator('#settings-appearance').getByRole('button', { name, exact: true });
  await expect(button('System')).toHaveAttribute('aria-pressed', 'true');
  await button('Dark').click();
  await expect.poll(bg).toBe(DARK);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(button('Dark')).toHaveAttribute('aria-pressed', 'true');
  await expect(button('System')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('meta[name=theme-color][content="#12151b"]')).toHaveAttribute('media', 'all'); // the browser's bar

  // A reload: dark from the first paint on a light system, and still chosen.
  await reloadApp(page);
  expect(await page.evaluate(() => window.themeAtBody)).toBe('dark');
  expect(await bg()).toBe(DARK);
  await expect(button('Dark')).toHaveAttribute('aria-pressed', 'true');

  // Light on a dark system; then System follows the system. The API does the same; anything else is refused.
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await page.evaluate(() => window.satori.setTheme('light'))).toBe('light');
  await expect.poll(bg).toBe(LIGHT);
  await expect(button('Light')).toHaveAttribute('aria-pressed', 'true');
  await button('System').click();
  await expect.poll(bg).toBe(DARK);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await reloadApp(page);
  expect(await page.evaluate(() => window.themeAtBody)).toBe(null);
  expect(await bg()).toBe(DARK);
  await expect(page.evaluate(() => window.satori.setTheme('blue'))).rejects.toThrow(/'system', 'light' or 'dark'/);
});
