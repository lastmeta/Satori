// The app in Chrome: create (identity + vault) → ticks on the identity →
// reload runs with no passphrase → Unlock/Lock the vault → backup words and
// Docker files; Docker import; words restore; the agent API. Sources are stubbed.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { verifyMessage } from '../src/keys/index.js';
import { readWallet } from '../src/keys/docker.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/identity-parity.json', import.meta.url)));
const PASS = 'correct horse battery';
const ADDRESS = /^E[1-9A-HJ-NP-Za-km-z]{33}$/;

async function stubCoinbase(context) {
  const stub = { calls: 0, price: 100_000 };
  await context.route('https://api.coinbase.com/**', (route) => {
    stub.calls++;
    stub.price += 10;
    route.fulfill({ json: { data: { amount: stub.price.toFixed(2), base: 'BTC', currency: 'USD' } },
      headers: { 'access-control-allow-origin': '*' } });
  });
  return stub;
}

const visible = (loc) => loc.filter({ visible: true });

test('create, tick on the identity, reload without a passphrase, unlock, backup, lock, one tab', async ({ context, page }) => {
  const stub = await stubCoinbase(context);
  await context.addInitScript(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });

  // Setup: create, the vault's words, confirm three, passphrase.
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a new neuron' }).click();
  const words = await visible(page.locator('ol.words li')).allTextContents();
  expect(words).toHaveLength(24);
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

  // Home: two addresses, the vault locked; the default stream ticks, signed by the identity.
  const idAddr = page.locator('[data-test=identity]');
  const vaultAddr = page.locator('[data-test=vault]');
  await expect(idAddr).toHaveText(ADDRESS);
  await expect(vaultAddr).toHaveText(ADDRESS);
  const identity = await idAddr.textContent();
  const vault = await vaultAddr.textContent();
  expect(identity).not.toBe(vault);
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  await expect(page.getByText('1 obs · 1 predictions')).toBeVisible();
  const message = await page.locator('[data-test=message]').textContent();
  const signature = await page.locator('[data-test=signature]').textContent();
  expect(JSON.parse(message)).toMatchObject({ stream: 'BTC-USD', value: 100010, model: 'ols-20', address: identity });
  expect(verifyMessage(message, signature, { address: identity })).toBe(true);
  await page.getByText('Backup').click();
  await expect(page.getByText('Unlock the vault to back up your keys.')).toBeVisible();

  // Second tab: told to use the first one.
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('Satori is open in another tab')).toBeVisible();
  await other.close();

  // Reload: running at once with no passphrase; the vault is locked again.
  await page.reload();
  await expect(idAddr).toHaveText(identity);
  await expect(vaultAddr).toHaveText(vault);
  await expect(page.getByText('2 obs · 2 predictions')).toBeVisible();
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
  expect(walletFile.keys.words).toBe(idWords.join(' '));
  const vaultText = await download('vault.yaml');
  await expect(readWallet(vaultText)).rejects.toThrow(/encrypted/);
  const vaultFile = await readWallet(vaultText, { password: PASS });
  expect(vaultFile.keys.address).toBe(vault);
  expect(vaultFile.mismatches).toEqual([]);

  // Lock: the vault and the backup are gone; the neuron keeps ticking.
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
  await expect(visible(page.locator('ol.words li'))).toHaveCount(0);
  await expect(page.getByText('Unlock the vault to back up your keys.')).toBeVisible();
  const before = stub.calls;
  await page.evaluate(() => window.satori.removeStream('BTC-USD'));
  await page.evaluate(() => window.satori.addStream({
    name: 'BTC-USD', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', path: 'data.amount', interval_s: 10 }));
  await expect.poll(() => stub.calls, { timeout: 15_000 }).toBeGreaterThan(before + 1); // ticks while locked

  expect(await page.evaluate(() => window.violations)).toEqual([]);
});

test('import Docker files; a failing source does not stop other streams', async ({ context, page }) => {
  await context.route('https://api.coinbase.com/**', (route) => route.fulfill({ status: 503, body: 'down',
    headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://example.test/**', (route) => route.fulfill({ json: { v: 7 },
    headers: { 'access-control-allow-origin': '*' } }));
  const wallet = fx.vectors[0];
  const vault = fx.vectors[fx.vaults.current.vector];
  const file = (name, text) => ({ name, mimeType: 'application/x-yaml', buffer: Buffer.from(text) });

  await page.goto('/');
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
  await expect(page.getByText(/Last error .*HTTP 503 from source/)).toBeVisible();

  await page.getByText('Add a stream').click();
  await page.getByLabel('Name').fill('SEVEN');
  await page.getByLabel(/Source URL/).fill('https://example.test/seven');
  await page.getByLabel('Path to the number').fill('v');
  await page.getByLabel(/Every/).fill('10');
  await page.getByRole('button', { name: 'Add stream' }).click();
  const seven = page.locator('article.stream').filter({ hasText: 'SEVEN' });
  await expect(seven.locator('[data-test=obs]')).toHaveText('7');
  await expect(seven.getByText(/Last error/)).toBeHidden();

  // The imported vault unlocks with the Docker password and shows the same words.
  await page.getByLabel('Vault passphrase').fill(fx.vaults.password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByText('Backup').click();
  await page.getByRole('button', { name: 'Vault words' }).click();
  await expect(visible(page.locator('ol.words li'))).toHaveText(vault.words.split(' '));
});

test('restore from words', async ({ context, page }) => {
  await stubCoinbase(context);
  const [v, id] = [fx.vectors[0], fx.vectors[3]];
  await page.goto('/');
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
  await expect(page.locator('[data-test=vault]')).toHaveText(v.address);
  await expect(page.locator('[data-test=identity]')).toHaveText(id.address);
});

test('agent API: window.satori drives the same app', async ({ context, page }) => {
  await stubCoinbase(context);
  const v = fx.vectors[2];
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a new neuron' })).toBeVisible();
  const status = await page.evaluate((w) => window.satori.setup({ passphrase: 'pass', vaultWords: w }), v.words);
  expect(status).toMatchObject({ screen: 'home', vault: v.address, unlocked: false });
  expect(status.identity).toMatch(ADDRESS);
  await expect(page.locator('[data-test=vault]')).toHaveText(v.address);
  await expect.poll(() => page.evaluate(() => window.satori.predictions('BTC-USD').then((p) => p.length))).toBe(1);
  const [p] = await page.evaluate(() => window.satori.predictions('BTC-USD'));
  expect(await page.evaluate((x) => window.satori.verify(x.message, x.signature, x.address), p)).toBe(true);
  await expect(page.evaluate(() => window.satori.backup('vault'))).rejects.toThrow(/Unlock the vault first/);
  await expect(page.evaluate(() => window.satori.unlock('nope'))).rejects.toThrow(/Wrong passphrase/);
  await page.evaluate(() => window.satori.unlock('pass'));
  expect(await page.evaluate(() => window.satori.backup('vault'))).toEqual({ words: v.words, wif: v.wif });
  expect(await page.evaluate(() => window.satori.file('vault.yaml'))).toContain(`address: ${v.address}`);
  await page.evaluate(() => window.satori.lock());
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Locked');
});
