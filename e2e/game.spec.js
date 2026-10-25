// The Game tab (docs/design/base.md#the-game) against the fake Satori contract behind /rpc (test/fake-satori.js): greyed
// out while the app plays on its own; by hand, the streams by weight, up and down, a swipe to skip and back, the submit
// screen, the wallet's Unlock in place and one transaction; favorites first, and Submit early after them.
import { expect, test } from '@playwright/test';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const ROUND = 20741;
const hourly = (n, f) => Array.from({ length: n }, (_, i) => ({ hour: ROUND * 24 - n + i, value: BigInt(Math.round(f(i))) }));
const t = (page, id) => page.locator(`[data-test=${id}]`);
const name = (page) => t(page, 'game-name');

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
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const V = (await page.evaluate(() => window.satori.base())).wallet.address.toLowerCase();
  rpc.eth[V] = 10n ** 17n;

  // automatic: the game greyed out under the switch
  await page.evaluate(() => window.satori.go('game'));
  await expect(t(page, 'play-switch')).toBeVisible();
  await expect(name(page)).toHaveText('bitcoin', { timeout: 30_000 }); // read meanwhile, behind the switch
  await expect(t(page, 'game-board')).toHaveAttribute('inert', 'true');
  await shot(page, 'game-auto.png');

  // by hand: the most rewarding stream first; its line and latest value; the board fills the screen above the bar
  await t(page, 'play-manual').click();
  await expect(t(page, 'play-switch')).toBeHidden();
  await expect(t(page, 'game-latest')).toHaveText(/^\d{2},\d{3}\.\d{2}$/);
  const [buttons, bar] = [await t(page, 'game-up').boundingBox(), await page.locator('nav.tabbar').boundingBox()];
  expect(bar.y - (buttons.y + buttons.height)).toBeLessThan(40);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
  await shot(page, 'game-play.png');

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
  await expect(t(page, 'game-submit-early')).toHaveAttribute('data-open', 'false'); // no favorites when this game was read: Submit only at the end
  await t(page, 'game-up').click(); // satori up: the last, so the submit screen
  await expect(t(page, 'game-submit-screen')).toBeVisible();
  await expect(t(page, 'game-calls').locator('li')).toHaveText(['bitcoinup', 'etherdown', 'satoriup']);
  await shot(page, 'game-submit.png');
  expect(await page.evaluate((v) => localStorage.getItem(`satori-favorites-${v}`), V)).toBe('[3,1]');

  // the wallet plays (not staked): Unlock in place, then one transaction with the three calls
  await t(page, 'game-send').click();
  const prompt = page.locator('[data-unlock-for=game]');
  await expect.poll(async () => (await prompt.isVisible()) || (await t(page, 'game-sent').isVisible()), { timeout: 30_000 }).toBe(true);
  if (await prompt.isVisible()) {
    await prompt.locator('input').fill(PASS);
    await prompt.getByRole('button', { name: 'Unlock' }).click();
  }
  await expect(t(page, 'game-sent')).toContainText('Sent 3 predictions', { timeout: 30_000 });
  expect(s.batches).toHaveLength(1);
  expect(s.batches[0]).toMatchObject({ from: V, requests: [{ gameId: 2, payload: '0x01' }, { gameId: 3, payload: '0x02' }, { gameId: 1, payload: '0x01' }] });

  // already predicted this round: the game plays as usual (favorites first now), and Submit is done without sending
  await t(page, 'game-done').click();
  await expect(name(page)).toHaveText('ether', { timeout: 30_000 });
  await t(page, 'game-up').click();
  await swipe(page, 'left');
  await swipe(page, 'left');
  await expect(t(page, 'game-submit-screen')).toBeVisible();
  await t(page, 'game-send').click();
  await expect(t(page, 'game-sent')).toContainText('Sent 1 prediction');
  await expect(t(page, 'game-sent')).not.toContainText('Transaction');
  expect(s.batches).toHaveLength(1); // nothing sent

  // a round later: the favorites first, as starred; after them Submit shows under the buttons
  rpc.advance(86400);
  for (const id of [2, 3]) s.streams[id].history.push({ hour: (ROUND + 1) * 24 + 1, value: s.streams[id].history.at(-1).value + 5n });
  await t(page, 'game-done').click();
  await expect(name(page)).toHaveText('ether', { timeout: 30_000 });
  await t(page, 'game-up').click();
  await expect(name(page)).toHaveText('satori');
  await expect(t(page, 'game-submit-early')).toHaveAttribute('data-open', 'false');
  await t(page, 'game-down').click();
  await expect(name(page)).toHaveText('bitcoin');
  await expect(t(page, 'game-submit-early')).toHaveAttribute('data-open', 'true');
  await shot(page, 'game-submit-early.png');
  await t(page, 'game-submit').click();
  await expect(t(page, 'game-calls').locator('li')).toHaveText(['etherup', 'satoridown']);
});
