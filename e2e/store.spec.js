// The store module (openStore: self-test + migrations) on OPFS in a worker,
// under the CSP: a write survives a page reload with no clean shutdown.
import { expect, test } from '@playwright/test';
import { MIGRATIONS } from '../src/store/schema.js';

// openStore instantiates DuckDB twice (self-test); give a loaded box room.
test.setTimeout(120_000);

test('store persists settings and observations across a reload', async ({ page }) => {
  await page.goto('/e2e/store/');
  const token = `t${Date.now()}`;
  const first = await page.evaluate((t) => window.store({ cmd: 'write', token: t }), token);
  expect(first.error).toBeUndefined();
  expect(first).toMatchObject({ setting: token, values: [10, 20, 30], version: MIGRATIONS.length });

  await page.reload();
  const second = await page.evaluate((t) => window.store({ cmd: 'read', token: t }), token);
  expect(second.error).toBeUndefined();
  expect(second).toMatchObject({ setting: token, values: [10, 20, 30], version: MIGRATIONS.length });
  expect([...second.violations, ...(await page.evaluate(() => window.violations))]).toEqual([]);
});
