// Loading the app takes seconds (DuckDB-WASM's 34 MB wasm, then OPFS), more on
// a busy box: every spec opens and reloads it through these, which wait until
// the page has left "Opening…" (status().screen), up to 30 s.
import { expect } from '@playwright/test';

export const LOAD_TIMEOUT = 30_000;

const screen = (page) => page.evaluate(async () => (window.satori ? (await window.satori.status()).screen : 'loading'))
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
