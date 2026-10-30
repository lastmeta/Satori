// The Game tab's swipes by touch, on a phone (docs/design/base.md#the-game), against the fake Satori contract behind /rpc (test/fake-satori.js): greyed
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

/** A swipe across the stream, on its name's row (a finger on the chart reads its values): left (skip) or right (back). */
async function swipe(page, way) {
  const box = await t(page, 'game-chart').boundingBox();
  const head = await page.locator('.ghead').boundingBox();
  const y = head.y + head.height / 2;
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

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
test('a finger swipes, flicks fast or slow (touch: the browser never takes the sideways move), and back from the submit screen', async ({ context, page }) => {
  test.setTimeout(120_000);
  const { s, rpc } = fakeSatori({ round: ROUND, hour: 9 });
  await stubCentral(context, { rpc });
  s.streams[2] = { game: 2, named: false, cadence: 60, name: 'bitcoin', history: hourly(72, (i) => 80000 + 900 * Math.sin(i / 6)) };
  s.weights[2] = 3n * E18;
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => window.satori.go('game'));
  await t(page, 'play-manual').tap();
  await expect(name(page)).toHaveText('bitcoin', { timeout: 30_000 });
  const cdp = await context.newCDPSession(page);
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  /** A fast flick: a few long steps, no pause. */
  const flick = async (from, to, y) => {
    const frame = () => page.waitForTimeout(16); // a phone's touch events, a frame apart
    await touch('touchStart', from, y);
    await frame();
    await touch('touchMove', from + (to - from) / 3, y + 6);
    await frame();
    await touch('touchMove', to, y + 10);
    await frame();
    await touch('touchEnd', to, y);
  };
  await page.waitForTimeout(400);
  const head = await page.locator('.ghead').boundingBox(); // the name's row: a finger on the chart reads its values
  const Y = Math.round(head.y + head.height / 2);
  await flick(330, 60, Y); // a long fast flick left: on to the next
  await expect(name(page)).toHaveText('satori');
  await page.waitForTimeout(500);
  await flick(150, 200, Y); // a short fast one right (50 px): back
  await expect(name(page)).toHaveText('bitcoin');
  await page.waitForTimeout(1200); // Chrome takes a tap right on a flick's heels as the flick's end, not a tap
  await t(page, 'game-up').tap();
  await expect(name(page)).toHaveText('satori');
  await t(page, 'game-up').tap();
  await expect(t(page, 'game-submit-screen')).toBeVisible();
  await page.waitForTimeout(500);
  const y = 500;
  await touch('touchStart', 60, y);
  for (let x = 80; x <= 320; x += 30) await touch('touchMove', x, y + 3);
  await touch('touchEnd', 320, y);
  await expect(name(page)).toHaveText('satori');
  await expect(t(page, 'game-play')).toBeVisible();
});
