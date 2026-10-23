// Retrain in Chrome (docs/design/models.md#retrain): a healthy neuron (staked on a fake chain) on the stub central with 8
// streams and 1,000 hours of history each (central's ~41 days), its worst model opened: Retrain → Stop and a line that counts, Home's hero says it
// in working green, a reload mid-retrain continues where it was, then a result line; never a poll or a predictions
// batch. The page's turns are slowed (a slow phone: scheduler.yield waits `slow` ms) so the run is long enough to see.
// SHOTS=1 writes docs/screenshots/retrain-{running,result}-phone-{light,dark}.png (else the test's output).
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, polled, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/alias-parity.json', import.meta.url)));
const v = fx.vectors[2];
const PASS = 'correct horse battery';
const H = 3600;
const N = 1000;
const nowS = () => Math.floor(Date.now() / 1000);
const ROUND = Math.floor(Date.now() / 1000 / 86400);

function normals(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
}

/** N + 1 hourly values per stream: random walks, eth trailing bitcoin by 12 hours, a slow cycle, noise. */
function market() {
  const n = normals(23);
  const walk = (p0, sd) => { const x = [p0]; for (let k = 1; k <= N; k++) x.push(x.at(-1) * (1 + sd * n())); return x; };
  const bitcoin = walk(81_570, 0.006);
  return {
    bitcoin,
    eth: bitcoin.map((_, k) => 3412 * (bitcoin[Math.max(0, k - 12)] / bitcoin[0]) * (1 + 0.001 * n())),
    gold: Array.from({ length: N + 1 }, (_, k) => 2684.3 * (1 + 0.02 * Math.sin(k / 30) + 0.0002 * k + 0.0005 * n())),
    silver: walk(31.2, 0.008),
    oil: walk(71.4, 0.01),
    'eur-usd': walk(1.084, 0.002),
    sp500: walk(5810, 0.004),
    xrp: walk(0.52, 0.012),
  };
}

function centralAt(stub, t) {
  const prices = market();
  const names = Object.keys(prices);
  stub.batch = names.map((name) => ({ id: 1, observed_at: `${t}.25`, value: String(prices[name][N]), hash: '', stream_id: 1,
    stream: { id: 1, uuid: `u-${name}`, name, meta: null }, ts: '', stream_uuid: `u-${name}` }));
  stub.history = Object.fromEntries(names.map((name) => [`u-${name}`, Array.from({ length: N }, (_, j) => ({
    id: j, stream_uuid: `u-${name}`, observed_at: `${t - (N - j) * H}.25`, value: String(prices[name][j]), ts: '' }))]));
}

/** A slow phone: while sessionStorage `slow` is set, each of the page's turns (scheduler.yield) waits that many ms. */
const SLOW = () => {
  const y = globalThis.scheduler?.yield?.bind(globalThis.scheduler);
  if (y) globalThis.scheduler.yield = () => { const ms = Number(sessionStorage.getItem('slow') || 0); return ms ? new Promise((r) => setTimeout(r, ms)) : y(); };
};
/** Every change of Home's hero, the drill-in's Retrain button and line: window.__seen. */
const RECORD = () => {
  window.__seen = [];
  let last = '';
  const tick = () => {
    const el = (t) => document.querySelector(`[data-test=${t}]`);
    const r = { hero: el('health-line')?.textContent ?? '', heroTone: el('health')?.dataset.tone ?? '',
      button: el('model-retrain')?.hidden ? '' : el('model-retrain')?.textContent ?? '',
      line: el('model-retrain-line')?.hidden ? '' : el('model-retrain-line')?.textContent ?? '' };
    const key = JSON.stringify(r);
    if (key !== last && document.body.dataset.screen === 'home') window.__seen.push({ ...r, t: performance.now() });
    last = key;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function shot(page, name) {
  const dir = process.env.SHOTS ? 'docs/screenshots' : test.info().outputPath();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${dir}/retrain-${name}-phone-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('Retrain: Stop and a counting line, Home\'s hero, a reload mid-retrain continues, then a result; never a submission', async ({ context, page }) => {
  test.setTimeout(300_000);
  const { s, rpc } = fakeSatori({ round: ROUND, hour: 9 });
  const central = await stubCentral(context, { rpc });
  // the latest observation 30 min before the end of a 12 h bucket: the same buckets (and models) on every run
  const STEP = 12 * H;
  const t = Math.floor((nowS() - 60 + STEP / 2) / STEP) * STEP - STEP / 2 - 1800;
  centralAt(central, t);
  await context.addInitScript(SLOW);
  await context.addInitScript(RECORD);
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openApp(page);
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, walletWords: w }), [PASS, v.words]);
  expect((await polled(page)).lastSubmit).toMatchObject({ successful: 8 });
  // staked, its batch sent: all is well, so the hero's tone is its work's
  const st = await page.evaluate(() => window.satori.base());
  rpc.eth[st.alias.address.toLowerCase()] = 10n ** 17n;
  rpc.eth[st.wallet.address.toLowerCase()] = 10n ** 17n;
  s.balance[st.wallet.address.toLowerCase()] = 100n * E18;
  await page.evaluate((p) => window.satori.unlock(p), PASS);
  await page.evaluate(() => window.satori.stake());
  await page.evaluate(() => window.satori.predictBase());
  await page.evaluate(() => window.satori.lock());
  await expect.poll(async () => (await page.evaluate(() => window.satori.health())).status).toBe('ok');
  const polls = central.polls.length;
  const batches = central.batches.length;

  // the worst model that Retrain is offered on
  const offered = [];
  for (const m of await page.evaluate(() => window.satori.models())) {
    const d = await page.evaluate((id) => window.satori.model(id), m.id);
    if (d.retrain.available) offered.push({ id: m.id, name: m.name, ratio: m.quality.ratio ?? 1, mark: m.quality.mark });
  }
  expect(offered.length).toBe(8); // every stream has ~41 days of history
  const worst = offered.sort((a, b) => b.ratio - a.ratio)[0];
  const uuid = worst.id.slice('central:'.length);

  await page.evaluate((id) => window.satori.go(`models/${id}`), worst.id);
  const button = page.locator('[data-test=model-retrain]');
  const line = page.locator('[data-test=model-retrain-line]');
  await expect(button).toHaveText('Retrain', { timeout: LOAD_TIMEOUT });
  if (worst.mark !== 'better') await expect(button).toHaveClass(/primary/); // worse than no change or the same: the accent
  await expect(line).toBeHidden();
  const box = await button.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeGreaterThan(300); // top right, on a 390 px phone
  expect(box.y).toBeLessThan(200);

  // Retrain: Stop, and a line that counts
  await page.evaluate(() => sessionStorage.setItem('slow', '1000'));
  await button.click();
  await expect(button).toHaveText('Stop');
  await expect(line).toHaveText(/^Retraining · tried \d+ · best so far (\d+% (better|worse)|the same as no change)$/, { timeout: 20_000 });
  const tried = async () => (await page.evaluate((id) => window.satori.model(id), worst.id)).retrain.tried;
  const t1 = await tried();
  await expect.poll(tried, { timeout: 20_000 }).toBeGreaterThan(t1);
  expect((await page.evaluate((id) => window.satori.model(id), worst.id)).retrain).toMatchObject({ available: true, running: true, waiting: null });
  await shot(page, 'running');

  // Home's hero says it, in working green
  await page.evaluate(() => window.satori.go('home'));
  await expect(page.locator('[data-test=health-line]')).toHaveText(new RegExp(`^Keep Satori open · Retraining ${worst.name}( · tried \\d+|…)$`)); // a phone
  await expect(page.locator('[data-test=health]')).toHaveAttribute('data-tone', 'working');
  const heroes = (await page.evaluate(() => window.__seen)).filter((x) => x.hero.includes('Retraining'));
  expect(heroes.every((x) => x.heroTone === 'working')).toBe(true);

  // a reload mid-retrain: it continues where it was (the place it keeps every 2 s), not from the start
  const keptOf = () => page.evaluate(async (u) => {
    const r = (await window.satori.streams()).find((x) => x.uuid === u);
    return r?.retrain ? JSON.parse(r.retrain) : null;
  }, uuid);
  await expect.poll(async () => (await keptOf())?.state?.tried ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  const kept = await keptOf();
  expect(kept).toMatchObject({ n: 1, status: 'running' });
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.body.dataset.screen ?? 'loading'), { timeout: LOAD_TIMEOUT }).toBe('home');
  await page.evaluate((id) => window.satori.go(`models/${id}`), worst.id);
  await expect(button).toHaveText('Stop', { timeout: LOAD_TIMEOUT });
  const resumed = (await page.evaluate((id) => window.satori.model(id), worst.id)).retrain;
  expect(resumed.running).toBe(true);
  expect(resumed.tried).toBeGreaterThanOrEqual(kept.state?.tried ?? 0); // from its kept place

  // then a result line, and the button is Retrain again
  await page.evaluate(() => sessionStorage.removeItem('slow'));
  await expect(button).toHaveText('Retrain', { timeout: 120_000 });
  await expect(line).toBeVisible();
  const done = (await page.evaluate((id) => window.satori.model(id), worst.id)).retrain;
  expect(done).toMatchObject({ running: false, result: { n: 1, outcome: expect.any(String), kept: expect.stringMatching(/^(new|current)$/) } });
  expect(done.result.tried).toBeGreaterThan(resumed.tried - 1);
  await expect(line).toHaveText(/^(Found one: \d+% better\. Used from the next prediction\.|Couldn't find a model that beats no change\. Kept (the current one\.|a closer one: .+\. Used from the next prediction\.)|Couldn't find a better model\. Kept the current one\.)$/);
  const seen = await page.evaluate(() => window.__seen);
  expect(seen.some((x) => /^Retraining · tried \d+/.test(x.line) && x.button === 'Stop')).toBe(true);
  expect(seen.at(-1).button).toBe('Retrain');
  await shot(page, 'result');
  console.log('[e2e] retrain', worst.name, JSON.stringify(done.result));

  // a new champion is stored as evolution stores one; none is used before the next observation: no prediction made
  const row = await page.evaluate(async (u) => (await window.satori.streams()).find((x) => x.uuid === u), uuid);
  if (done.result.kept === 'new') {
    expect(JSON.parse(row.spec)).toEqual(done.result.spec);
    expect(row.generation).toBeGreaterThan(0);
  }
  expect(await page.evaluate((u) => window.satori.predictions(u, 9).then((p) => p.length), uuid)).toBe(1);

  // the same data again: refused with a note when it looked (one look per observation)
  if (done.result.looked) {
    await button.click();
    await expect(line).toHaveText('Already retrained on this data. Try again after its next observation.');
    await expect(button).toHaveText('Retrain');
  }

  // never a poll, never a predictions batch, never prod; and the page never threw
  expect(errors).toEqual([]);
  expect(central.polls.length).toBe(polls);
  expect(central.batches.length).toBe(batches);
  expect(central.prod).toEqual([]);
});
