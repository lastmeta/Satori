// DuckDB-WASM on OPFS under the CSP: a write survives a page reload with no
// clean shutdown.
import { expect, test } from '@playwright/test';
import { MIGRATIONS } from '../src/db/schema.js';

test('db persists meta and observations on OPFS across a reload', async ({ page }) => {
  await page.goto('/e2e/store/');
  const token = `t${Date.now()}`;
  const first = await page.evaluate((t) => window.probe({ cmd: 'write', token: t }), token);
  expect(first).toEqual({ setting: token, values: [10, 20, 30], version: MIGRATIONS.length, recovered: null });

  await page.reload();
  const second = await page.evaluate((t) => window.probe({ cmd: 'read', token: t }), token);
  expect(second).toEqual({ setting: token, values: [10, 20, 30], version: MIGRATIONS.length, recovered: null });
  expect(await page.evaluate(() => window.violations)).toEqual([]);
});
