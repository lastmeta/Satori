// Referral in the app (docs/design/base.md#referral-invite-links), against the fake D6 behind /rpc and the stub
// central2 as base.spec.js: an invite link opened by a new neuron sends nothing; Stake registers its referrer from the
// wallet first; the neuron's own invite link names the wallet.
import { expect, test } from '@playwright/test';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const ROUND = 20741;
const REFERRER = '0x' + 'ab'.repeat(20);

const fact = (page, name) => page.locator(`[data-test=base-${name}]`);
const go = (page, tab) => page.evaluate((t) => window.satori.go(t), tab);

test('an invite link: held on the visit, registered by the wallet at Stake; the neuron\'s own link is the wallet\'s', async ({ context, page }) => {
  test.setTimeout(180_000);
  const chain = fakeSatori({ round: ROUND, hour: 9 });
  const { s, rpc } = chain;
  await stubCentral(context, { rpc });
  await openApp(page, `/?ref=${REFERRER}`);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('[data-test=alias]')).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: LOAD_TIMEOUT });
  const base = await page.evaluate(() => window.satori.base());
  const I = base.alias.address.toLowerCase();
  const V = base.wallet.address.toLowerCase();
  expect(base.pendingReferrer).toBe(REFERRER);
  expect(base.inviteLink).toBe(`http://localhost:5180/?ref=${base.wallet.address}`);
  expect(rpc.sent).toHaveLength(0); // opening the link sends nothing

  await go(page, 'wallet');
  await expect(fact(page, 'referral')).toHaveText(/^Invited by 0xabab…abab, registered when you stake$/);
  await expect(fact(page, 'referral-note')).toContainText('Staking registers them as your referral');
  await expect(fact(page, 'invite')).toHaveText(base.inviteLink);

  // Share, top right: the invite link to the device's share sheet (a stub here), else copied
  await page.evaluate(() => { window.__shared = []; navigator.share = async (d) => void window.__shared.push(d); });
  await page.locator('[data-test=share]').click();
  expect(await page.evaluate(() => window.__shared)).toEqual([{ title: 'Satori app', url: base.inviteLink }]);
  await page.evaluate(() => { navigator.share = undefined; });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('[data-test=share]').click();
  await expect(page.locator('[data-test=share]')).toHaveText('Link copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(base.inviteLink);

  rpc.eth[I] = 10n ** 17n;
  rpc.eth[V] = 10n ** 17n;
  s.balance[V] = 100n * E18;
  await fact(page, 'refresh').click();
  await expect(fact(page, 'wallet-satori')).toHaveText('100');
  await go(page, 'settings');
  await page.getByLabel('Wallet passphrase', { exact: true }).fill(PASS);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-test=wallet-state]')).toHaveText('Unlocked');
  await page.getByRole('button', { name: 'Wallet words' }).click(); // a word list first: ArrowJS 1.0.6 reuses its <li> for other lists
  await page.getByLabel('Wallet passphrase to show the backup').fill(PASS);
  await page.locator('[data-test=backup-prompt]').getByRole('button', { name: 'Show' }).click();
  await page.getByRole('button', { name: 'Hide' }).click();
  await go(page, 'wallet');
  await page.getByRole('button', { name: 'Stake with this app' }).click();
  await expect(fact(page, 'result')).toHaveText('Staked with this app.', { timeout: 30_000 });

  expect(rpc.sent.map((t) => [t.from, t.functionName])).toEqual([
    [V, 'setReferral'], [I, 'setPredictorFee'], [I, 'setAllowedDelegator'], [V, 'delegatePredictionPower'],
  ]);
  expect(s.referral[V]).toBe(REFERRER);
  await expect(fact(page, 'referral')).toHaveText(/^0xabab…abab$/i);
  await expect(fact(page, 'referral-note')).toBeHidden();
  await expect(page.locator('[data-test=base-txs] code').first()).toHaveText(/^Wallet: registers who invited you 0x/);
  expect((await page.evaluate(() => window.satori.base())).pendingReferrer).toBeNull();

  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const box = (sel) => page.locator(sel).first().boundingBox();
  const [h1, top, share] = [await box('header.top h1'), await box('header.top'), await box('[data-test=share]')];
  expect(h1.height).toBeLessThan(40); // "Satori app" on one line, with Lock and Share beside it
  expect(share.x + share.width).toBeLessThanOrEqual(top.x + top.width + 0.5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: process.env.SHOTS ? 'docs/screenshots/referral.png' : test.info().outputPath('referral.png'), fullPage: true });
  await page.setViewportSize(size);
});
