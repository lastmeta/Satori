// An earlier version's profile in Chrome, on OPFS (test/fixtures/profiles.json:
// the meta rows each version stored, made by its own code): the load's
// migration 7 translates the alias and the Nostr key into this app's
// record; the wallet is re-encrypted at its next Unlock; nothing is lost
// (docs/design/keys.md#migration).
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { verifyMessage } from 'viem';
import { MIGRATIONS } from '../src/db/schema.js';
import { publicKey, evmAddress, wordsOf } from '../src/keys/keys.js';
import { nostrPubkey } from '../src/nostr/event.js';
import { openApp, reloadApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const { profiles } = JSON.parse(readFileSync(new URL('../test/fixtures/profiles.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const sqlText = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'`;
const probe = (page, args) => page.evaluate((a) => window.probe(a), args);
const appMeta = async (page, key) => (await probe(page, { cmd: 'app-meta', key })).value;

/** The app's database as the version that made `p` left it: its migrations, its meta rows, checkpointed. */
async function seed(page, p) {
  await page.goto('/e2e/store/');
  const rows = Object.entries({ schema_version: p.schema, ...p.meta }).map(([k, v]) => `('${k}', ${sqlText(v)})`);
  const r = await probe(page, { cmd: 'raw', path: 'opfs://satori-mvp.duckdb', sql: [
    'CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)', ...MIGRATIONS.slice(0, p.schema),
    `INSERT INTO meta VALUES ${rows.join(', ')}`, 'CHECKPOINT'] });
  expect(r, JSON.stringify(r)).toHaveProperty('rows');
}

const ofLabel = (start) => profiles.find((x) => x.label.startsWith(start));
const SHAPES = [
  ofLabel("step 2: the vault's passphrase as UTF-8 bytes (non-Latin-1)"), // schema 1: every migration runs
  ofLabel('step 5 on'), // schema 6, with nostr.yaml
  ofLabel('steps 2-4'), // no nostr.yaml: a Nostr key is made
];

for (const p of SHAPES) {
  test(`${p.label}: the alias and Nostr key at load, the wallet at its next Unlock`, async ({ context, page }) => {
    const stub = await stubCentral(context);
    await seed(page, p);
    const idPub = publicKey(hex(p.expect.alias));
    const walletPub = publicKey(hex(p.expect.wallet));
    expect(await openApp(page)).toBe('home');
    await expect(page.locator('[data-test=alias]')).toHaveText(evmAddress(idPub));
    await expect(page.locator('[data-test=wallet]')).toHaveText(evmAddress(walletPub)); // while locked: its public key in clear
    await expect.poll(() => stub.registered.length).toBe(1);
    expect(stub.registered[0]).toMatchObject({ 'alias-pubkey': idPub });
    expect(stub.registered[0]['wallet-link']).toBeUndefined(); // no link before the wallet's next Unlock
    const nostrPub = (await page.evaluate(() => window.satori.status())).nostr.pubkey;
    if (p.expect.nostr) expect(nostrPub).toBe(nostrPubkey(p.expect.nostr));

    // The record before Unlock: the wallet still in the old version's text; the old rows are gone.
    await page.goto('/e2e/store/');
    const before = await appMeta(page, 'keys');
    expect(before).toMatchObject({ v: 1, alias: p.expect.alias, wallet: { pubkey: walletPub, yaml: p.meta.vault_yaml } });
    for (const k of ['wallet_yaml', 'vault_yaml', 'nostr_yaml']) expect(await appMeta(page, k), k).toBeUndefined();

    // Unlock (Settings): a wrong passphrase changes nothing; the right one opens it and stores it in this app's format.
    expect(await openApp(page, '/#settings')).toBe('home');
    const pass = page.getByLabel('Wallet passphrase', { exact: true });
    await pass.fill('not the passphrase');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Wrong passphrase' })).toBeVisible({ timeout: 30_000 });
    await pass.fill(p.passphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.locator('[data-test=wallet-state]')).toHaveText('Unlocked', { timeout: 30_000 });
    expect((await page.evaluate((x) => window.satori.backup('wallet', x), p.passphrase)).words).toBe(wordsOf(hex(p.expect.wallet)));
    // that Unlock made the wallet's link and registered with it at once
    await expect.poll(() => stub.registered.at(-1)['wallet-link'] ?? null).not.toBeNull();
    const link = Buffer.from(stub.registered.at(-1)['wallet-link'], 'base64').toString('utf8');
    expect(link).toContain(`alias: ${evmAddress(idPub)}\nwallet: ${evmAddress(walletPub)}\n`);
    expect(await verifyMessage({ address: evmAddress(walletPub), message: link, signature: stub.registered.at(-1)['wallet-signature'] })).toBe(true);

    await page.goto('/e2e/store/');
    const after = await appMeta(page, 'keys');
    expect(after).toEqual({ ...before, wallet: { pubkey: walletPub, kdf: expect.objectContaining({ iterations: 600_000 }),
      cipher: expect.objectContaining({ name: 'AES-GCM' }), data: expect.any(String) },
      link: { message: link, signature: expect.stringMatching(/^0x[0-9a-f]{130}$/) } });

    // From now on it opens in the new format, with the same passphrase; the same keys.
    expect(await openApp(page)).toBe('home');
    await expect(page.locator('[data-test=alias]')).toHaveText(evmAddress(idPub));
    expect(await page.evaluate((x) => window.satori.unlock(x), p.passphrase)).toBe(true);
    const b = await page.evaluate((x) => window.satori.backup(undefined, x), p.passphrase);
    expect([b.alias.words, b.wallet.words]).toEqual([wordsOf(hex(p.expect.alias)), wordsOf(hex(p.expect.wallet))]);
    expect(nostrPubkey(b.nostr.secret)).toBe(nostrPub);
  });
}

test("an imported vault.yaml with no plain public key: Unlock once to finish the update, then the neuron starts", async ({ context, page }) => {
  await stubCentral(context);
  const p = ofLabel('Docker import before ecf3ae0');
  await seed(page, p);
  expect(await openApp(page)).toBe('finish');
  await expect(page.getByText('Unlock to finish the update')).toBeVisible();
  const pass = page.getByLabel('Wallet passphrase to finish the update');
  await pass.fill('not the passphrase');
  await page.locator('[data-test=finish]').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Wrong passphrase' })).toBeVisible({ timeout: 30_000 });
  await pass.fill(p.passphrase);
  await page.locator('[data-test=finish]').click();
  await expect(page.locator('[data-test=wallet]')).toHaveText(evmAddress(publicKey(hex(p.expect.wallet))), { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=wallet-state]')).toHaveText('Unlocked');
  expect(await reloadApp(page)).toBe('home'); // stored with its public key now
  await expect(page.locator('[data-test=wallet-state]')).toHaveText('Locked');
});

test("the step-1 prototype's key: Setup, and its row is left as it is", async ({ context, page }) => {
  await stubCentral(context);
  const p = ofLabel('step 1 prototype');
  await seed(page, p);
  expect(await openApp(page)).toBe('setup');
  await page.goto('/e2e/store/');
  expect(await appMeta(page, 'wallet')).toEqual(p.meta.wallet);
  expect(await appMeta(page, 'keys')).toBeUndefined();
});
