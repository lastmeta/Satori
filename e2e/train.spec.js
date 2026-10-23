// The training pass in Chrome (docs/design/models.md#the-training-pass; docs/intent/engine.md: never rest with work
// pending): a profile whose specs were stored before their scores were (here: cleared through the e2e store page, as a
// version before migration 11 left them) opens to "Scoring models · k of n" on Home and the Models tab, in working
// green, then shows every score and Resting, with no poll and no predictions batch: it trains on stored history only.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, polled, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/alias-parity.json', import.meta.url)));
const v = fx.vectors[2];
const PASS = 'correct horse battery';
const H = 3600;
const nowS = () => Math.floor(Date.now() / 1000);
const NAMES = ['bitcoin', 'eth', 'gold', 'silver', 'oil', 'eur-usd', 'sp500', 'fear-greed'];

/** Central's 8 streams now, each with 600 h of history (bvar for most). */
function streams(stub, t = nowS() - 60) {
  const price = (i, k) => (100 + 10 * i) * (1 + 0.02 * Math.sin(k / (3 + i)) + 0.004 * Math.sin(k * (i + 2)));
  stub.batch = NAMES.map((name, i) => ({ id: 1, observed_at: `${t}.25`, value: String(price(i, 600)), hash: '', stream_id: 1,
    stream: { id: 1, uuid: `u-${name}`, name, meta: null }, ts: '', stream_uuid: `u-${name}` }));
  stub.history = Object.fromEntries(NAMES.map((name, i) => [`u-${name}`, Array.from({ length: 600 }, (_, j) => ({
    id: j, stream_uuid: `u-${name}`, observed_at: `${t - (600 - j) * H}.25`, value: String(price(i, j)), ts: '' }))]));
}

/** Every change of Home's line and the Models tab's status, with the page's clock: window.__seen. */
const RECORD = () => {
  window.__seen = [];
  let last = '';
  const tick = () => {
    const text = (t) => document.querySelector(`[data-test=${t}]`)?.textContent ?? '';
    const r = { hero: text('health-line'), heroTone: document.querySelector('[data-test=health]')?.dataset.tone ?? '',
      engine: `${text('engine-title')} · ${text('engine-line')}`, engineTone: document.querySelector('[data-test=engine]')?.dataset.tone ?? '' };
    const key = JSON.stringify(r);
    if (key !== last && document.body.dataset.screen === 'home') window.__seen.push({ ...r, t: performance.now() });
    last = key;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

test('stored specs with no scores: it scores them on open, without a poll or a submission ("Scoring models", then Resting)', async ({ context, page }) => {
  test.setTimeout(240_000);
  const central = await stubCentral(context);
  streams(central);
  await openApp(page);
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, walletWords: w }), [PASS, v.words]);
  expect((await polled(page)).lastSubmit).toMatchObject({ successful: 8 });
  const scored = (await page.evaluate(() => window.satori.models())).map((m) => [m.name, m.quality]);
  expect(scored.every(([, q]) => q.mark)).toBe(true);
  const polls = central.polls.length;
  const batches = central.batches.length;

  // The app closed; its specs as a version before the scores were kept left them.
  await page.goto('/e2e/store/');
  const r = await page.evaluate(() => window.probe({ cmd: 'raw', path: 'opfs://satori-mvp.duckdb', sql: [
    "SET checkpoint_threshold = '0b'", // as the app writes: each commit straight into the file (storage.md#the-checkpoint-rule)
    'UPDATE model_specs SET score = NULL, persist = NULL, influence = NULL, fit_key = NULL',
    'SELECT count(*) AS n FROM model_specs WHERE score IS NULL', 'CHECKPOINT'] }));
  expect(r.rows?.[2], JSON.stringify(r)).toEqual([{ n: 8 }]);

  // Open it again on the Models tab: no poll is due (the next is 11 h away), and it has work to do.
  await page.addInitScript(RECORD);
  await openApp(page, '/#models');
  await expect(page.locator('[data-test=engine-title]')).toHaveText('Resting', { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=engine-quality]')).not.toContainText('not scored');
  const seen = await page.evaluate(() => window.__seen);
  const scoring = seen.filter((x) => /^Scoring models · \d of 8$/.test(x.hero));
  expect(scoring.length, JSON.stringify(seen)).toBeGreaterThan(0);
  expect(scoring.every((x) => x.heroTone === 'working')).toBe(true); // regular green: working
  const tab = seen.filter((x) => /^Working · Scoring models · \d of 8$/.test(x.engine));
  expect(tab.length, JSON.stringify(seen)).toBeGreaterThan(0);
  expect(tab.every((x) => x.engineTone === 'working')).toBe(true);
  // first scoring, then resting: never "Resting" while it had models to score
  const firstScoring = seen.findIndex((x) => x.engine.startsWith('Working · Scoring'));
  expect(seen.slice(0, firstScoring).some((x) => x.engine.startsWith('Resting'))).toBe(false);
  expect(seen.at(-1).engine).toMatch(/^Resting · Trained just now · next run in (11|10) h$/);

  // every score back, the same as the poll's (the same data), and nothing sent: no poll, no predictions batch
  const again = (await page.evaluate(() => window.satori.models())).map((m) => [m.name, m.quality]);
  expect(again).toEqual(scored);
  expect((await page.evaluate(() => window.satori.status())).train).toMatchObject({ central: 8, stopped: false });
  expect(central.polls.length).toBe(polls);
  expect(central.batches.length).toBe(batches);
  expect(central.prod).toEqual([]);

  // a reload with nothing to do: it rests at once
  await page.reload();
  await expect(page.locator('[data-test=engine-title]')).toHaveText('Resting', { timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(1000);
  expect((await page.evaluate(() => window.__seen)).some((x) => x.engine.startsWith('Working'))).toBe(false);
  expect((await page.evaluate(() => window.satori.status())).train).toBeNull();
});
