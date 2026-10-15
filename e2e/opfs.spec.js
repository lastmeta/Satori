// Smoke: DuckDB-WASM 1.32.0 on opfs://satori.duckdb inside a dedicated module
// worker, under the production CSP sent as an HTTP header (storage.md, ui.md).
import { expect, test } from '@playwright/test';
import { CSP } from '../csp.js';

test('DuckDB writes OPFS in a worker, reopens and reads, under the CSP', async ({ page }) => {
  const responses = [];
  page.on('response', (r) => responses.push(r));
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

  await page.goto('/e2e/opfs/');
  const token = `t${Date.now()}`;
  const first = await page.evaluate((t) => window.probe({ cmd: 'roundtrip', token: t }), token);
  expect(first.error).toBeUndefined();
  expect(first.readAfterReopen).toBe(token);
  expect(first.autoload).toBe(false);

  // A new page load (new workers, new DuckDB instance) still sees the row.
  await page.reload();
  const second = await page.evaluate(() => window.probe({ cmd: 'read' }));
  expect(second.error).toBeUndefined();
  expect(second.values).toContain(token);

  // Every script and wasm involved carried the CSP header.
  const urls = (re) => responses.filter((r) => re.test(r.url()));
  for (const re of [/\/e2e\/opfs\/$/, /\/e2e\/opfs\/worker\.js/, /duckdb-browser-eh\.worker\.js/, /duckdb-eh\.wasm/]) {
    const hits = urls(re);
    expect(hits.length, String(re)).toBeGreaterThan(0);
    for (const r of hits) expect(await r.headerValue('content-security-policy'), `${r.status()} ${r.url()}`).toBe(CSP);
  }
  const violations = await page.evaluate(() => window.violations);
  expect(violations).toEqual([]);
  expect(consoleErrors.filter((t) => /Content.Security.Policy/i.test(t))).toEqual([]);
});

test('app page says Satori and its module worker runs under the CSP', async ({ page }) => {
  const res = await page.goto('/');
  expect(res.headers()['content-security-policy']).toBe(CSP);
  await expect(page.locator('h1')).toHaveText('Satori');
  await expect(page.locator('body')).toHaveAttribute('data-worker', 'ready');
});
