// The new layout of Streams and Market (src/ui/layout.js), on the test relay 7781: a seller follows a provider's stream,
// predicts it and Sells it from its row on Streams (the default price, nothing typed); a buyer finds it under Streams ›
// Find streams › For sale, its price and Buy in the row (not bought here: no chain); the seller's Market lists it under
// Selling; the switch goes back to the current layout. Screenshots of each in the test's output (SHOTS=1: docs/screenshots/layout-*).
import { expect, test } from '@playwright/test';
import { connectProvider } from '../scripts/provider.mjs';
import { openApp, loaded, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const RELAY = 'ws://localhost:7781';
const shot = (page, name) => page.screenshot({ fullPage: true, path: process.env.SHOTS ? `docs/screenshots/${name}.png` : test.info().outputPath(`${name}.png`) });

async function neuron(browser, layout) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await stubCentral(context);
  await context.addInitScript((v) => { if (!sessionStorage.getItem('picked')) { localStorage.setItem('satori_layout', v); sessionStorage.setItem('picked', '1'); } }, layout);
  const page = await context.newPage();
  await openApp(page);
  const s = await page.evaluate(() => window.satori.setup({ passphrase: 'correct horse battery' }));
  await expect(page.locator('[data-test=alias]')).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: LOAD_TIMEOUT });
  await page.evaluate((u) => window.satori.setRelays({ relays: [u] }), RELAY);
  return { context, page, nostr: s.nostr.pubkey };
}

test('the new layout: follow, predict and Sell on Streams; find it For sale and Buy on Streams; Market is the money', async ({ browser }) => {
  test.setTimeout(300_000);
  const provider = await connectProvider({ url: RELAY });
  const stream = `walk-${Date.now().toString(36)}`;
  const pred = `${stream}_pred`;
  await provider.announce({ stream, name: 'Test walk', cadence: 6 });
  let seq = 0;
  const tick = setInterval(() => provider.observe({ stream, value: String(100 + (seq % 5)), seq: ++seq }).catch(() => {}), 6000);
  try {
    const seller = await neuron(browser, 'new');
    const s = seller.page;
    await s.evaluate(() => window.satori.go('streams'));
    await expect(s.locator('.tab-page:visible [data-test=layout-new]')).toHaveAttribute('aria-pressed', 'true');

    // found under Find streams, followed with Subscribe, predicted with Predict
    await s.getByLabel('Search streams').fill(stream);
    const found = s.locator('[data-test=find-streams] [data-test=catalog-row]', { hasText: 'Test walk' });
    await expect(found.locator('[data-test=catalog-action]')).toHaveText('Subscribe', { timeout: 30_000 });
    await found.locator('[data-test=catalog-action]').click();
    const row = s.locator('[data-test=your-streams] [data-test=sub]', { hasText: 'Test walk' });
    await expect(row.locator('[data-test=sub-predict]')).toHaveText('Predict', { timeout: 30_000 });
    await row.locator('[data-test=sub-predict]').click();
    await expect(row.locator('[data-test=sub-predict]')).toHaveText('Predicting', { timeout: 30_000 });

    // Sell from the row, nothing typed: the default price
    await expect(row.locator('[data-test=sell-price]')).toHaveAttribute('placeholder', '0.00001');
    await row.locator('[data-test=sell]').click();
    await expect(row.locator('[data-test=sell-state]')).toContainText('0.00001 SATORI each', { timeout: 30_000 });
    await shot(s, 'layout-new-streams-seller');

    await s.evaluate(() => window.satori.go('market'));
    await expect(s.locator(`[data-test=market-sales] [data-test=sell-row][data-stream="${pred}"]`)).toContainText('No buyers yet');
    await shot(s, 'layout-new-market-seller');

    // the buyer: Market › Find streams for sale opens Streams on For sale; its price and Buy in the row
    const buyer = await neuron(browser, 'new');
    const b = buyer.page;
    await b.evaluate(() => window.satori.go('market'));
    await b.locator('[data-test=market-find]').click();
    await expect(b.locator('[data-test=find-sale]')).toHaveAttribute('aria-pressed', 'true');
    await b.getByLabel('Search streams').fill(stream); // the relay keeps earlier runs' streams for sale
    const item = b.locator('[data-test=find-streams] [data-test=catalog-row]', { hasText: pred });
    await expect(async () => { // announced with its first prediction: Refresh until the relays have it
      if (!(await item.count())) await b.locator('[data-test=find-streams] button[type=submit]').click();
      await expect(item.locator('[data-test=catalog-price]')).toHaveText('0.00001 SATORI each', { timeout: 5000 });
    }).toPass({ timeout: 90_000 });
    await expect(item.locator('[data-test=buy]')).toHaveText('Buy');
    await shot(b, 'layout-new-streams-buyer');

    // Predictors: the track records, in the same card
    await b.locator('[data-test=find-predictors]').click();
    await expect(b.locator('[data-test=find-streams] [data-test=records]')).toBeVisible();
    await expect(b.locator('[data-test=find-streams] [data-test=catalog-row]').first()).toBeHidden();

    // back to the current layout: the switch reloads into it
    await s.locator('.tab-page:visible [data-test=layout-current]').click();
    await loaded(s);
    await expect(s.locator('.tab-page:visible [data-test=layout-current]')).toHaveAttribute('aria-pressed', 'true', { timeout: LOAD_TIMEOUT });
    await expect(s.locator('[data-test=market-for-sale]')).toBeVisible();
    await shot(s, 'layout-current-market-seller');
    await s.evaluate(() => window.satori.go('streams'));
    await shot(s, 'layout-current-streams-seller');
    await seller.context.close();
    await buyer.context.close();
  } finally {
    clearInterval(tick);
    provider.close?.();
  }
});
