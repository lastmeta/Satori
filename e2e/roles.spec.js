// The special keys' tabs (docs/design/roles.md) against test/fake-satori.js behind /rpc: hidden for a wallet holding
// none; for one holding them all but the admin, a tab each, named for the appoint key; the split's share with the
// inline Unlock, the multiplier, a curve dial refused then set, a frozen lever, the vote-lock frozen after asking, the
// publisher job offered (the agent call); then handed away, the tabs go.
import { expect, test } from '@playwright/test';
import { fakeSatori } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const NEW = `0x${'ab'.repeat(20)}`;
const t = (page, id) => page.locator(`[data-test=${id}]`);
const card = (page, role, action) => page.locator(`[data-test=tab-page-${role}] [data-test=role-card][data-action=${action}]`);

test('special keys: a tab each for the holder; their actions; gone when handed away', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc } = fakeSatori();
  page.on('pageerror', (e) => { throw e; });
  await stubCentral(context, { rpc });
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const V = (await page.evaluate(() => window.satori.base())).wallet.address.toLowerCase();

  const none = await page.evaluate(() => window.satori.specialKeys());
  expect(Object.values(none).map((x) => x.held)).toEqual([false, false, false, false, false]);
  for (const id of ['split', 'schedule', 'publisher', 'appoint', 'wiring']) await expect(t(page, `nav-${id}`)).toBeHidden();
  expect(await page.evaluate(() => { try { window.satori.go('wiring'); return 'went'; } catch (e) { return e.message; } })).toMatch(/only for the wallet that holds the wiring key/);

  Object.assign(s, { appoint: V, wiring: V, publisher: V, splitSet: V, scheduleSet: V });
  rpc.eth[V] = 10n ** 17n;
  const all = await page.evaluate(() => window.satori.specialKeys());
  expect(all.split).toMatchObject({ held: true, values: { share: '5000' } });
  for (const id of ['split', 'schedule', 'publisher', 'appoint', 'wiring']) await expect(t(page, `nav-${id}`)).toBeVisible();
  await expect(t(page, 'app-wallet')).toHaveText('Appoint'); // not the admin: named for its strongest key

  // the split's share, locked: the passphrase in the card
  await page.evaluate(() => window.satori.go('split'));
  await expect(page.locator('[data-test=tab-page-split] [data-test=role-fact]').first()).toHaveText('50%');
  const share = card(page, 'split', 'share');
  await share.locator('[data-test=role-input]').fill('40');
  await share.locator('[data-test=role-save]').click();
  await share.getByLabel('Wallet passphrase to change off-chain share').fill(PASS);
  await share.getByRole('button', { name: 'Unlock' }).click();
  await expect(share.locator('[data-test=role-result]')).toHaveText('The off-chain share is 40% from the next round.', { timeout: 30_000 });
  expect(s.share).toBe(4000n);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('split-phone.png'), fullPage: true });

  await page.evaluate((p) => window.satori.unlock(p), PASS);
  // the multiplier
  await page.evaluate(() => window.satori.go('schedule'));
  const ratio = card(page, 'schedule', 'ratio');
  await ratio.locator('[data-test=role-input]').fill('1');
  await ratio.locator('[data-test=role-save]').click();
  await expect(ratio.locator('[data-test=role-result]')).toHaveText('The multiplier is × 1.0 from the next step.');
  expect(s.emission.ratioWad).toBe(10n ** 18n);

  // a curve dial refused as the engine would (r below g); another set
  await page.evaluate(() => window.satori.go('appoint'));
  const bottom = card(page, 'appoint', 'bottom');
  await bottom.locator('summary').click();
  await bottom.locator('[data-test=role-input]').fill('2');
  await bottom.locator('[data-test=role-save]').click();
  await expect(bottom.locator('[data-test=role-error]')).toHaveText("The bottom gradient can't be below the top gradient (3).");
  const top = card(page, 'appoint', 'top');
  await top.locator('summary').click();
  await top.locator('[data-test=role-input]').fill('4');
  await top.locator('[data-test=role-save]').click();
  await expect(top.locator('[data-test=role-now-top]')).toHaveText('4');
  await page.screenshot({ path: test.info().outputPath('appoint-phone.png'), fullPage: true });

  // wiring: a frozen lever says so; the vote-lock frozen after asking; a mistyped address refused
  s.frozen.hook = true;
  await page.evaluate(() => window.satori.go('wiring'));
  await t(page, 'role-refresh').last().click();
  await expect(card(page, 'wiring', 'hook').locator('[data-test=role-save]')).toHaveText('Frozen');
  const bridge = card(page, 'wiring', 'bridge');
  await bridge.locator('[data-test=role-input]').fill(NEW);
  await bridge.locator('[data-test=role-again]').fill(`0x${'ac'.repeat(20)}`);
  await bridge.locator('[data-test=role-save]').click();
  await expect(bridge.locator('[data-test=role-error]')).toHaveText('The two entries do not match.');
  const freeze = card(page, 'wiring', 'freezeVoteLock');
  await freeze.locator('[data-test=role-do]').click();
  await freeze.locator('[data-test=role-yes]').click();
  await expect(freeze.locator('[data-test=role-result]')).toHaveText('The vote-lock contract is frozen for good.');
  expect(s.frozen.voteLock).toBe(true);
  await expect(freeze).toBeHidden();

  // the publisher job offered by the agent call
  expect(await page.evaluate((to) => window.satori.specialKey('publisher', 'offer', to), NEW)).toEqual([{ hash: expect.any(String), label: 'Offer the job to another address' }]);
  expect(s.pendingPublisher).toBe(NEW);

  // all handed away: the tabs go, and so does the name
  Object.assign(s, { appoint: NEW, wiring: NEW, publisher: NEW, splitSet: NEW, scheduleSet: NEW });
  await page.evaluate(() => window.satori.specialKeys());
  await expect(page.locator('body')).toHaveAttribute('data-tab', 'home');
  await expect(t(page, 'nav-wiring')).toBeHidden();
  await expect(t(page, 'app-wallet')).toHaveText(new RegExp(`^${V.slice(0, 6)}…${V.slice(-4)}$`, 'i'));
});
