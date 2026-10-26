// A first visit you can watch (docs/design/storage.md#the-first-visit, health.md#the-last-visit), in Chrome against the
// stub central with DuckDB's wasm held back (the route answers only when released): a fresh origin shows Setup at once,
// while the engine downloads; writing the keys waits for it and says so. A revisit paints the last visit's Home at
// once, marked "From your last visit" with the engine's step in the hero, until the neuron's own Home arrives.
import { expect, test } from '@playwright/test';
import { LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const T0 = Math.floor(Date.now() / 1000) - 3600;
const entry = (uuid, name, at, value) => ({ id: 1, observed_at: `${at}.25`, value, hash: '', stream_id: 1,
  stream: { id: 1, uuid, name, meta: null }, ts: '', stream_uuid: uuid });

/** DuckDB's wasm, held until release() (the dev server's and a build's names alike); `asked`: it was requested. */
async function holdEngine(context) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const engine = { asked: 0, release: () => release() };
  // the wasm itself, not the dev server's `?url` module that names it
  await context.route((u) => /duckdb-eh[^/]*\.wasm$/.test(u.pathname) && !u.search, async (route) => {
    engine.asked++;
    await gate;
    await route.continue();
  });
  return engine;
}

const screen = (page) => page.evaluate(() => document.body.dataset.screen);
const visible = (loc) => loc.filter({ visible: true });

test('a first visit: Setup at once while the engine downloads; the keys wait for it, saying so', async ({ context, page }) => {
  await stubCentral(context);
  const engine = await holdEngine(context);
  await page.goto('/');
  await expect.poll(() => screen(page), { timeout: LOAD_TIMEOUT }).toBe('setup'); // before DuckDB: it is still held
  await expect.poll(() => engine.asked).toBeGreaterThan(0); // its download began at once
  await expect(page.getByRole('button', { name: 'Create a wallet' })).toBeVisible();
  // Setup's first steps need no database: the words, their check, the passphrase
  await page.getByRole('button', { name: 'Create a wallet' }).click();
  const words = await visible(page.locator('ol.words li')).allTextContents();
  await page.getByRole('button', { name: 'I wrote them down' }).click();
  for (const input of await visible(page.getByLabel(/^Word #\d+/)).all()) {
    const n = Number((await input.evaluate((el) => el.closest('label').textContent)).match(/#(\d+)/)[1]);
    await input.fill(words[n - 1]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await visible(page.getByLabel('Passphrase', { exact: true })).fill(PASS);
  await page.getByLabel('Repeat passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  // the keys wait for the database, and Setup says what for
  const wait = page.locator('[data-test=setup-wait]');
  await expect(wait).toBeVisible();
  await expect(wait).toHaveText(/^Finishing setup… downloading the engine/);
  await expect(wait.locator('progress')).toBeVisible();
  expect(await screen(page)).toBe('setup');
  engine.release();
  await expect.poll(() => screen(page), { timeout: LOAD_TIMEOUT }).toBe('home');
  await expect(wait).toBeHidden();
  expect(await page.evaluate(async () => (await window.satori.status()).wallet)).toMatch(/^0x[0-9a-fA-F]{40}$/);
});

test('an agent\'s setup() on the first screen waits for the engine, then runs', async ({ context, page }) => {
  await stubCentral(context);
  const engine = await holdEngine(context);
  await page.goto('/');
  await expect.poll(() => screen(page), { timeout: LOAD_TIMEOUT }).toBe('setup');
  const done = page.evaluate((p) => window.satori.setup({ passphrase: p }).then((s) => s.screen), PASS);
  await expect(page.locator('[data-test=setup-wait]')).toBeVisible(); // the person looking sees why
  engine.release();
  expect(await done).toBe('home');
});

test('a revisit: the last visit\'s Home at once, marked, with the engine\'s step, until the neuron\'s own', async ({ context, page }) => {
  const central = await stubCentral(context);
  central.batch = [entry('u-btc', 'bitcoin', T0, '67000.5'), entry('u-eth', 'eth', T0, '2500.0')];
  await page.goto('/');
  await expect.poll(() => screen(page), { timeout: LOAD_TIMEOUT }).toBe('setup');
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('[data-test=health-title]')).toHaveText(/^Predict(ed|ing)$/, { timeout: LOAD_TIMEOUT });
  const live = await page.evaluate(() => window.satori.health());

  // the next visit, the engine held: Home at once from the last visit, the hero saying it is opening
  const engine = await holdEngine(context);
  await page.reload();
  await expect(page.locator('[data-test=health-stale]')).toHaveText(/^From your last visit, (just now|\d+ min ago)$/, { timeout: LOAD_TIMEOUT });
  expect(await screen(page)).toBe('loading'); // agents still wait: window.satori is not ready
  await expect(page.locator('[data-test=health-title]')).toHaveText(/^Predict(ed|ing)$/);
  await expect(page.locator('[data-test=health-line]')).toHaveText(/^Opening… (downloading the engine|starting the engine…)/);
  await expect(page.locator('[data-test=health]')).toHaveAttribute('data-work', 'open'); // the ring turns
  await expect(page.locator('[data-test=chip][data-channel=network] [data-test=chip-text]')).toHaveText(live.channels.network.text);
  await expect(page.locator('[data-test=day]')).toHaveCount(30);
  await expect(page.locator('[data-test=opening]')).toBeHidden();
  await expect(page.locator('[data-test=action]')).toBeHidden(); // no card: its button needs the neuron
  await expect(page.locator('nav.tabbar')).toBeHidden();
  engine.release();
  await expect.poll(() => screen(page), { timeout: LOAD_TIMEOUT }).toBe('home');
  await expect(page.locator('[data-test=health-stale]')).toBeHidden();
  await expect(page.locator('[data-test=health-title]')).toHaveText(/^Predict(ed|ing)$/);

  // another tab's route (not Home): "Opening…" with the engine's step instead
  await page.evaluate(() => window.satori.go('settings'));
  await page.reload();
  await expect(page.locator('[data-test=opening]')).toHaveText(/^Opening…/, { timeout: LOAD_TIMEOUT });
  await expect.poll(() => screen(page), { timeout: LOAD_TIMEOUT }).toBe('home');
});
