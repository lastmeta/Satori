// The whole MVP in Chrome: create → tick → reload → unlock → data persisted →
// Lock wipes; a second tab is told the app is open elsewhere. Coinbase is stubbed.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { verifyMessage } from '../src/keys/index.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/identity-parity.json', import.meta.url)));

const PASS = 'correct horse battery';

test('create, tick, persist, unlock, lock, one tab', async ({ context, page }) => {
  let price = 100_000;
  let calls = 0;
  await context.route('https://api.coinbase.com/**', (route) => {
    calls++;
    price += 10;
    route.fulfill({ json: { data: { amount: price.toFixed(2), base: 'BTC', currency: 'USD' } },
      headers: { 'access-control-allow-origin': '*' } });
  });
  await context.addInitScript(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const visible = (loc) => loc.filter({ visible: true });
  const passphrase = () => visible(page.getByLabel('Passphrase', { exact: true }));

  // Setup: create, show words, confirm three of them, passphrase.
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a new key' }).click();
  const words = await page.locator('ol.words li').allTextContents();
  expect(words).toHaveLength(24);
  await page.getByRole('button', { name: 'I wrote them down' }).click();
  for (const label of await visible(page.getByLabel(/^Word #\d+/)).all()) {
    const n = Number((await label.evaluate((el) => el.closest('label').textContent)).match(/#(\d+)/)[1]);
    await label.fill(words[n - 1]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await passphrase().fill(PASS);
  await page.getByLabel('Repeat passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Save and unlock' }).click();

  // Home: the default stream ticks right away.
  const address = page.locator('[data-test=address]');
  await expect(address).toHaveText(/^E[1-9A-HJ-NP-Za-km-z]{33}$/);
  const addr = await address.textContent();
  await expect(page.getByText('1 obs · 1 predictions')).toBeVisible();
  await expect(page.locator('[data-test=obs]')).toHaveText('100,010.00');
  const message = await page.locator('[data-test=message]').textContent();
  const signature = await page.locator('[data-test=signature]').textContent();
  expect(JSON.parse(message)).toMatchObject({ stream: 'BTC-USD', value: 100010, model: 'ols-20', address: addr });
  expect(verifyMessage(message, signature, { address: addr })).toBe(true);
  await expect(page.getByText('published')).toBeVisible();

  // Second tab: told to use the first one.
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('Satori is open in another tab')).toBeVisible();
  await other.close();

  // Reload: locked; wrong passphrase refused; unlock → persisted + a new tick.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
  await passphrase().fill('wrong passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Wrong passphrase' })).toBeVisible();
  await passphrase().fill(PASS);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(address).toHaveText(addr);
  await expect(page.getByText('2 obs · 2 predictions')).toBeVisible();
  await expect(page.locator('[data-test=obs]')).toHaveText('100,020.00');
  // OLS on time: the line through both observations, evaluated at target_ts.
  const m1 = JSON.parse(message);
  const m2 = JSON.parse(await page.locator('[data-test=message]').textContent());
  expect(m2.target_ts - m2.ts).toBe(60_000);
  expect(m2.value).toBeCloseTo(100_020 + (10 * (m2.target_ts - m2.ts)) / (m2.ts - m1.ts), 6);

  // Backup words need the passphrase again.
  await page.getByText('Backup words').click();
  await passphrase().fill(PASS);
  await page.getByRole('button', { name: 'Show words' }).click();
  await expect(visible(page.locator('ol.words li'))).toHaveText(words);
  await page.getByRole('button', { name: 'Hide' }).click();

  // Lock: back to Unlock, nothing of the session on screen, no more ticks.
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
  await expect(address).toHaveText('');
  await expect(page.locator('ol.words li')).toHaveCount(0);
  await expect(page.locator('article.stream')).toHaveCount(0);
  const after = calls;
  await page.waitForTimeout(1500);
  expect(calls).toBe(after);

  expect(await page.evaluate(() => window.violations)).toEqual([]);
});

test('a failing source shows its error and does not stop other streams', async ({ context, page }) => {
  await context.route('https://api.coinbase.com/**', (route) => route.fulfill({ status: 503, body: 'down',
    headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://example.test/**', (route) => route.fulfill({ json: { v: 7 },
    headers: { 'access-control-allow-origin': '*' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'I have 24 words' }).click();
  await page.getByLabel('Words').fill('abandon '.repeat(23) + 'art'); // valid words, but key 0
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not 24 valid backup words' })).toBeVisible();
  await page.getByLabel('Words').fill(fx.vectors[0].words);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Passphrase', { exact: true }).filter({ visible: true }).fill(PASS);
  await page.getByLabel('Repeat passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Save and unlock' }).click();
  await expect(page.locator('[data-test=address]')).toHaveText(fx.vectors[0].address);
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
});
