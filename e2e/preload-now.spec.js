// Stake with the alias out of gas (the owner, 2026-10-30): what to do, not what is wrong, and Preload now, which opens
// the Wallet tab's Preload gas with the form filled in.
import { expect, test } from '@playwright/test';
import { fakeSatori } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

test('Stake with no gas on the alias: "you must preload some gas" and Preload now', async ({ context, page }) => {
  const { rpc } = fakeSatori();
  await stubCentral(context, { rpc });
  await openApp(page);
  await page.evaluate(() => window.satori.setup({ passphrase: 'correct horse battery' }));
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const { wallet, alias } = await page.evaluate(() => window.satori.base());
  rpc.eth[wallet.address.toLowerCase()] = 10n ** 17n; // the wallet has ETH, the alias none
  await page.evaluate(() => window.satori.go('wallet'));
  await page.locator('[data-test=base-stake]').click();
  await expect(page.locator('[data-test=wallet-stake-card] [data-test=base-action-error]')).toHaveText('Before you can stake with this app, you must preload some gas.');
  await page.locator('[data-test=wallet-stake-card] [data-test=preload-now]').click();
  await expect(page.locator('form.send [name=to]')).toHaveValue(alias.address);
  await expect(page.locator('[data-test=preload-now]').first()).toBeHidden();
});
