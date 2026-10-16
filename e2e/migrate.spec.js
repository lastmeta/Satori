// An earlier version's profile in Chrome, on OPFS (test/fixtures/profiles.json:
// the meta rows each version stored, made by its own code): the load's
// migration 7 translates the identity and the Nostr key into this app's
// record; the vault is re-encrypted at its next Unlock; nothing is lost
// (docs/design/keys.md#migration).
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
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
  test(`${p.label}: the identity and Nostr key at load, the vault at its next Unlock`, async ({ context, page }) => {
    const stub = await stubCentral(context);
    await seed(page, p);
    const idPub = publicKey(hex(p.expect.identity));
    const vaultPub = publicKey(hex(p.expect.vault));
    expect(await openApp(page)).toBe('home');
    await expect(page.locator('[data-test=identity]')).toHaveText(evmAddress(idPub));
    await expect(page.locator('[data-test=vault]')).toHaveText(evmAddress(vaultPub)); // while locked: its public key in clear
    await expect.poll(() => stub.registered.length).toBe(1);
    expect(stub.registered[0]).toMatchObject({ 'wallet-pubkey': idPub, 'vault-pubkey': vaultPub });
    const nostrPub = (await page.evaluate(() => window.satori.status())).nostr.pubkey;
    if (p.expect.nostr) expect(nostrPub).toBe(nostrPubkey(p.expect.nostr));

    // The record before Unlock: the vault still in the old version's text; the old rows are gone.
    await page.goto('/e2e/store/');
    const before = await appMeta(page, 'keys');
    expect(before).toMatchObject({ v: 1, identity: p.expect.identity, vault: { pubkey: vaultPub, yaml: p.meta.vault_yaml } });
    for (const k of ['wallet_yaml', 'vault_yaml', 'nostr_yaml']) expect(await appMeta(page, k), k).toBeUndefined();

    // Unlock: a wrong passphrase changes nothing; the right one opens it and stores it in this app's format.
    expect(await openApp(page)).toBe('home');
    const pass = page.getByLabel('Vault passphrase', { exact: true });
    await pass.fill('not the passphrase');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Wrong passphrase' })).toBeVisible({ timeout: 30_000 });
    await pass.fill(p.passphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.locator('[data-test=vault-state]')).toHaveText('Unlocked', { timeout: 30_000 });
    expect((await page.evaluate(() => window.satori.backup('vault'))).words).toBe(wordsOf(hex(p.expect.vault)));

    await page.goto('/e2e/store/');
    const after = await appMeta(page, 'keys');
    expect(after).toEqual({ ...before, vault: { pubkey: vaultPub, kdf: expect.objectContaining({ iterations: 600_000 }),
      cipher: expect.objectContaining({ name: 'AES-GCM' }), data: expect.any(String) } });

    // From now on it opens in the new format, with the same passphrase; the same keys.
    expect(await openApp(page)).toBe('home');
    await expect(page.locator('[data-test=identity]')).toHaveText(evmAddress(idPub));
    expect(await page.evaluate((x) => window.satori.unlock(x), p.passphrase)).toBe(true);
    const b = await page.evaluate(() => window.satori.backup());
    expect([b.identity.words, b.vault.words]).toEqual([wordsOf(hex(p.expect.identity)), wordsOf(hex(p.expect.vault))]);
    expect(nostrPubkey(b.nostr.secret)).toBe(nostrPub);
  });
}

test("an imported vault.yaml with no plain public key: Unlock once to finish the update, then the neuron starts", async ({ context, page }) => {
  await stubCentral(context);
  const p = ofLabel('Docker import before ecf3ae0');
  await seed(page, p);
  expect(await openApp(page)).toBe('finish');
  await expect(page.getByText('Unlock to finish the update')).toBeVisible();
  const pass = page.getByLabel('Vault passphrase to finish the update');
  await pass.fill('not the passphrase');
  await page.locator('[data-test=finish]').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Wrong passphrase' })).toBeVisible({ timeout: 30_000 });
  await pass.fill(p.passphrase);
  await page.locator('[data-test=finish]').click();
  await expect(page.locator('[data-test=vault]')).toHaveText(evmAddress(publicKey(hex(p.expect.vault))), { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Unlocked');
  expect(await reloadApp(page)).toBe('home'); // stored with its public key now
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
});

test("the step-1 prototype's key: Setup, and its row is left as it is", async ({ context, page }) => {
  await stubCentral(context);
  const p = ofLabel('step 1 prototype');
  await seed(page, p);
  expect(await openApp(page)).toBe('setup');
  await page.goto('/e2e/store/');
  expect(await appMeta(page, 'vault')).toEqual(p.meta.vault);
  expect(await appMeta(page, 'keys')).toBeUndefined();
});
