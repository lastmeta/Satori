// The track record in Chrome (docs/design/track-record.md), against the test relays (scripts/test-relay.mjs): 7782
// plays central's relay (read only on the dev server) and 7781 the user's. A provider publishes a stream every 6 s on
// 7782; three predictors announce its `_pred` (as Lite names it) and publish 0.3 s after each observation, as a Lite
// neuron does (well inside the lead: the first half of the interval after the baseline arrived): one most of the way to
// the next value, one the wrong way, one only twice. The provider predicts its own stream too. A cheat "predicts" a
// stream it publishes under a second key, never announced, with the same id, and calls it "Predictions for Test walk".
// A fresh neuron finds them on its own (no Discover, no Subscribe), follows them, scores what it received before each
// outcome and shows them on Streams grouped by source: the real Test walk first, the cheat's unannounced source after
// it, named by its id, its author in view; a backdated prediction received after its outcome is not scored; nothing
// is published for watching. SHOTS=1 writes docs/screenshots/streams-records-*.png.
import { expect, test } from '@playwright/test';
import WebSocket from 'ws';
import { connectProvider } from '../scripts/provider.mjs';
import { createRelay } from '../src/nostr/relay.js';
import { openApp } from './load.js';
import { stubCentral } from './stub.js';

const CENTRAL_RELAY = 'ws://localhost:7782';
const USER_RELAY = 'ws://localhost:7781';
const PASS = 'correct horse battery';
// 6 s: the lead rule allows half an interval after the baseline arrived, and arrivals are whole seconds rounded up, so a
// 4 s interval stamped in whole seconds (3–5 s) leaves 1.5 s for a prediction 0.6 s late plus a second of rounding
const CADENCE = 6;
const CYCLES = 9;

async function reader(url) {
  const r = createRelay(url, { WebSocket });
  r.connect();
  await expect.poll(() => r.state).toBe('open');
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watching = (page) => page.evaluate(async () => (await window.satori.nostr()).watching);

test('every prediction stream watched on its own and scored by what this neuron received before the outcome; shown on Streams', async ({ context, page }) => {
  test.setTimeout(240_000);
  await stubCentral(context, { relays: [CENTRAL_RELAY] });
  const stream = `rec-${Date.now().toString(36)}`;
  const provider = await connectProvider({ url: CENTRAL_RELAY });
  await provider.announce({ stream, name: 'Test walk', cadence: CADENCE });
  const source = { pubkey: provider.pubkey, stream };
  const good = await connectProvider({ url: CENTRAL_RELAY });
  const wrong = await connectProvider({ url: CENTRAL_RELAY });
  const few = await connectProvider({ url: CENTRAL_RELAY });
  for (const p of [good, wrong, few, provider]) await p.announcePred({ source, name: 'Predictions for Test walk', cadence: CADENCE });
  const cheat = await connectProvider({ url: CENTRAL_RELAY });
  const fake = await connectProvider({ url: CENTRAL_RELAY }); // the cheat's second key: never announced
  await cheat.announcePred({ source: { pubkey: fake.pubkey, stream }, name: 'Predictions for Test walk', cadence: CADENCE });

  await openApp(page);
  const s0 = await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  const me = s0.nostr.pubkey;
  await page.evaluate((u) => window.satori.setRelays({ relays: [u] }), USER_RELAY);
  // the scan at the first open found the five (and the two sources) with no Discover and no Subscribe
  await expect.poll(async () => (await watching(page))?.streams, { timeout: 60_000 }).toBeGreaterThanOrEqual(5);
  const mine = (await page.evaluate(() => window.satori.records())).filter((r) => r.source.stream === stream);
  expect(mine.map((r) => r.pubkey).sort()).toEqual([good.pubkey, wrong.pubkey, few.pubkey, provider.pubkey, cheat.pubkey].sort());
  expect(mine.every((r) => r.markText === 'Not scored yet' && !r.mine)).toBe(true);
  // the cheat's source is named by its id, not by the cheat's "Test walk"; its author shown, not announced
  expect(mine.find((r) => r.pubkey === cheat.pubkey)).toMatchObject({ sameAuthor: false,
    source: { pubkey: fake.pubkey, stream, name: stream, announced: false } });
  expect(mine.find((r) => r.pubkey === good.pubkey)).toMatchObject({ sameAuthor: false,
    source: { pubkey: provider.pubkey, stream, name: 'Test walk', announced: true } });
  expect(mine.find((r) => r.pubkey === provider.pubkey).sameAuthor).toBe(true);
  await sleep(1000); // the follow REQ with them on its way to the relay

  // the walk, drawn a step ahead; each prediction a moment after the observation it follows
  const values = [100];
  for (let k = 1; k <= CYCLES; k++) values.push(Number((values[k - 1] + (k % 3 ? 1.5 : -1)).toFixed(2)));
  const fakes = values.map((v, k) => 50 + (k % 2 ? 2 : -1) * k); // the cheat's own stream: it knows every next value
  for (let k = 0; k < CYCLES; k++) {
    const t = Date.now();
    await provider.observe({ stream, value: String(values[k]), seq: k + 1 });
    await fake.observe({ stream, value: String(fakes[k]), seq: k + 1 });
    await sleep(300);
    const move = values[k + 1] - values[k];
    await good.observe({ stream: `${stream}_pred`, value: String(values[k] + 0.75 * move), seq: k + 1 });
    await wrong.observe({ stream: `${stream}_pred`, value: String(values[k] - move), seq: k + 1 });
    if (k < 2) await few.observe({ stream: `${stream}_pred`, value: String(values[k]), seq: k + 1 });
    await provider.observe({ stream: `${stream}_pred`, value: String(values[k] + move), seq: k + 1 }); // its own: exact
    await cheat.observe({ stream: `${stream}_pred`, value: String(fakes[k + 1]), seq: k + 1 });
    await sleep(CADENCE * 1000 - (Date.now() - t));
  }
  await provider.observe({ stream, value: String(values[CYCLES]), seq: CYCLES + 1 }); // the last prediction's outcome
  await fake.observe({ stream, value: String(fakes[CYCLES]), seq: CYCLES + 1 });
  const scoredOf = async (pubkey) => (await page.evaluate(([p, s]) => window.satori.record(p, s), [pubkey, `${stream}_pred`]))?.scored;
  // the honest predictors, 0.3 s after each observation, pass the lead rule: every outcome scored
  await expect.poll(() => scoredOf(good.pubkey), { timeout: 30_000 }).toBe(CYCLES);
  await expect.poll(() => scoredOf(cheat.pubkey), { timeout: 30_000 }).toBe(CYCLES);

  // a backdated prediction: it claims the time of the third observation, and arrives long after its outcome
  const late = Math.floor(Date.now() / 1000) - (CYCLES - 2) * CADENCE;
  await good.observe({ stream: `${stream}_pred`, value: String(values[3]), seq: 50, timestamp: late });
  await sleep(1500);
  const rec = await page.evaluate(([p, s]) => window.satori.record(p, s), [good.pubkey, `${stream}_pred`]);
  expect(rec).toMatchObject({ received: CYCLES + 1, scored: CYCLES, mark: 'better', ratio: expect.closeTo(0.25, 9), markText: '75% better',
    direction: { right: CYCLES, total: CYCLES } });
  expect(rec.pairs.map((x) => x.actual)).toEqual(values.slice(1)); // the backdated one is not among them
  expect(rec.pairs[0]).toEqual({ ts: expect.any(Number), predicted: 100 + 0.75 * 1.5, actual: 101.5, baseline: 100 });
  const all = (await page.evaluate(() => window.satori.records())).filter((r) => r.source.stream === stream);
  expect(all.map((r) => [r.pubkey, r.markText, r.scored]).slice(2)).toEqual([[good.pubkey, '75% better', CYCLES],
    [wrong.pubkey, '100% worse', CYCLES], [few.pubkey, 'Not scored yet', 2]]); // best first
  expect(all.slice(0, 2).map((r) => [r.pubkey, r.markText, r.scored]).sort()).toEqual([[provider.pubkey, '100% better', CYCLES],
    [cheat.pubkey, '100% better', CYCLES]].sort()); // both exact: the provider knows its own next value, the cheat its second key's

  // Streams › Prediction streams, grouped by source: Test walk (announced) first, the cheat's unannounced one after it
  await page.evaluate(() => window.satori.go('streams'));
  const card = page.locator('[data-test=records]');
  await expect(card.locator('[data-test=records-status]')).toContainText(/Watching \d+ prediction streams · \d+ with a record/);
  const group = (pubkey) => card.locator(`[data-test=record-source][data-key="${pubkey}:${stream}"]`);
  const real = group(provider.pubkey);
  await expect(real.locator('[data-test=record-source-name]')).toHaveText('Test walk');
  await expect(real.locator('[data-test=record-source-by]')).toHaveText(`by ${provider.pubkey.slice(0, 8)}…${provider.pubkey.slice(-4)}`);
  await expect(real.locator('[data-test=record-source-note]')).toHaveCount(0);
  const unannounced = group(fake.pubkey);
  await expect(unannounced.locator('[data-test=record-source-name]')).toHaveText(stream);
  await expect(unannounced.locator('[data-test=record-source-by]')).toHaveText(`by ${fake.pubkey.slice(0, 8)}…${fake.pubkey.slice(-4)}`);
  await expect(unannounced.locator('[data-test=record-source-note]')).toHaveText('not announced');
  const keys = await card.locator('[data-test=record-source]').evaluateAll((els) => els.map((e) => e.dataset.key));
  expect(keys.indexOf(`${provider.pubkey}:${stream}`)).toBeLessThan(keys.indexOf(`${fake.pubkey}:${stream}`));
  const row = (pubkey) => card.locator(`[data-test=record][data-key="${pubkey}:${stream}_pred"]`);
  await expect(real.locator('[data-test=record]')).toHaveCount(4);
  await expect(real.locator('[data-test=record-mark]')).toHaveText(['100% better', '75% better', '100% worse', 'Not scored yet']);
  await expect(row(provider.pubkey).locator('[data-test=record-own]')).toHaveText('predicts its own stream');
  await expect(row(good.pubkey).locator('[data-test=record-own]')).toHaveCount(0);
  await expect(row(good.pubkey).locator('[data-test=record-by]')).toHaveText(`${good.pubkey.slice(0, 8)}…${good.pubkey.slice(-4)}`);
  await expect(row(good.pubkey).locator('[data-test=record-from]')).toHaveText(`from ${CYCLES}`);
  await expect(row(wrong.pubkey).locator('[data-test=record-mark]')).toHaveText('100% worse');
  await expect(row(few.pubkey).locator('[data-test=record-mark]')).toHaveText('Not scored yet');
  await expect(row(few.pubkey).locator('[data-test=record-from]')).toHaveText('2 of 5');
  await expect(unannounced.locator('[data-test=record-mark]')).toHaveText(['100% better']);
  const dir = process.env.SHOTS ? 'docs/screenshots' : test.info().outputPath();
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${dir}/streams-records-phone-light.png` });
  await row(good.pubkey).locator('button.rrow').click();
  const detail = row(good.pubkey).locator('[data-test=record-detail]');
  await expect(detail).toContainText('75% less error than no change');
  await expect(detail).toContainText(`Right way ${CYCLES} of ${CYCLES}`);
  await expect(detail.locator('[data-test=record-note]')).toHaveText(/^Seen by this neuron since .+\. It counts only predictions this neuron received before the outcome\.$/);
  await expect(detail.locator('.rchart path.ra')).toHaveAttribute('d', /^M0\.0 /);
  await expect(detail.locator('[data-test=record-source-line]')).toHaveText(`Source: Test walk (${stream}) by ${provider.pubkey.slice(0, 8)}…${provider.pubkey.slice(-4)}`);
  await page.setViewportSize({ width: 390, height: 2400 }); // tall, so the phone's tab bar is not over the card
  await card.screenshot({ path: `${dir}/streams-record-detail-phone-light.png` });
  await row(cheat.pubkey).locator('button.rrow').click(); // the cheat's: its source not announced, its author in view
  await expect(row(cheat.pubkey).locator('[data-test=record-source-line]'))
    .toHaveText(`Source: ${stream} by ${fake.pubkey.slice(0, 8)}…${fake.pubkey.slice(-4)}, not announced`);
  await page.setViewportSize({ width: 390, height: 844 });

  // watching published nothing: nothing of ours on central's relay (read only), and only NIP-65 on ours (no 34602)
  const c = await reader(CENTRAL_RELAY);
  expect(await c.fetch([{ authors: [me] }])).toEqual([]);
  const u = await reader(USER_RELAY);
  expect((await u.fetch([{ authors: [me] }])).map((e) => e.kind)).toEqual([10002]);
  for (const p of [provider, good, wrong, few, cheat, fake, c, u]) p.close();
});
