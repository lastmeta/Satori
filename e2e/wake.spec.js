// The device sleeps with the page open (docs/plans/runtime.md#catch-up-pass): the wall clock jumps and browser timers
// don't count the sleep, so the 11 h poll's timer has not fired. The catch-up pass on the 30 s heartbeat runs it, and
// Home says "Catching up now…" only while it runs. The jump is a Date skewed in the page (its timers stay real).
import { expect, test } from '@playwright/test';
import { openApp, polled, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';
import { fakeSatori } from '../test/fake-satori.js';

const H = 3600;
const NAMES = ['bitcoin', 'eth', 'gold', 'silver'];
const nowS = () => Math.floor(Date.now() / 1000);

/** Central's latest observation of each stream at `t`, and 300 hours of history before it. */
function centralAt(stub, t) {
  const price = (i, k) => (100 + 10 * i) * (1 + 0.02 * Math.sin(k / (3 + i)));
  stub.batch = NAMES.map((name, i) => ({ id: 1, observed_at: `${t}.25`, value: String(price(i, t % 97)), hash: '', stream_id: 1,
    stream: { id: 1, uuid: `u-${name}`, name, meta: null }, ts: '', stream_uuid: `u-${name}` }));
  stub.history ??= Object.fromEntries(NAMES.map((name, i) => [`u-${name}`, Array.from({ length: 300 }, (_, j) => ({
    id: j, stream_uuid: `u-${name}`, observed_at: `${t - (300 - j) * H}.25`, value: String(price(i, j)), ts: '' }))]));
}

/** window.__skew(ms): Date (and so Date.now()) runs that far ahead; setTimeout and setInterval are untouched. */
function skewableDate() {
  const Real = Date;
  let off = 0;
  class Skewed extends Real {
    constructor(...a) { if (a.length === 0) super(Real.now() + off); else super(...a); }
    static now() { return Real.now() + off; }
  }
  window.Date = Skewed;
  window.__skew = (ms) => { off = ms; };
}

test('asleep 12 h with the page open: the poll runs within one heartbeat; "Catching up now…" only while it runs', async ({ context, page }) => {
  test.setTimeout(240_000);
  const stub = await stubCentral(context, { rpc: fakeSatori({ round: Math.floor(nowS() / 86400), hour: 9 }).rpc });
  stub.noVaultBase = true;
  centralAt(stub, nowS() - 60);
  await context.addInitScript(skewableDate);
  await openApp(page);
  await page.evaluate(() => window.satori.setup({ passphrase: 'correct horse battery' }));
  await polled(page);
  expect(stub.batches).toHaveLength(1);
  const first = await page.evaluate(async () => (await window.satori.status()).central.nextPoll);

  // the device sleeps 12 h: the 11 h poll is overdue, and its timer will not fire for hours
  centralAt(stub, nowS() - 30); // a new observation per stream meanwhile
  const slept = Date.now();
  await page.evaluate((ms) => window.__skew(ms), 12 * H * 1000);
  const samples = [];
  await expect.poll(async () => {
    samples.push(await page.evaluate(async () => {
      const h = await window.satori.health();
      return { line: h.line, chip: h.channels.network.text, work: h.work?.task ?? null, polling: (await window.satori.status()).central.polling };
    }));
    return stub.polls.length;
  }, { timeout: 40_000, intervals: [250] }).toBe(2);
  const waited = (Date.now() - slept) / 1000;
  expect(waited).toBeLessThanOrEqual(32); // one heartbeat (30 s), and the page's reply
  console.log(`the catch-up poll began ${waited.toFixed(1)} s after the 12 h jump (the heartbeat is 30 s)`);

  const c = await polled(page);
  expect(stub.batches).toHaveLength(2); // the new observations, forecast and sent
  expect(c.nextPoll).toBeGreaterThan(first + 12 * H); // 11 h on from the catch-up, on the skewed clock
  const h = await page.evaluate(() => window.satori.health());
  expect(h).toMatchObject({ title: 'Predicting', line: 'Closed for 12 h. Caught up just now.' });
  expect(h.feed.map((f) => f.text)).toEqual(expect.arrayContaining(['Satori was closed for 12 h', 'Caught up: sent 4 predictions']));
  // "Catching up now…" was said only while central's work ran; before that, never
  for (const s of samples.filter((x) => /Catching up now/.test(`${x.line} ${x.chip}`))) expect(s.work === 'central' || s.polling).toBe(true);
  expect(stub.prod).toEqual([]);
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting', { timeout: LOAD_TIMEOUT });
});
