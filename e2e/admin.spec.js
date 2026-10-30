// The Admin tab (docs/design/admin.md) against test/fake-satori.js behind /rpc: hidden for a wallet that is not the
// admin; for the admin, the capabilities, a game approved, the relayer, the fee, the reporter, an adapter, and handing
// the admin on, after which the tab goes.
import { expect, test } from '@playwright/test';
import { fakeSatori } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const NEW = `0x${'ab'.repeat(20)}`;
const t = (page, id) => page.locator(`[data-test=${id}]`);

test('Admin: only for the admin; capabilities, games, relayer, fee, reporter, an adapter, handing it on', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc } = fakeSatori();
  s.streams[2] = { game: 2, named: false, cadence: 1440, history: [], name: 'btc' };
  page.on('pageerror', (e) => { throw e; });
  await stubCentral(context, { rpc });
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const V = (await page.evaluate(() => window.satori.base())).wallet.address.toLowerCase();

  // not the admin: no tab, and go('admin') refuses
  expect(await page.evaluate(() => window.satori.admin())).toEqual({ shown: false, admin: expect.stringMatching(/^0xa0a0/i) });
  await expect(t(page, 'nav-admin')).toBeHidden();
  const short = `${V.slice(0, 6)}…${V.slice(-4)}`;
  await expect(t(page, 'app-wallet')).toHaveText(new RegExp(`^${short}$`, 'i')); // no name: its short address
  expect(await page.evaluate(() => { try { window.satori.go('admin'); return 'went'; } catch (e) { return e.message; } })).toMatch(/only for the Satori contract's admin/);

  s.admin = V;
  rpc.eth[V] = 10n ** 17n;
  expect(await page.evaluate(() => window.satori.admin())).toMatchObject({ shown: true, registrationFee: '0.001',
    games: [{ gameId: 1, isDefault: true, approved: true }, { gameId: 2, name: 'btc', approved: false }] });
  await expect(t(page, 'nav-admin')).toBeVisible();
  // the admin's wallet named "Admin" by itself; a saved name wins, and clearing it brings "Admin" back
  await expect(t(page, 'app-wallet')).toHaveText('Admin');
  expect((await page.evaluate(() => window.satori.wallets())).wallets[0]).toMatchObject({ name: 'Admin', nameAuto: true });
  await t(page, 'app-wallet').click();
  await expect(page.locator('body')).toHaveAttribute('data-tab', 'wallet');
  await expect(t(page, 'wallet-row-name')).toHaveText('Admin');
  await expect(t(page, 'wallet-name-auto')).toBeVisible();
  await t(page, 'wallet-name').fill('Ops desk');
  await t(page, 'wallet-name-save').click();
  await expect(t(page, 'app-wallet')).toHaveText('Ops desk');
  await expect(t(page, 'wallet-row-name')).toHaveText('Ops desk');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('wallet-name-phone.png'), fullPage: true });
  await page.evaluate(() => window.satori.nameWallet(''));
  await expect(t(page, 'app-wallet')).toHaveText('Admin');
  await page.evaluate(() => window.satori.go('admin'));
  await expect(t(page, 'admin-cap')).toHaveCount(8);
  await page.screenshot({ path: test.info().outputPath('admin-phone.png'), fullPage: true });

  // a capability switched on (bit 6), locked: the passphrase in the card
  const caps = t(page, 'admin-capabilities');
  await caps.locator('[data-test=admin-cap]').nth(6).locator('input').check();
  await t(page, 'admin-caps-save').click();
  await caps.getByLabel('Wallet passphrase to change the capabilities').fill(PASS);
  await caps.getByRole('button', { name: 'Unlock' }).click();
  await expect(caps.locator('[data-test=admin-result]')).toHaveText('Saved: the capabilities are as ticked now.', { timeout: 30_000 });
  expect(s.caps).toBe(0xe3n);

  await page.evaluate((p) => window.satori.unlock(p), PASS);
  // a game approved
  const games = t(page, 'admin-games');
  await games.locator('[data-game="2"]').getByRole('button', { name: 'Approve' }).click();
  await expect(games.locator('[data-test=admin-result]')).toHaveText('"btc" is approved: it can earn now.');
  await expect(games.locator('[data-game="2"] .chip')).toHaveText('Approved');
  await expect(games.locator('[data-game="1"] .chip')).toHaveText('Always approved');

  // the relayer, the fee, the reporter
  await t(page, 'admin-relayer-to').fill(NEW);
  await t(page, 'admin-relayer-save').click();
  await expect(t(page, 'admin-relayer').locator('[data-test=admin-result]')).toHaveText(/^The official relayer is 0xabab…abab now\.$/i);
  await expect(t(page, 'admin-relayer-now')).toHaveText(/^0xabab…abab$/i);
  await t(page, 'admin-fee-to').fill('2.5');
  await t(page, 'admin-fee-save').click();
  await expect(t(page, 'admin-fee-now')).toHaveText('2.5 SATORI');
  expect(s.regFee).toBe(25n * 10n ** 17n);
  await t(page, 'admin-reporter-to').fill(NEW);
  await t(page, 'admin-reporter-save').click();
  await expect(t(page, 'admin-reporter-now')).toHaveText(/^0xabab…abab$/i);
  await t(page, 'admin-reporter-to').fill('');
  await t(page, 'admin-reporter-save').click();
  await expect(t(page, 'admin-reporter-now')).toHaveText('Off');

  // an official game adapter
  const adapter = t(page, 'admin-adapter');
  await adapter.locator('summary').click();
  await t(page, 'admin-adapter-kind').selectOption('game');
  await adapter.getByLabel('Its contract address').fill(NEW);
  await adapter.getByLabel('Its name').fill('Ranges');
  await t(page, 'admin-adapter-save').click();
  await expect(adapter.locator('[data-test=admin-result]')).toHaveText('Registered the game adapter "Ranges".');
  expect(s.adapters).toEqual([{ kind: 'game', impl: NEW, name: 'Ranges' }]);

  // the agent calls do the same
  await page.evaluate(() => window.satori.adminCapabilities([0, 1, 5, 7]));
  expect(s.caps).toBe(0xa3n);
  await page.evaluate(() => window.satori.adminGame(2, false));
  expect(s.approved[2]).toBe(false);
  await page.evaluate((to) => window.satori.adminRelayer(to), '');
  expect(s.relayer).toBe('0x0000000000000000000000000000000000000000');

  // hand it on: typed twice; then the tab goes (Home)
  const hand = t(page, 'admin-transfer');
  await hand.locator('summary').click();
  await hand.getByLabel('New admin').fill(NEW);
  await hand.getByLabel('The same address again').fill(`0x${'ac'.repeat(20)}`);
  await t(page, 'admin-transfer-save').click();
  await expect(hand.locator('[data-test=admin-error]')).toHaveText('The two addresses do not match.');
  await hand.getByLabel('The same address again').fill(NEW);
  await t(page, 'admin-transfer-save').click();
  await expect(page.locator('body')).toHaveAttribute('data-tab', 'home', { timeout: 30_000 });
  expect(s.admin).toBe(NEW);
  await expect(t(page, 'nav-admin')).toBeHidden();
  await expect(t(page, 'app-wallet')).toHaveText(new RegExp(`^${short}$`, 'i')); // no longer the admin: its name goes
});
