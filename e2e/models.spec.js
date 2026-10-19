// The Models tab (docs/design/models.md) in Chrome: a neuron with central's 8 streams (600 hours of history each, so
// most models are bvar), staked on a fake chain (its Base batch: a model per registry stream) and subscribed to a
// stream on a test relay (its `_pred`: a Network model). The engine's status, the list, filter and sort, a model's
// drill-in (#models/<id>) and back, a deep link, the Sort menu (kept over a reload), the agent API, the phone's width
// (nothing scrolls sideways, tap targets of 44 px), and the screenshots (SHOTS=1 writes them to docs/screenshots/models-*.png; else to the test's output).
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
    if (name.startsWith('drill')) { // the whole drill-in, its tab bar at the bottom (a full-page shot leaves it mid-page)
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
  const errors = []; // the page never throws (an open drill-in recomputed after a poll once stopped ArrowJS's queue)
  page.on('pageerror', (e) => errors.push(String(e)));
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
      destinations: [{ to: 'network', status: 'accepted' }] }] });
    expect(m.quality.mark).toMatch(/^(better|tie|worse)$/);
    if (m.kind === 'bvar') expect(m.outputs[0].influence.reduce((x, i) => x + i.share, 0)).toBeCloseTo(1, 9);
  }
  const marks = Object.fromEntries(['better', 'tie', 'worse'].map((k) => [k, list.filter((m) => m.quality.mark === k).length]));
  // the bar's legend, in the rows' words
  await expect(page.locator('[data-test=engine-quality] .qleg:not([hidden])'))
    .toHaveText([`${marks.better} better`, `${marks.tie} same as no change`, `${marks.worse} worse`]);
  await expect(page.locator('[data-test=engine-quality]'))
    .toHaveAttribute('aria-label', `${marks.better} better · ${marks.tie} same as no change · ${marks.worse} worse`);
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
  // An open drill-in follows the model: the next `_pred` shows in its Out without reopening it.
  const rainId = (await models(page)).find((m) => m.source === 'nostr').id;
  await page.evaluate((id) => window.satori.go(`models/${id}`), rainId);
  await expect(page.locator('[data-test=model-destination]')).toHaveText(/Relays\s*e2e-models-\w+_pred #16 · 1 relay$/);
  await page.waitForTimeout(1050);
  await provider.observe({ stream, value: '14', seq: 17, timestamp: t0 + 16 * H });
  await expect(page.locator('[data-test=model-destination]')).toHaveText(/_pred #17 · 1 relay$/, { timeout: 60_000 });
  await page.evaluate(() => window.satori.go('models'));
  provider.close();
  await expect(rows(page)).toHaveCount(11);
  list = await models(page);
  const rain = list.find((m) => m.source === 'nostr');
  expect(rain).toMatchObject({ name: 'Rain gauge', kind: 'bar1', outputs: [{ as: `${stream}_pred`, forecast: { horizon: 3600 },
    destinations: [{ to: 'relays', status: 'published', ref: { stream: `${stream}_pred`, seq: 17, relays: 1 } }] }] });
  expect(rain.quality.mark).not.toBeNull();
  const base = list.filter((m) => m.source === 'base');
  expect(base.map((m) => [m.id, m.name, m.kind])).toEqual([['base:1', 'Stream 1', 'naive'], ['base:3', 'Stream 3', 'bar1']]);
  expect(base[1].outputs[0].destinations[0]).toMatchObject({ to: 'contract', status: 'sent', ref: { round: ROUND, tx: expect.stringMatching(/^0x/) } });

  // Filter by where the predictions go; sort by quality or name.
  await page.locator('[data-test=models-filter-contract]').click();
  expect(await names(page)).toEqual(['Stream 1', 'Stream 3']);
  await expect(page.locator('[data-test=models-filter-contract] .n')).toHaveText('2');
  await page.locator('[data-test=models-filter-relays]').click();
  expect(await names(page)).toEqual(['Rain gauge']);
  await expect(rows(page).locator('.mname small')).toHaveText(`publishes ${stream}_pred`); // a word, not an arrow
  // on a phone the input chips say what they are (a computer's column header does): "reads +eth"
  await expect(rows(page).first().locator('.mreads')).toBeHidden();
  await page.locator('[data-test=models-filter-network]').click();
  await expect(rows(page)).toHaveCount(8);
  await page.locator('[data-test=models-filter-all]').click();
  // Sort: the filters stay on the left; on the right a borderless "Sort" with its current choice, a menu of two with a
  // check on the current one, by keyboard (arrows, Enter, Escape back to the button) or a tap.
  const sortBtn = page.locator('[data-test=models-sort]');
  const menu = page.locator('[data-test=models-sort-menu]');
  await expect(sortBtn).toHaveText('Sort: Quality');
  await expect(sortBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeHidden();
  const box = (l) => l.boundingBox();
  const [filters, listBox, sortBox] = [await box(page.locator('.mcontrols .segmented')), await box(page.locator('[data-test=models]')), await box(sortBtn)];
  expect(Math.abs(filters.x - listBox.x)).toBeLessThan(2); // the filters on the left
  expect(Math.abs(sortBox.x + sortBox.width - (listBox.x + listBox.width))).toBeLessThan(10); // Sort on the right
  await sortBtn.click();
  await expect(menu).toBeVisible();
  await expect(sortBtn).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.locator('[role=menuitemradio]')).toHaveText(['Quality', 'Name']);
  await expect(page.locator('[data-test=models-sort-quality]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-test=models-sort-name]')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-test=models-sort-quality]')).toBeFocused(); // the current choice
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-test=models-sort-name]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(sortBtn).toBeFocused();
  await expect(sortBtn).toHaveText('Sort: Name');
  expect(await names(page)).toEqual(list.map((m) => m.name).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })));
  await page.keyboard.press('ArrowDown'); // on the button: opens it
  await expect(page.locator('[data-test=models-sort-name]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(sortBtn).toBeFocused();
  await expect(sortBtn).toHaveText('Sort: Name'); // Escape changes nothing
  await sortBtn.click();
  await page.locator('[data-test=models-sort-quality]').click();
  await expect(sortBtn).toHaveText('Sort: Quality');
  const order = { better: 0, tie: 1, worse: 2, none: 3 };
  const shown = await rows(page).evaluateAll((els) => els.map((e) => e.dataset.mark));
  expect(shown).toEqual([...shown].sort((a, b) => order[a] - order[b]));
  await sortBtn.click();
  await page.locator('[data-test=engine-title]').click(); // a tap outside closes it
  await expect(menu).toBeHidden();
  // a row: its kind, its companions as chips, latest → forecast, where it goes
  const gold = list.find((m) => m.name === 'gold');
  const goldRow = rows(page).filter({ has: page.locator('[data-test=model-name]', { hasText: /^gold$/ }) });
  await expect(goldRow.locator('[data-test=model-kind]')).toHaveText(gold.kind);
  if (gold.kind === 'bvar') {
    await expect(goldRow.locator('.ichip')).toHaveText(gold.outputs[0].influence.filter((i) => i.stream !== gold.uuid).map((i) => `+${i.name}`));
  }
  // where it goes, in words; its quality in words; its values labelled (now, and in 24 h, the arrow after it)
  await expect(goldRow.locator('[data-test=model-to] .tag')).toHaveText(['Network']);
  await expect(goldRow.locator('[data-test=model-mark]')).toHaveText(gold.quality.text);
  for (const t of await rows(page).locator('[data-test=model-mark]').allTextContents()) {
    expect(t).toMatch(/^(\d+% better|Same as no change|\d+% worse|Worse|Not scored yet)$/);
  }
  await expect(goldRow.locator('[data-test=model-forecast]')).toHaveAttribute('title', /^Now [\d,.]+, in 24 h [\d,.]+ [↑↓→]$/);
  await expect(rows(page).filter({ hasText: 'Rain gauge' }).locator('[data-test=model-forecast]')).toHaveAttribute('title', /, in 1 h /);
  await page.setViewportSize({ width: 1280, height: 900 });
  await shots(page, 'list');

  // The drill-in of a bvar model: In (ranked, 100 %), the Model (plain, the jargon behind details), Out (a list).
  const bvar = list.find((m) => m.kind === 'bvar' && m.name === 'eth') ?? list.find((m) => m.kind === 'bvar');
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300); // the wheel's scroll lands
  const before = await page.evaluate(() => scrollY);
  await rows(page).filter({ has: page.locator('[data-test=model-name]', { hasText: new RegExp(`^${bvar.name}$`) }) }).click();
  await expect(page).toHaveURL(new RegExp(`#models/central:${bvar.uuid}$`));
  await expect(page.locator('[data-test=model-title]')).toHaveText(bvar.name);
  const inputs = page.locator('[data-test=model-in] [data-test=model-input]');
  await expect(inputs).toHaveCount(1 + bvar.spec.companions.length);
  const pcts = (await inputs.locator('.ipct').allTextContents()).map((x) => Number(x.replace('%', '')));
  expect(pcts).toEqual([...pcts].sort((a, b) => b - a)); // ranked
  expect(Math.abs(pcts.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(pcts.length); // rounding
  // what it is, under its name, and how it works, first in the Model
  await expect(page.locator('[data-test=model-kind-label]')).toHaveText(`Bayesian VAR · reads ${1 + bvar.spec.companions.length} streams`);
  await expect(page.locator('[data-test=model-quality]')).toHaveText(bvar.quality.text);
  await expect(page.locator('[data-test=model-line]').first()).toHaveText(/^Learns how this stream moves together with .+, then predicts 24 h ahead\.$/);
  await expect(page.locator('[data-test=model-line]').nth(1)).toHaveText('Predicts 24 h ahead in 12 h steps');
  await expect(page.locator('[data-test=model-ahead]')).toHaveText(['12 h', '24 h']); // the chart's two forecast points, labelled
  await expect(page.locator('[data-test=model-line]').filter({ hasText: /^Backtest over 28 tests: / })).toHaveCount(1);
  await expect(page.locator('[data-test=model-details] dl')).toBeHidden(); // the jargon, behind details
  await page.locator('[data-test=model-details] summary').click();
  await expect(page.locator('[data-test=model-details]')).toContainText(`${bvar.spec.lambda1}, ${bvar.spec.lambda2}`);
  await expect(page.locator('[data-test=model-output]')).toHaveCount(1);
  await expect(page.locator('[data-test=model-output-name]')).toHaveText(bvar.name);
  await expect(page.locator('[data-test=model-destination]')).toHaveText(/Network\s*Accepted /);
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

  // A naive model says what it is and its rule (the Base default stream: two points)
  await page.evaluate((id) => window.satori.go(`models/${id}`), base[0].id);
  await expect(page.locator('[data-test=model-kind-label]')).toHaveText('No change · not enough history yet');
  await expect(page.locator('[data-test=model-quality]')).toHaveText('Same as no change');
  await expect(page.locator('[data-test=model-line]').first()).toHaveText(/^Repeats the latest value until it has \d+ (h|days?) of back-to-back history\.$/);
  await expect(page.locator('[data-test=model-ahead]').first()).toHaveText(/^(\d+ h|1 day|\d+ days)$/);
  await shots(page, 'drill-naive');
  await page.setViewportSize({ width: 1280, height: 900 });

  // The phone: the list and a drill-in fit at 390 and 360 px.
  for (const [w, h] of [[390, 844], [360, 740]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => window.satori.go('models'));
    await fits(page, `the list at ${w} px`);
    await expect(rows(page).filter({ has: page.locator('.ichip') }).first().locator('.mreads')).toHaveText('reads'); // the phone's word
    await page.evaluate((id) => window.satori.go(`models/${id}`), bvar.id);
    await expect(page.locator('[data-test=model-output]')).toHaveCount(1);
    await fits(page, `a drill-in at ${w} px`);
    await page.evaluate((id) => window.satori.go(`models/${id}`), base[1].id);
    await expect(page.locator('[data-test=model-destination]')).toHaveText(/Contract\s*Round \d+ · (UP|DOWN) · tx 0x/);
    await fits(page, `a Base drill-in at ${w} px`);
    await page.evaluate((id) => window.satori.go(`models/${id}`), base[0].id);
    await expect(page.locator('[data-test=model-kind-label]')).toHaveText('No change · not enough history yet');
    await fits(page, `a naive drill-in at ${w} px`);
  }
  // every string at 360 px, to look at (the test's output): the list, a bvar drill-in, a naive one
  await page.setViewportSize({ width: 360, height: 740 });
  for (const [name, where] of [['list', 'models'], ['bvar', `models/${bvar.id}`], ['naive', `models/${base[0].id}`]]) {
    await page.evaluate((x) => window.satori.go(x), where);
    await page.waitForTimeout(250);
    await page.screenshot({ path: test.info().outputPath(`models-360-${name}.png`), fullPage: true });
  }

  // The Sort menu open on the phone: its items are 44 px tap targets; light and dark.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.satori.go('models'));
  await sortBtn.click();
  await expect(menu).toBeVisible();
  await fits(page, 'the sort menu open at 390 px');
  const dir = process.env.SHOTS ? 'docs/screenshots' : test.info().outputPath();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${dir}/models-sort-phone-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('[data-test=models-sort-name]').click(); // kept on this device: the reload below still sorts by name
  await expect(menu).toBeHidden();

  // A deep link survives a reload; an unknown model says so.
  await page.evaluate((id) => window.satori.go(`models/${id}`), rain.id);
  await reloadApp(page);
  await expect(page.locator('[data-test=model-title]')).toHaveText('Rain gauge', { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=model-output] .ohead small')).toHaveText(`published as ${stream}_pred`);
  // the sort chosen before the reload, kept on this device
  await page.evaluate(() => window.satori.go('models'));
  await expect(sortBtn).toHaveText('Sort: Name');
  expect(await names(page)).toEqual(list.map((m) => m.name).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })));
  await page.evaluate(() => window.satori.go('models/central:nope'));
  await expect(page.locator('[data-test=model-error]')).toHaveText(/^No such model: central:nope/);
  expect(await page.evaluate(() => window.satori.model('central:nope'))).toBeNull();
  expect(central.prod).toEqual([]);
  expect(errors).toEqual([]);
});
