// Several wallets in one app (docs/design/wallets.md#several-wallets), in Chrome with the stub central: one active at a
// time, a database each. Add opens Setup on an empty database; a wallet already in the app is refused at setup, with a
// way back; Switch reloads with the other wallet; Remove (asked first) deletes a wallet that is not in use, its file too.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loaded, openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/alias-parity.json', import.meta.url)));
const [A, B] = fx.vectors;
const PASS = 'a long test passphrase';
const SHOTS = process.env.SHOTS ? 'docs/screenshots' : null;

const status = (page) => page.evaluate(() => window.satori.status());
const wallets = (page) => page.evaluate(() => window.satori.wallets());
/** `fn` makes the page reload (the switch, Add): wait for the new page to start. → its screen */
async function reloading(page, fn) {
  const next = page.waitForEvent('load', { timeout: LOAD_TIMEOUT });
  await fn();
  await next;
  return loaded(page);
}
const opfsFiles = (page) => page.evaluate(async () => {
  const names = [];
  for await (const [name] of (await navigator.storage.getDirectory()).entries()) names.push(name);
  return names.filter((n) => n.endsWith('.duckdb')).sort();
});
const setupWith = (page, words) => page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, walletWords: w }), [PASS, words]);

test('two wallets: Add, a wallet already in the app refused with a way back, Switch, Remove; each its own database', async ({ context, page }) => {
  test.setTimeout(240_000);
  const stub = await stubCentral(context);
  expect(await openApp(page)).toBe('setup');
  expect((await setupWith(page, A.words)).wallet).toBe(A.ethAddress);
  expect(await wallets(page)).toEqual({ active: 1, wallets: [{ id: 1, address: A.ethAddress, active: true }] }); // no list yet: one wallet

  // Add a wallet (the Wallet tab): Setup on an empty database, the first wallet offered as the way back
  await page.evaluate(() => { location.hash = '#wallet'; });
  await expect(page.locator('[data-test=wallet-row]')).toHaveCount(1);
  expect(await reloading(page, () => page.locator('[data-test=add-wallet]').click())).toBe('setup');
  await expect(page.locator('[data-test=wallet-back]')).toHaveText(`${A.ethAddress.slice(0, 6)}…${A.ethAddress.slice(-4)}`);
  const second = await setupWith(page, B.words);
  expect([second.screen, second.wallet]).toEqual(['home', B.ethAddress]);
  const aliasB = second.alias;
  expect(await wallets(page)).toEqual({ active: 2, wallets: [{ id: 1, address: A.ethAddress, active: false }, { id: 2, address: B.ethAddress, active: true }] });
  expect(await opfsFiles(page)).toEqual(['satori-2.duckdb', 'satori-mvp.duckdb']);
  await expect.poll(() => stub.registered.length).toBe(2); // each wallet registers its own alias
  expect(stub.registered[1]['alias-pubkey']).not.toBe(stub.registered[0]['alias-pubkey']);

  // A wallet already in the app: refused at setup; the way back opens it again
  expect(await reloading(page, () => page.evaluate(() => window.satori.addWallet()))).toBe('setup');
  await expect(setupWith(page, A.words)).rejects.toThrow('This wallet is already in this app');
  expect((await status(page)).screen).toBe('setup');
  await expect(page.locator('[data-test=wallet-back]')).toHaveCount(2);
  expect(await reloading(page, () => page.locator('[data-test=wallet-back]').first().click())).toBe('home');
  expect((await status(page)).wallet).toBe(A.ethAddress);
  expect((await wallets(page)).wallets.map((w) => [w.id, w.address, w.active])).toEqual([[1, A.ethAddress, true], [2, B.ethAddress, false], [3, null, false]]);

  // Switch (the Wallet tab) to the second: its own keys and data again
  await page.evaluate(() => { location.hash = '#wallet'; });
  const rows = page.locator('[data-test=wallet-row]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator('.badge')).toBeVisible();
  await expect(rows.nth(2)).toContainText('Not set up yet');
  if (SHOTS) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-test=wallets]').screenshot({ path: `${SHOTS}/wallets-phone.png` });
    await page.setViewportSize(size);
  }
  expect(await reloading(page, () => rows.nth(1).locator('[data-test=wallet-switch]').click())).toBe('home');
  const b = await status(page);
  expect([b.wallet, b.alias, b.unlocked]).toEqual([B.ethAddress, aliasB, false]);

  // Remove: asked first; Cancel keeps it; the one in use can't be
  await page.evaluate(() => { location.hash = '#wallet'; });
  await rows.nth(0).locator('[data-test=wallet-remove]').click();
  await expect(page.locator('[data-test=wallet-remove-confirm]')).toContainText('its 24 words are the only way back');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('[data-test=wallet-remove-confirm]')).toBeHidden();
  await expect(page.evaluate(() => window.satori.removeWallet(2))).rejects.toThrow(/switch to another first/);
  await rows.nth(0).locator('[data-test=wallet-remove]').click();
  await page.locator('[data-test=wallet-remove-yes]').click();
  await expect(rows).toHaveCount(2);
  expect(await page.evaluate(() => window.satori.removeWallet(3))).toEqual({ active: 2, wallets: [{ id: 2, address: B.ethAddress, active: true }] });
  expect(await opfsFiles(page)).toEqual(['satori-2.duckdb']); // the first wallet's file (and the unfinished one's) gone

  // a reload keeps the second wallet
  await page.reload();
  expect(await loaded(page)).toBe('home');
  expect((await status(page)).wallet).toBe(B.ethAddress);
});
