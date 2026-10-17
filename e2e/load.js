// Loading the app takes seconds (DuckDB-WASM's 34 MB wasm, then OPFS), more on
// a busy box: every spec opens and reloads it through these, which wait until
// the page has left "Opening…" (<body data-screen>, kept current), up to 60 s.
import { expect } from '@playwright/test';

export const LOAD_TIMEOUT = 60_000; // seconds normally; 10–30 s while the shared box is busy

const screen = (page) => page.evaluate(() => document.body.dataset.screen ?? 'loading')
  .catch(() => 'loading'); // the page is navigating

/** Wait until the app has started; → its screen ('setup', 'home', 'elsewhere' or 'fatal'). */
export async function loaded(page) {
  await expect.poll(() => screen(page), { timeout: LOAD_TIMEOUT, intervals: [100] }).not.toBe('loading');
  return screen(page);
}

export async function openApp(page, url = '/') {
  await page.goto(url);
  return loaded(page);
}

export async function reloadApp(page) {
  await page.reload();
  return loaded(page);
}

/** Wait until a poll has finished (a new neuron's first runs at once, after register); → status().central. */
export async function polled(page) {
  const central = () => page.evaluate(async () => (await window.satori.status()).central).catch(() => null);
  await expect.poll(async () => { const c = await central(); return !!c?.lastPoll && !c.polling; }, { timeout: LOAD_TIMEOUT }).toBe(true);
  return central();
}
