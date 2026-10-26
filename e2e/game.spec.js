// The Game tab (docs/design/base.md#the-game) against the fake Satori contract behind /rpc (test/fake-satori.js): greyed
// out while the app plays on its own; by hand, the streams by weight, up and down, a swipe to skip and back, the submit
// screen, the wallet's Unlock in place and one transaction; favorites first, and Submit early after them.
import { expect, test } from '@playwright/test';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const REFERRER = `0x${'ab'.repeat(20)}`;
const ROUND = 20741;
const hourly = (n, f) => Array.from({ length: n }, (_, i) => ({ hour: ROUND * 24 - n + i, value: BigInt(Math.round(f(i))) }));
const t = (page, id) => page.locator(`[data-test=${id}]`);
const name = (page) => t(page, 'game-name');
/** The submit screen's list: each call as name + arrow. */
const calls = (page) => t(page, 'game-calls').locator('li').evaluateAll((li) => li.map((x) => `${x.textContent} ${x.querySelector('svg').getAttribute('aria-label')}`));

/** A swipe across the stream: left (skip) or right (back). */
async function swipe(page, way) {
  const box = await t(page, 'game-chart').boundingBox();
  const y = box.y + box.height / 2;
  const [from, to] = way === 'left' ? [box.x + box.width * 0.8, box.x + box.width * 0.2] : [box.x + box.width * 0.2, box.x + box.width * 0.8];
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move(to, y, { steps: 5 });
  await page.mouse.up();
}

async function shot(page, file) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: process.env.SHOTS ? `docs/screenshots/${file}` : test.info().outputPath(file) });
}

test('the Game tab: greyed out while automatic; by hand, pick, skip, back, submit from the wallet; favorites first', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc } = fakeSatori({ round: ROUND, hour: 9 });
  await stubCentral(context, { rpc });
  s.streams[2] = { game: 2, named: false, cadence: 60, name: 'bitcoin', history: hourly(72, (i) => 80000 + 900 * Math.sin(i / 6) + i * 20) };
  s.streams[3] = { game: 3, named: false, cadence: 60, name: 'ether', history: hourly(72, (i) => 3000 - 40 * Math.cos(i / 5)) };
  s.weights[2] = 3n * E18;
  s.weights[3] = 2n * E18;
  s.streams[4] = { game: 4, named: false, cadence: 60, name: 'dogecoin', history: hourly(72, (i) => 100 + i) }; // no weight: not reward eligible
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, `/?ref=${REFERRER}`); // an invite link: it holds who invited
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const V = (await page.evaluate(() => window.satori.base())).wallet.address.toLowerCase();
  rpc.eth[V] = 10n ** 17n;
  s.predicted[`${V}:${ROUND}`] = 1; // predicted this round already, not with the game (Satori Daily, say)

  // automatic: the game greyed out under the switch
  await page.evaluate(() => window.satori.go('game'));
  await expect(t(page, 'play-switch')).toBeVisible();
  await expect(name(page)).toHaveText('bitcoin', { timeout: 30_000 }); // read meanwhile, behind the switch
  await expect(t(page, 'game-board')).toHaveAttribute('inert', 'true');
  await shot(page, 'game-auto.png');

  // by hand: the most rewarding stream first; its line and latest value; the board fills the screen above the bar
  await t(page, 'play-manual').click();
  await expect(t(page, 'play-switch')).toBeHidden();
  await expect(t(page, 'play-setting-manual')).toHaveAttribute('aria-pressed', 'true'); // Settings › Satori contract predictions
  // opened again by hand: the switch's card never shows, not even for a moment (the mode is read before the app shows)
  await page.goto('/#game');
  await page.waitForFunction(() => document.body.dataset.screen === 'home');
  expect(await page.evaluate(() => [document.querySelector('[data-test=game-tab]').dataset.play, document.querySelector('[data-test=play-switch]').hidden]))
    .toEqual(['manual', true]);
  await expect(name(page)).toHaveText('bitcoin', { timeout: 30_000 });
  await expect(t(page, 'game-latest')).toHaveText(/^\d{2},\d{3}\.\d{2}$/);
  const [star, mark] = [await t(page, 'game-star').boundingBox(), await page.locator('.brand-mark').boundingBox()];
  expect(Math.abs((star.x + star.width / 2) - (mark.x + mark.width / 2))).toBeLessThan(1.5); // the star centred under the Satori mark
  const [theme, latest] = [await page.locator('[data-test=theme-toggle] svg').boundingBox(), await t(page, 'game-latest').boundingBox()];
  expect(Math.abs((theme.x + theme.width) - (latest.x + latest.width))).toBeLessThan(3); // the theme icon's right edge over the value's
  const [buttons, bar] = [await t(page, 'game-up').boundingBox(), await page.locator('nav.tabbar').boundingBox()];
  expect(bar.y - (buttons.y + buttons.height)).toBeLessThan(40);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
  await shot(page, 'game-play.png');

  // the wallet on top: its balance always; something to claim: the amount and CLAIM, which claims (Unlock in place)
  await expect(t(page, 'game-balance')).toHaveText('0');
  await expect(t(page, 'game-claim-row')).toBeHidden();
  s.airdrop[V] = E18;
  await page.evaluate(() => window.satori.base()); // read again
  await expect(t(page, 'game-claimable')).toHaveText('1');
  await shot(page, 'game-claim.png');
  await t(page, 'game-claim').click();
  const claimPrompt = page.locator('[data-unlock-for=game-claim]');
  await expect(claimPrompt).toBeVisible();
  await claimPrompt.locator('input').fill(PASS);
  await claimPrompt.getByRole('button', { name: 'Unlock' }).click();
  await expect(t(page, 'game-claim')).toHaveText('CLAIMED', { timeout: 30_000 });
  await expect(t(page, 'game-claimable')).toHaveText('1');
  await expect(t(page, 'game-balance')).toHaveText('1');

  await t(page, 'game-up').click(); // bitcoin up
  await expect(name(page)).toHaveText('ether');
  await t(page, 'game-star').click(); // a favorite: shown first next time
  await expect(t(page, 'game-star')).toHaveAttribute('aria-pressed', 'true');
  await swipe(page, 'left'); // skip ether
  await expect(name(page)).toHaveText('satori');
  await t(page, 'game-star').click();
  await swipe(page, 'right'); // back to ether
  await expect(name(page)).toHaveText('ether');
  await t(page, 'game-down').click(); // ether down
  await expect(t(page, 'game-submit-early')).toHaveAttribute('data-open', 'false'); // no favorites when read: Submit at the end
  await t(page, 'game-up').click(); // satori up: the last eligible, so the submit screen
  await expect(t(page, 'game-submit-screen')).toBeVisible();
  await expect.poll(() => calls(page)).toEqual(['bitcoin up', 'ether down', 'satori up']);
  await expect(t(page, 'game-daily')).toHaveAttribute('href', 'https://games.satorinet.io');
  await expect(t(page, 'game-daily')).toHaveAttribute('target', '_blank');
  await shot(page, 'game-submit.png');
  // a swipe left goes on to the streams that aren't reward eligible, then the submit screen again
  await page.waitForTimeout(400);
  const list = await t(page, 'game-calls').boundingBox();
  await page.mouse.move(list.x + list.width * 0.8, list.y + 10);
  await page.mouse.down();
  await page.mouse.move(list.x + list.width * 0.1, list.y + 12, { steps: 5 });
  await page.mouse.up();
  await expect(name(page)).toHaveText('dogecoin');
  await expect(t(page, 'game-play')).toBeVisible();
  await expect(t(page, 'game-submit-early')).toHaveAttribute('data-open', 'true'); // past the submit screen: Submit shows
  await t(page, 'game-down').click();
  await expect(t(page, 'game-submit-screen')).toBeVisible();
  await expect.poll(() => calls(page)).toEqual(['bitcoin up', 'ether down', 'satori up', 'dogecoin down']);
  expect(await page.evaluate((v) => localStorage.getItem(`satori-favorites-${v}`), V)).toBe('[3,1]');

  // already predicted this round, not by the game: played as usual, and Submit is done without sending or Unlock
  await t(page, 'game-send').click();
  await expect(t(page, 'game-sent')).toContainText('4 Predictions submitted');
  await expect(t(page, 'game-sent')).not.toContainText('Transaction');
  await expect(page.locator('[data-unlock-for=game]')).toBeHidden();
  expect(s.batches).toHaveLength(0);
  // played with the game this round: its Sent screen, again
  await t(page, 'game-done').click();
  await expect(t(page, 'game-tomorrow')).toBeVisible();
  await expect(t(page, 'game-sent')).toContainText('4 Predictions submitted');
  // Dismiss (this session): the streams again, to look at; where the buttons were, come back tomorrow
  await t(page, 'game-dismiss').click();
  await expect(t(page, 'game-play')).toBeVisible();
  await expect(name(page)).toHaveText('ether'); // read again: the favorites first now
  await expect(t(page, 'game-rest')).toHaveText('Come back tomorrow to see how your predictions were scored.');
  await expect(t(page, 'game-up')).toBeHidden();
  const [rest, room] = [await t(page, 'game-rest').boundingBox(), await page.locator('.gbtns').boundingBox()];
  expect(Math.abs(rest.height - room.height)).toBeLessThan(1); // the buttons' room, the note centred in it

  // a round later: the favorites first, as starred; after them Submit shows under the buttons; the wallet sends
  rpc.advance(86400);
  for (const id of [2, 3]) s.streams[id].history.push({ hour: (ROUND + 1) * 24 + 1, value: s.streams[id].history.at(-1).value + 5n });
  await page.evaluate(() => window.satori.go('home'));
  await page.evaluate(() => window.satori.go('game')); // read again on the way in, after a Submit
  await expect(name(page)).toHaveText('ether', { timeout: 30_000 });
  await t(page, 'game-up').click();
  await expect(name(page)).toHaveText('satori');
  await expect(t(page, 'game-submit-early')).toHaveAttribute('data-open', 'false');
  await t(page, 'game-down').click();
  await expect(name(page)).toHaveText('bitcoin');
  await expect(t(page, 'game-submit-early')).toHaveAttribute('data-open', 'true');
  await shot(page, 'game-submit-early.png');
  await t(page, 'game-submit').click();
  await expect.poll(() => calls(page)).toEqual(['ether up', 'satori down']);
  await t(page, 'game-send').click();
  const prompt = page.locator('[data-unlock-for=game]');
  await expect.poll(async () => (await prompt.isVisible()) || (await t(page, 'game-sent').isVisible()), { timeout: 30_000 }).toBe(true);
  if (await prompt.isVisible()) {
    await prompt.locator('input').fill(PASS);
    await prompt.getByRole('button', { name: 'Unlock' }).click();
  }
  await expect(t(page, 'game-sent')).toContainText('2 Predictions submitted', { timeout: 30_000 });
  await expect(t(page, 'game-sent')).toContainText('They will be scored in 24 hours.');
  expect(s.batches).toHaveLength(1);
  expect(s.batches[0]).toMatchObject({ from: V, requests: [{ gameId: 3, payload: '0x01' }, { gameId: 1, payload: '0x02' }] });
  // the wallet's first prediction registered who invited it, as the dapp's does
  expect(rpc.sent.find((x) => x.functionName.startsWith('predictMultiple'))).toMatchObject({ functionName: 'predictMultipleWithReferral' });
  expect(s.referral[V]).toBe(REFERRER);
  expect((await page.evaluate(() => window.satori.base())).pendingReferrer).toBe(null);
});
