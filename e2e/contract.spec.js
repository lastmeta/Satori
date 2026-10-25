// Home's chip cards (docs/design/health.md#the-chip-cards), the Satori contract's most against the fake Satori contract behind /rpc
// (test/fake-satori.js): the Contract chip opens it; what is missing says its fix (Stake; Base ETH to an address, with a
// QR code); by hand, Play; green once predicted this round; the agent's contract().
import { expect, test } from '@playwright/test';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const t = (page, id) => page.locator(`[data-test=${id}]`);
const checks = (page) => page.locator('.chip-card:not([hidden]) [data-test=chip-check]').evaluateAll((li) => li.map((x) => `${x.dataset.id}:${x.dataset.state}`));
const chip = (page) => page.locator('[data-test=chip][data-channel=contract]');

test('the Contract chip opens its card: the checks and their fixes, the mode, green once predicted', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc } = fakeSatori({ round: 20741, hour: 9 });
  await stubCentral(context, { rpc });
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const { alias, wallet } = await page.evaluate(() => window.satori.base());

  // automatic, not staked, no gas: the card opens under the chips, not another tab
  await expect(t(page, 'chip-card')).toHaveAttribute('data-open', 'false');
  await chip(page).click();
  await expect(t(page, 'chip-card')).toHaveAttribute('data-open', 'true');
  await expect(t(page, 'contract-card')).toBeVisible();
  expect(await page.evaluate(() => document.body.dataset.tab)).toBe('home');
  await expect.poll(() => checks(page)).toEqual(['satori:bad', 'stake:bad', 'gas:bad', 'today:wait']);
  await expect(t(page, 'contract-stake')).toBeVisible();
  await expect(t(page, 'contract-fund-address')).toHaveText(alias.address);
  await t(page, 'contract-qr-toggle').click();
  await expect(t(page, 'contract-qr')).toBeVisible();
  expect(await t(page, 'contract-qr').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  await expect(t(page, 'contract-arrow')).toHaveAttribute('data-on', 'false');
  await page.waitForTimeout(400);
  await page.screenshot({ path: process.env.SHOTS ? 'docs/screenshots/contract-card.png' : test.info().outputPath('contract-card.png'), fullPage: true });
  expect(await page.evaluate(() => window.satori.contract())).toMatchObject({ play: 'auto', predictedToday: false,
    checks: [{ id: 'satori', state: 'bad' }, { id: 'stake', state: 'bad', fix: 'stake' }, { id: 'gas', state: 'bad', fix: 'fund', address: alias.address }, { id: 'today', state: 'wait' }] });

  // by hand, from the card: the wallet plays; its gas; Play
  await t(page, 'contract-play-manual').click();
  await expect.poll(() => checks(page)).toEqual(['satori:bad', 'gas:bad', 'today:wait']);
  await expect(t(page, 'contract-fund-address')).toHaveText(wallet.address);
  rpc.eth[wallet.address.toLowerCase()] = 10n ** 17n;
  await page.evaluate(() => window.satori.base());
  await expect.poll(() => checks(page)).toEqual(['satori:bad', 'gas:ok', 'today:wait']);
  await expect(chip(page)).toHaveAttribute('data-tone', 'off');
  await expect(t(page, 'contract-play')).toBeVisible();

  // played today (the game, by call): green, the chip and the arrow
  await page.evaluate((p) => window.satori.unlock(p), PASS);
  await page.evaluate(() => window.satori.playGame([{ streamId: 1, direction: 'up' }]));
  await page.evaluate(() => window.satori.base());
  await expect.poll(() => checks(page)).toEqual(['satori:bad', 'gas:ok', 'today:ok']);
  await expect(t(page, 'contract-arrow')).toHaveAttribute('data-on', 'true');
  await expect(chip(page)).toHaveAttribute('data-tone', 'idle');
  await expect(chip(page).locator('[data-test=chip-text]')).toHaveText('Played today');

  // the other chips' cards: what each is for, its picture, its checks; the agent's channel()
  await page.locator('[data-test=chip][data-channel=network]').click();
  await expect(t(page, 'network-card')).toBeVisible();
  await expect(t(page, 'contract-card')).toBeHidden();
  await expect.poll(() => checks(page)).toEqual(['register:ok', 'wallet:ok', expect.stringMatching(/^sent:/)]);
  await expect(t(page, 'network-arrow')).toHaveAttribute('data-on', /true|false/);
  await page.locator('[data-test=chip][data-channel=relays]').click();
  await expect(t(page, 'relays-card')).toBeVisible();
  await expect.poll(() => checks(page)).toEqual([expect.stringMatching(/^connected:/), expect.stringMatching(/^watching:/), 'publishing:wait']);
  await expect(t(page, 'relays-streams')).toBeVisible();
  expect(await page.evaluate(() => window.satori.channel('relays'))).toMatchObject({ working: expect.any(Boolean), checks: [{ id: 'connected' }, { id: 'watching' }, { id: 'publishing' }] });
  expect(await page.evaluate(() => window.satori.channel('network'))).toMatchObject({ checks: [{ id: 'register', state: 'ok' }, { id: 'wallet' }, { id: 'sent' }] });

  // the same chip again folds it away
  await page.locator('[data-test=chip][data-channel=relays]').click();
  await expect(t(page, 'chip-card')).toHaveAttribute('data-open', 'false');
});
