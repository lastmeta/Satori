// What the neuron is doing (docs/design/health.md#work, #the-tone), in Chrome with the stub central and a fake chain: a
// new neuron's hero turns one short arc around its ring and says each step, in order, each long enough to read, then
// Predicting; its tone is working green, vivid while sending (Keep Satori open), then sky green, fading in slowly. No
// other animation on the screen; reduced motion has none. SHOTS=1 writes docs/screenshots/working-phone-*.png and
// tone-*-phone-*.png (else to the test's output).
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fakeSatori } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/identity-parity.json', import.meta.url)));
const v = fx.vectors[2];
const PASS = 'correct horse battery';
const H = 3600;
const nowS = () => Math.floor(Date.now() / 1000);
const NAMES = ['bitcoin', 'eth', 'gold', 'silver', 'oil', 'eur-usd', 'sp500', 'fear-greed'];
const STEPS = ['central:register', 'central:observations', 'central:history', 'central:models', 'central:send'];

/** Central's 8 streams now, each with 600 h of history. */
function streams(stub, t = nowS() - 60) {
  const price = (i, k) => (100 + 10 * i) * (1 + 0.02 * Math.sin(k / (3 + i)));
  stub.batch = NAMES.map((name, i) => ({ id: 1, observed_at: `${t}.25`, value: String(price(i, 600)), hash: '', stream_id: 1,
    stream: { id: 1, uuid: `u-${name}`, name, meta: null }, ts: '', stream_uuid: `u-${name}` }));
  stub.history = Object.fromEntries(NAMES.map((name, i) => [`u-${name}`, Array.from({ length: 600 }, (_, j) => ({
    id: j, stream_uuid: `u-${name}`, observed_at: `${t - (600 - j) * H}.25`, value: String(price(i, j)), ts: '' }))]));
}

async function setup(context) {
  const chain = fakeSatori({ round: Math.floor(nowS() / 86400), hour: 9 });
  const central = await stubCentral(context, { rpc: chain.rpc });
  central.vaults[v.pubkey] = v.ethAddress; // central pays this vault: no mismatch
  return central;
}

/** Every change of the hero (its line, step, tone, title), with the page's clock: window.__hero. */
const RECORD = () => {
  window.__hero = [];
  let last = '';
  const tick = () => {
    const el = document.querySelector('[data-test=health]');
    if (el && document.body.dataset.screen === 'home') {
      const r = { line: el.querySelector('[data-test=health-line]').textContent, work: el.dataset.work ?? '', tone: el.dataset.tone,
        title: el.querySelector('[data-test=health-title]').textContent, fade: el.hasAttribute('data-fade') };
      const key = JSON.stringify(r);
      if (key !== last) window.__hero.push({ ...r, t: performance.now() });
      last = key;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const hero = (page) => page.locator('[data-test=health]');
const line = (page) => page.locator('[data-test=health-line]');
/** The page's CSS animations (not the chips' glow: those are transitions): [{ name, on, pseudo }]. */
const animations = (page) => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSAnimation)
  .map((a) => ({ name: a.animationName, on: a.effect.target.className, pseudo: a.effect.pseudoElement })));

/** The hero's colour transitions, run to their end (the 2.5 min fade included). */
const settle = (page) => hero(page).evaluate((el) => el.getAnimations().forEach((a) => a.finish()));

async function shot(page, names) {
  const dir = process.env.SHOTS ? 'docs/screenshots' : test.info().outputPath();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(100);
    await settle(page);
    for (const name of names) await page.screenshot({ path: `${dir}/${name}-phone-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('a new neuron: one turning ring, each step in order and readable, then Predicting; working green, vivid while sending, then sky', async ({ context, page }) => {
  test.setTimeout(240_000);
  const central = await setup(context);
  streams(central);
  central.historyDelayMs = 500; // the streams' history comes in one by one, the n-th after n × 0.5 s
  const send = central.hold('submit'); // the predictions batch, held: the critical step, seen
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(RECORD);
  await openApp(page);
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, vaultWords: w }), [PASS, v.words]);

  // working: regular green; the one animation on the screen is the hero's ring
  await expect(line(page)).toHaveText(/^Loading history · [1-6] of 8 streams$/, { timeout: LOAD_TIMEOUT });
  await expect(hero(page)).toHaveAttribute('data-work', 'central:history');
  await expect(hero(page)).toHaveAttribute('data-tone', 'working');
  await expect(hero(page)).toHaveAttribute('aria-busy', 'true');
  expect(await animations(page)).toEqual([{ name: 'ring-turn', on: 'ring', pseudo: '::after' }]);
  const h = await page.evaluate(() => window.satori.health());
  expect(h).toMatchObject({ status: 'idle', tone: 'working', title: 'Starting',
    work: { task: 'central', step: 'history', total: 8, critical: false, text: expect.stringMatching(/^Loading history · \d of 8 streams$/) } });
  await shot(page, ['working', 'tone-working']);

  // sending: closing now would lose work: vivid green, and the line says to keep Satori open
  await expect(line(page)).toHaveText('Keep Satori open · Sending 8 predictions…', { timeout: LOAD_TIMEOUT });
  await expect(hero(page)).toHaveAttribute('data-tone', 'critical');
  expect(await page.evaluate(() => window.satori.health())).toMatchObject({ tone: 'critical', work: { step: 'send', critical: true } });
  expect(await animations(page)).toHaveLength(1);
  await shot(page, ['tone-critical']);

  // done: Predicting, sky green (fading in over 2.5 min), nothing moving
  send();
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting', { timeout: LOAD_TIMEOUT });
  await expect(line(page)).toHaveText('Sent 8 predictions just now · next in 11 h');
  await expect(hero(page)).toHaveAttribute('data-tone', 'idle');
  await expect(hero(page)).toHaveAttribute('data-fade', '');
  await expect(hero(page)).not.toHaveAttribute('data-work');
  // the fade to sky: running, 2.5 min long
  expect(await hero(page).evaluate((el) => el.getAnimations().filter((a) => a instanceof CSSTransition)
    .map((a) => [a.transitionProperty, a.effect.getTiming().duration]))).toEqual(expect.arrayContaining([['--hero-tone', 150_000]]));
  expect(await animations(page)).toEqual([]);
  expect(await page.evaluate(() => window.satori.health())).toMatchObject({ status: 'ok', tone: 'idle', work: null });

  // the steps, in order, each at least about a second on screen; the line never sat on the same words
  const seen = await page.evaluate(() => window.__hero);
  const steps = [];
  for (const r of seen) if (r.work && r.work !== steps.at(-1)?.work) steps.push(r);
  expect(steps.length).toBeGreaterThanOrEqual(3);
  expect(steps.map((r) => r.work)).toEqual(STEPS.filter((s) => steps.some((r) => r.work === s))); // in order
  expect(steps.map((r) => r.work)).toEqual(expect.arrayContaining(['central:history', 'central:send']));
  for (let i = 0; i + 1 < steps.length; i++) expect(steps[i + 1].t - steps[i].t, steps[i].work).toBeGreaterThanOrEqual(950);
  expect(new Set(seen.filter((r) => r.work === 'central:history').map((r) => r.line)).size).toBeGreaterThan(2); // the count ticked
  expect(seen.filter((r) => r.work && r.work !== 'central:send').every((r) => r.tone === 'working')).toBe(true);
  const firstDone = seen.findIndex((r) => r.title === 'Predicting');
  expect(seen.slice(0, firstDone).some((r) => r.work === 'central:send' && r.tone === 'critical')).toBe(true);

  // run to its end: the hero is sky green
  await settle(page);
  expect(await hero(page).evaluate((el) => getComputedStyle(el).getPropertyValue('--hero-tone').trim())).toBe('rgb(162, 207, 174)'); // --sky
  await shot(page, ['tone-idle']);

  // Poll now: back to green at once, then sky again; never gray
  await page.evaluate(() => void window.satori.poll());
  await expect(hero(page)).toHaveAttribute('data-tone', 'working');
  await expect(hero(page)).not.toHaveAttribute('data-fade');
  await expect(hero(page)).toHaveAttribute('data-tone', 'idle', { timeout: LOAD_TIMEOUT });
  expect((await page.evaluate(() => window.__hero)).every((r) => ['working', 'critical', 'idle'].includes(r.tone))).toBe(true);
  expect(central.prod).toEqual([]);
});

test('reduced motion: nothing turns; a still working mark, and the words change', async ({ context, page }) => {
  const central = await setup(context);
  streams(central);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const release = central.hold(); // the poll's observations batch, held
  await openApp(page);
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, vaultWords: w }), [PASS, v.words]);
  await expect(line(page)).toHaveText("Fetching today's observations…", { timeout: LOAD_TIMEOUT });
  await expect(hero(page)).toHaveAttribute('data-work', 'central:observations');
  expect(await animations(page)).toEqual([]);
  expect(await page.locator('.ring').evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none');
  expect(await page.locator('.ring .ico').evaluate((el) => getComputedStyle(el).maskImage)).toMatch(/circle/); // the dots
  release();
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting', { timeout: LOAD_TIMEOUT });
  expect(await animations(page)).toEqual([]);
  expect(central.prod).toEqual([]);
});
