// The Models tab (docs/design/models.md) in Chrome: a neuron with central's 8 streams (600 hours of history each, so
// most models are bvar), staked on a fake chain (its Base batch: a model per registry stream) and subscribed to a
// stream on a test relay (its `_pred`: a Network model). The engine's status, the list, filter and sort, a model's
// drill-in (#models/<id>) and back, a deep link, the agent API, the phone's width (nothing scrolls sideways, tap
// targets of 44 px), and the screenshots (SHOTS=1 writes them to docs/screenshots/models-*.png; else to the test's output).
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { connectProvider } from '../scripts/provider.mjs';
import { openApp, polled, reloadApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/identity-parity.json', import.meta.url)));
const v = fx.vectors[2];
const PASS = 'correct horse battery';
const H = 3600;
const ROUND = Math.floor(Date.now() / 1000 / 86400);
const nowS = () => Math.floor(Date.now() / 1000);
const CENTRAL_RELAY = 'ws://localhost:7782';
const USER_RELAY = 'ws://localhost:7781';

/** mulberry32 → normal draws: repeatable series. */
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

/**
 * 601 hourly values per stream, each its own kind of series: random walks (no change is hard to beat), eth trailing
 * bitcoin by 12 hours (a companion that leads), a slow cycle, a mean-reverting index.
 */
function market() {
  const n = normals(11);
  const walk = (p0, sd) => { const x = [p0]; for (let k = 1; k < 601; k++) x.push(x.at(-1) * (1 + sd * n())); return x; };
  const bitcoin = walk(81_570, 0.006);
  return {
    bitcoin,
    eth: bitcoin.map((_, k) => 3412 * (bitcoin[Math.max(0, k - 12)] / bitcoin[0]) * (1 + 0.001 * n())),
    gold: Array.from({ length: 601 }, (_, k) => 2684.3 * (1 + 0.02 * Math.sin(k / 30) + 0.0002 * k + 0.0005 * n())),
    silver: walk(31.2, 0.008),
    oil: walk(71.4, 0.01),
    'eur-usd': walk(1.084, 0.002),
    sp500: Array.from({ length: 601 }, (_, k) => 5810 * (1 + 0.0001 * k + 0.003 * n())),
    'fear-greed': Array.from({ length: 601 }, () => 54 + 8 * n()),
  };
}

/** Central's latest observation of each stream at `t`, with 600 hours of history before it. */
function centralAt(stub, t) {
  const prices = market();
  const names = Object.keys(prices);
  stub.batch = names.map((name) => ({ id: 1, observed_at: `${t}.25`, value: String(prices[name][600]), hash: '', stream_id: 1,
    stream: { id: 1, uuid: `u-${name}`, name, meta: null }, ts: '', stream_uuid: `u-${name}` }));
  stub.history = Object.fromEntries(names.map((name) => [`u-${name}`, Array.from({ length: 600 }, (_, j) => ({
    id: j, stream_uuid: `u-${name}`, observed_at: `${t - (600 - j) * H}.25`, value: String(prices[name][j]), ts: '' }))]));
}

const models = (page) => page.evaluate(() => window.satori.models());
const rows = (page) => page.locator('[data-test=model-row]');
const names = (page) => rows(page).locator('[data-test=model-name]').allTextContents();

/** Nothing scrolls sideways, and every tap target is 44 px, on what is shown. */
async function fits(page, what) {
  const r = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const shown = (el) => box(el).width > 0 && box(el).height > 0;
    const small = [...document.querySelectorAll('button, input:not([type=checkbox]), select, summary, nav a, a.mrow, a.back')]
      .filter(shown).filter((el) => box(el).height < 44 || box(el).width < 44).map((el) => el.outerHTML.slice(0, 90));
    return { sideways: document.documentElement.scrollWidth - innerWidth, small };
  });
  expect(r, what).toEqual({ sideways: 0, small: [] });
}

async function shots(page, name) {
  const dir = process.env.SHOTS ? 'docs/screenshots' : test.info().outputPath();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    if (name === 'drill') { // the whole drill-in, its tab bar at the bottom (a full-page shot leaves it mid-page)
      await page.setViewportSize({ width: 390, height: await page.evaluate(() => document.documentElement.scrollHeight) });
      await page.waitForTimeout(250);
    }
    await page.screenshot({ path: `${dir}/models-${name}-phone-${scheme}.png` });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${dir}/models-${name}-desktop-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('Models: the engine\'s status, every model (central, Base, Network), filter and sort, a drill-in and back, a deep link, the phone', async ({ context, page }) => {
  test.setTimeout(300_000);
  const { s, rpc } = fakeSatori({ round: ROUND, hour: 9 });
  // a registry stream with a week of hourly history: bar1 in the batch (the default stream has two points: naive)
  s.streams[3] = { game: 13, named: false, cadence: 60,
    history: Array.from({ length: 168 }, (_, k) => ({ hour: ROUND * 24 - 167 + k, value: BigInt(Math.round(5e6 * (1 + 0.03 * Math.sin(k / 9)))) })) };
  s.weights[13] = E18;
  const central = await stubCentral(context, { rpc: rpc, relays: [CENTRAL_RELAY] });
  central.vaults[v.pubkey] = v.ethAddress;
  centralAt(central, nowS() - 60);

  // A new neuron: its first poll at once, central's history for the 8 streams, a model each.
  await openApp(page);
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, vaultWords: w }), [PASS, v.words]);
  expect((await polled(page)).lastSubmit).toMatchObject({ successful: 8 });
  await page.evaluate(() => window.satori.go('models'));
  await expect(page).toHaveURL(/#models$/);
  await expect(page.locator('[data-test=tab-models]')).toHaveAttribute('aria-current', 'page');
  await expect(rows(page)).toHaveCount(8);
  await expect(page.locator('[data-test=engine-title]')).toHaveText('Resting');
  await expect(page.locator('[data-test=engine-line]')).toHaveText(/^Trained just now · next run in 11 h$/);
  let list = await models(page);
  expect(list).toHaveLength(8);
  const kinds = list.map((m) => m.kind);
  expect(kinds.filter((k) => k === 'bvar').length).toBeGreaterThanOrEqual(6); // history loaded: most are bvar
  for (const m of list) {
    expect(m).toMatchObject({ id: `central:${m.uuid}`, source: 'central', outputs: [{ stream: m.uuid, name: m.name,
      destinations: [{ to: 'central', status: 'accepted' }] }] });
    expect(m.quality.mark).toMatch(/^(better|tie|worse)$/);
    if (m.kind === 'bvar') expect(m.outputs[0].influence.reduce((x, i) => x + i.share, 0)).toBeCloseTo(1, 9);
  }
  const marks = Object.fromEntries(['better', 'tie', 'worse'].map((k) => [k, list.filter((m) => m.quality.mark === k).length]));
  await expect(page.locator('[data-test=engine-quality]')).toHaveText(`Beats no change on ${marks.better} of 8 · ties ${marks.tie} · worse ${marks.worse}`);
  await expect(page.locator('[data-test=engine-kinds]')).toHaveText(new RegExp(`^8 models · ${kinds.filter((k) => k === 'bvar').length} bvar`));
  await expect(page.locator('[data-test=engine-median]')).toHaveText(/^Median model: /);

  // Working: a poll held at its first step says it in Home's hero's words; nothing on this tab moves (the hero's ring
  // is Home's one moving indicator).
  const release = central.hold();
  await page.evaluate(() => void window.satori.poll());
  await expect(page.locator('[data-test=engine-title]')).toHaveText('Working');
  await expect(page.locator('[data-test=engine-line]')).toHaveText("Fetching today's observations…");
  await expect(page.locator('[data-test=engine]')).toHaveAttribute('data-tone', 'working');
  await expect(page.locator('[data-test=health-line]')).toHaveText("Fetching today's observations…");
  expect(await page.evaluate(() => document.querySelector('[data-test=models-tab]').getAnimations({ subtree: true }).length)).toBe(0);
  release();
  await expect(page.locator('[data-test=engine-title]')).toHaveText('Resting');

  // Base: stake (Unlock first), and the identity's batch: a model per registry stream with a game.
  const st = await page.evaluate(() => window.satori.base());
  rpc.eth[st.identity.address.toLowerCase()] = 10n ** 17n;
  rpc.eth[st.vault.address.toLowerCase()] = 10n ** 17n;
  s.balance[st.vault.address.toLowerCase()] = 100n * E18;
  await page.evaluate((p) => window.satori.unlock(p), PASS);
  await page.evaluate(() => window.satori.stake());
  await page.evaluate(() => window.satori.predictBase());
  await expect(rows(page)).toHaveCount(10);

  // Nostr: a stream on the test relay, 16 observations an hour apart (one a second: the relay keeps one per second),
  // each forecast and published as `<stream>_pred`: a Network model.
  const stream = `e2e-models-${Date.now().toString(36)}`;
  const provider = await connectProvider({ url: CENTRAL_RELAY });
  await provider.announce({ stream, name: 'Rain gauge', cadence: 3600 });
  await page.evaluate((u) => window.satori.setRelays({ relays: [u] }), USER_RELAY);
  await expect.poll(async () => (await page.evaluate(() => window.satori.nostr())).relays.every((r) => r.state === 'open')).toBe(true);
  const t0 = nowS() - 20 * H;
  await provider.observe({ stream, value: '10', seq: 1, timestamp: t0 });
  await page.evaluate(([p, x]) => window.satori.subscribe(p, x), [provider.pubkey, stream]);
  // the stored one first (the follow is on), then the live ones
  await expect.poll(async () => (await page.evaluate(() => window.satori.nostr())).subscriptions[0]?.prediction?.seq).toBe(1);
  for (let k = 2; k <= 16; k++) {
    await page.waitForTimeout(1050);
    await provider.observe({ stream, value: String(10 + 3 * Math.sin(k) + k * 0.2), seq: k, timestamp: t0 + (k - 1) * H });
  }
  // the intake takes each in turn (on this busy box, seconds each): all 16 forecast and published
  await expect.poll(async () => {
    const ref = (await models(page)).find((m) => m.source === 'nostr')?.outputs[0].destinations[0].ref;
    return `${ref?.seq}:${ref?.relays}`; // published: the relay took the last one
  }, { timeout: 120_000 }).toBe('16:1');
  provider.close();
  await expect(rows(page)).toHaveCount(11);
  list = await models(page);
  const rain = list.find((m) => m.source === 'nostr');
  expect(rain).toMatchObject({ name: 'Rain gauge', kind: 'bar1', outputs: [{ as: `${stream}_pred`, forecast: { horizon: 3600 },
    destinations: [{ to: 'network', status: 'published', ref: { stream: `${stream}_pred`, seq: 16, relays: 1 } }] }] });
  expect(rain.quality.mark).not.toBeNull();
  const base = list.filter((m) => m.source === 'base');
  expect(base.map((m) => [m.id, m.name, m.kind])).toEqual([['base:1', 'Stream 1', 'naive'], ['base:3', 'Stream 3', 'bar1']]);
  expect(base[1].outputs[0].destinations[0]).toMatchObject({ to: 'base', status: 'sent', ref: { round: ROUND, tx: expect.stringMatching(/^0x/) } });

  // Filter by where the predictions go; sort by quality or name.
  await page.locator('[data-test=models-filter-base]').click();
  expect(await names(page)).toEqual(['Stream 1', 'Stream 3']);
  await expect(page.locator('[data-test=models-filter-base] .n')).toHaveText('2');
  await page.locator('[data-test=models-filter-network]').click();
  expect(await names(page)).toEqual(['Rain gauge']);
  await expect(rows(page).locator('.mname small')).toHaveText(`→ ${stream}_pred`);
  await page.locator('[data-test=models-filter-central]').click();
  await expect(rows(page)).toHaveCount(8);
  await page.locator('[data-test=models-filter-all]').click();
  await page.locator('[data-test=models-sort-name]').click();
  expect(await names(page)).toEqual(list.map((m) => m.name).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })));
  await page.locator('[data-test=models-sort-quality]').click();
  const order = { better: 0, tie: 1, worse: 2, none: 3 };
  const shown = await rows(page).evaluateAll((els) => els.map((e) => e.dataset.mark));
  expect(shown).toEqual([...shown].sort((a, b) => order[a] - order[b]));
  // a row: its kind, its companions as chips, latest → forecast, where it goes
  const gold = list.find((m) => m.name === 'gold');
  const goldRow = rows(page).filter({ has: page.locator('[data-test=model-name]', { hasText: /^gold$/ }) });
  await expect(goldRow.locator('[data-test=model-kind]')).toHaveText(gold.kind);
  if (gold.kind === 'bvar') {
    await expect(goldRow.locator('.ichip')).toHaveText(gold.outputs[0].influence.filter((i) => i.stream !== gold.uuid).map((i) => `+${i.name}`));
  }
  await expect(goldRow.locator('[data-test=model-to] .dest')).toHaveAttribute('data-to', 'central');
  await page.setViewportSize({ width: 1280, height: 900 });
  await shots(page, 'list');

  // The drill-in of a bvar model: In (ranked, 100 %), the Model (plain, the jargon behind details), Out (a list).
  const bvar = list.find((m) => m.kind === 'bvar' && m.name === 'eth') ?? list.find((m) => m.kind === 'bvar');
  await page.mouse.wheel(0, 300);
  const before = await page.evaluate(() => scrollY);
  await rows(page).filter({ has: page.locator('[data-test=model-name]', { hasText: new RegExp(`^${bvar.name}$`) }) }).click();
  await expect(page).toHaveURL(new RegExp(`#models/central:${bvar.uuid}$`));
  await expect(page.locator('[data-test=model-title]')).toHaveText(bvar.name);
  const inputs = page.locator('[data-test=model-in] [data-test=model-input]');
  await expect(inputs).toHaveCount(1 + bvar.spec.companions.length);
  const pcts = (await inputs.locator('.ipct').allTextContents()).map((x) => Number(x.replace('%', '')));
  expect(pcts).toEqual([...pcts].sort((a, b) => b - a)); // ranked
  expect(Math.abs(pcts.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(pcts.length); // rounding
  await expect(page.locator('[data-test=model-line]').first()).toHaveText('Predicts 24 h ahead in 12 h steps');
  await expect(page.locator('[data-test=model-line]').filter({ hasText: /^Backtest over 28 tests: / })).toHaveCount(1);
  await expect(page.locator('[data-test=model-details] dl')).toBeHidden(); // the jargon, behind details
  await page.locator('[data-test=model-details] summary').click();
  await expect(page.locator('[data-test=model-details]')).toContainText(`${bvar.spec.lambda1}, ${bvar.spec.lambda2}`);
  await expect(page.locator('[data-test=model-output]')).toHaveCount(1);
  await expect(page.locator('[data-test=model-output-name]')).toHaveText(bvar.name);
  await expect(page.locator('[data-test=model-destination]')).toHaveText(/Central\s*Accepted /);
  await expect(page.locator('[data-test=model-chart] path.hist')).toHaveAttribute('d', /^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+){10,}$/);
  await expect(page.locator('[data-test=model-endpoint]')).toBeVisible();
  // the agent's drill-in: the same, recomputed on demand, cheap
  const d = await page.evaluate((id) => window.satori.model(id), bvar.id);
  expect(d).toMatchObject({ id: bvar.id, kind: 'bvar', model: { kind: 'bvar', lambda1: bvar.spec.lambda1, tests: 28 }, outputs: [{ stream: bvar.uuid }] });
  expect(d.outputs[0].influence.map((i) => i.share)).toEqual(bvar.outputs[0].influence.map((i) => i.share)); // the poll's fit, again
  expect(d.ms).toBeLessThan(500);
  console.log(`model(${bvar.name}) in ${d.ms} ms, of which ${d.readMs} ms reading the history`);
  await page.locator('[data-test=model-details] summary').click();
  await shots(page, 'drill');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Back: the list, where it was.
  await page.locator('[data-test=model-back]').click();
  await expect(page).toHaveURL(/#models$/);
  await expect(page.locator('[data-test=model-detail]')).toBeHidden();
  await expect(rows(page)).toHaveCount(11);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(before);

  // The phone: the list and a drill-in fit at 390 and 360 px.
  for (const [w, h] of [[390, 844], [360, 740]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => window.satori.go('models'));
    await fits(page, `the list at ${w} px`);
    await page.evaluate((id) => window.satori.go(`models/${id}`), bvar.id);
    await expect(page.locator('[data-test=model-output]')).toHaveCount(1);
    await fits(page, `a drill-in at ${w} px`);
    await page.evaluate((id) => window.satori.go(`models/${id}`), base[1].id);
    await expect(page.locator('[data-test=model-destination]')).toHaveText(/Base\s*Round \d+ · (UP|DOWN) · tx 0x/);
    await fits(page, `a Base drill-in at ${w} px`);
  }

  // A deep link survives a reload; an unknown model says so.
  await page.evaluate((id) => window.satori.go(`models/${id}`), rain.id);
  await reloadApp(page);
  await expect(page.locator('[data-test=model-title]')).toHaveText('Rain gauge', { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=model-output] .ohead small')).toHaveText(`published as ${stream}_pred`);
  await page.evaluate(() => window.satori.go('models/central:nope'));
  await expect(page.locator('[data-test=model-error]')).toHaveText(/^No such model: central:nope/);
  expect(await page.evaluate(() => window.satori.model('central:nope'))).toBeNull();
  expect(central.prod).toEqual([]);
});
