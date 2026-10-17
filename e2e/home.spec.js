// Home's health (docs/design/health.md) in Chrome, each state driven with the stub central and a fake chain behind
// /rpc; "was asleep" from a seeded activity log. Also the phone's first screen (390 × 844 and 360 × 740: the answer
// without scrolling, tap targets of 44 px, no sideways scroll on any tab) and the screenshots of each state, phone and
// computer, light and dark (SHOTS=1 writes them to docs/screenshots/home-*.png; else to the test's output), and a new
// neuron's first day.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/identity-parity.json', import.meta.url)));
const v = fx.vectors[2]; // the vault: its words, and central's name for it
const PASS = 'correct horse battery';
const H = 3600;
const D = 86400;
const ROUND = Math.floor(Date.now() / 1000 / D);
const nowS = () => Math.floor(Date.now() / 1000);
const STREAMS = [['bitcoin', 81570], ['eth', 3412], ['gold', 2684.3], ['silver', 31.2], ['oil', 71.4], ['eur-usd', 1.084],
  ['sp500', 5810], ['fear-greed', 54]];
const price = (i, k) => STREAMS[i][1] * (1 + 0.02 * Math.sin(k / (3 + i)) + 0.0002 * k);

/** Central's latest observation of each stream at `t` (k: its hour), and 600 hours of history before it. */
function centralAt(stub, t, k = 600) {
  stub.batch = STREAMS.map(([name], i) => ({ id: 1, observed_at: `${t}.25`, value: String(price(i, k)), hash: '', stream_id: 1,
    stream: { id: 1, uuid: `u-${name}`, name, meta: null }, ts: '', stream_uuid: `u-${name}` }));
  stub.history ??= Object.fromEntries(STREAMS.map(([name], i) => [`u-${name}`, Array.from({ length: 600 }, (_, j) => ({
    id: j, stream_uuid: `u-${name}`, observed_at: `${t - (600 - j) * H}.25`, value: String(price(i, j)), ts: '' }))]));
}

async function setup(context) {
  const chain = fakeSatori({ round: ROUND, hour: 9 });
  const central = await stubCentral(context, { rpc: chain.rpc });
  central.vaults[v.pubkey] = v.ethAddress; // central pays this vault: no mismatch
  return { ...chain, central };
}

/** Local time `hour` on the day `k` days before `now`'s. */
function dayAt(now, k, hour) {
  const d = new Date(now * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - k, hour).getTime() / 1000;
}

/**
 * A month of activity, as the app logs it: a session each day, two good cycles and a Base batch, up to `until`;
 * the last good cycle at `lastGood` (by default 2 h ago, or just after midnight when it is not yet 2 am).
 */
function month(now, { closed = [], part = [], until = now, lastGood = Math.max(now - 2 * H, dayAt(now, 0, 0) + 60) } = {}) {
  const rows = [];
  const midnight = new Date(dayAt(now, 0, 0) * 1000);
  const at = (k, hour) => dayAt(now, k, hour);
  const good = (t) => ({ at: t, kind: 'central', level: 'ok', data: { streams: 8, new: 8, predicted: 8, sent: 8, accepted: 8, pending: 0 } });
  for (let k = 29; k >= 1; k--) {
    if (closed.includes(k) || at(k, 8) > until) continue;
    rows.push({ at: at(k, 8), until: Math.min(at(k, 22), until), kind: 'open', level: 'ok', data: { gap: 36_000, missed: false } });
    rows.push(good(at(k, 9)));
    rows.push(part.includes(k) // that day the batch failed, else it went out
      ? { at: at(k, 9) + 300, until: at(k, 10) + 300, kind: 'base', level: 'bad', data: { round: ROUND - k, error: 'HTTP request failed' }, mkey: 'e' }
      : { at: at(k, 9) + 300, kind: 'base', level: 'ok', data: { round: ROUND - k, hash: '0xab', games: [1], dropped: [] } });
    if (at(k, 20) < until) rows.push(good(at(k, 20)));
  }
  if (until > midnight.getTime() / 1000) {
    rows.push({ at: Math.max(midnight.getTime() / 1000, until - 4 * H), until, kind: 'open', level: 'ok', data: { gap: 36_000, missed: false } });
  }
  if (!rows.some((r) => r.kind === 'central' && r.at === lastGood)) rows.push(good(lastGood));
  return rows.sort((a, b) => a.at - b.at);
}

/** The app's activity log seeded before it opens (the app's database, through the e2e store page). */
async function seed(page, rows) {
  await page.goto('/e2e/store/');
  const r = await page.evaluate((x) => window.probe({ cmd: 'app-activity', rows: x, clear: true }), rows);
  expect(r.rows, JSON.stringify(r)).toHaveLength(rows.length);
}

const health = (page) => page.evaluate(() => window.satori.health());
const hero = (page) => page.locator('[data-test=health]');

async function start(page) {
  await openApp(page);
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, vaultWords: w }), [PASS, v.words]);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
}

/** Screenshots of Home: the phone's first screen and the computer's dashboard, light and dark. */
async function shots(page, name) {
  const dir = process.env.SHOTS ? 'docs/screenshots' : test.info().outputPath();
  await page.evaluate(() => window.satori.go('home'));
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${dir}/home-${name}-phone-${scheme}.png` });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${dir}/home-${name}-desktop-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The phone: Home answers on its first screen; on every tab, tap targets are 44 px and nothing scrolls sideways. */
async function phoneChecks(page, width, height) {
  await page.setViewportSize({ width, height });
  for (const tab of ['streams', 'wallet', 'settings', 'home']) {
    await page.evaluate((t) => window.satori.go(t), tab);
    const r = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const shown = (el) => box(el).width > 0 && box(el).height > 0;
      const small = [...document.querySelectorAll('button, input:not([type=checkbox]), select, textarea, summary, nav a, a.chan')]
        .filter(shown).filter((el) => box(el).height < 44 || box(el).width < 44).map((el) => el.outerHTML.slice(0, 90));
      return { sideways: document.documentElement.scrollWidth - innerWidth, small };
    });
    expect(r, `${tab} at ${width} px`).toEqual({ sideways: 0, small: [] });
  }
  const fold = await page.evaluate(() => {
    const bottom = (s) => document.querySelector(s).getBoundingClientRect().bottom;
    return { answer: Math.max(...['[data-test=health]', '.days-tile', '[data-test=channels]'].map(bottom)), bar: document.querySelector('.tabbar').getBoundingClientRect().top };
  });
  expect(fold.answer, `Home's first screen at ${width} × ${height}`).toBeLessThanOrEqual(fold.bar);
}

test('ok, then warn (Delegate from the action card, with the inline Unlock), then ok on Base too', async ({ context, page }) => {
  test.setTimeout(240_000);
  const { s, rpc, central } = await setup(context);
  await seed(page, month(nowS(), { closed: [6, 7], part: [3] }));
  await start(page);
  const st = await page.evaluate(() => window.satori.base());
  rpc.eth[st.identity.address.toLowerCase()] = 10n ** 17n;
  rpc.eth[st.vault.address.toLowerCase()] = 10n ** 17n;
  await page.evaluate(() => window.satori.base());

  // A month in, the last cycle 2 h ago: predicting; the first poll of this session soon.
  let h = await health(page);
  expect(h).toMatchObject({ status: 'ok', title: 'Predicting', action: null, reasons: [] });
  expect(h.line).toMatch(/^Sent 8 predictions (\d+ (min|h) ago|just now) · next in \d+ min$/);
  expect(h.days).toHaveLength(30);
  expect(h.days.slice(-8).map((d) => d.code)).toEqual(['closed', 'closed', 'full', 'full', 'part', 'full', 'full', 'full']); // days 7 and 6 ago closed, 3 ago Base failed

  // Poll now: central's 8 streams with their history, each forecast (bvar), sent.
  centralAt(central, nowS() - 60);
  expect((await page.evaluate(() => window.satori.poll())).submit).toMatchObject({ successful: 8 });
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting');
  await expect(page.locator('[data-test=health-line]')).toHaveText(/^Sent 8 predictions just now · next in 11 h$/);
  await expect(page.locator('[data-test=action]')).toBeHidden();
  const chip = (c) => page.locator(`[data-test=chip][data-channel=${c}]`);
  await expect(chip('central')).toHaveAttribute('data-state', 'ok');
  await expect(chip('central').locator('[data-test=chip-text]')).toHaveText('8 sent just now');
  await expect(chip('base')).toHaveAttribute('data-state', 'idle');
  await expect(chip('base').locator('[data-test=chip-text]')).toHaveText('Not delegated');
  await expect(chip('network').locator('[data-test=chip-text]')).toHaveText('No streams');
  await expect(page.locator('[data-test=day]').last()).toHaveAttribute('data-code', 'full');
  await expect(page.locator('[data-test=day].today')).toHaveCount(1);
  await expect(page.locator('[data-test=home-stream]')).toHaveCount(8);
  await expect(page.locator('[data-test=feed-item]').filter({ hasText: 'Sent 8 predictions to central' }).first()).toBeVisible();
  await shots(page, 'ok');
  await phoneChecks(page, 390, 844);
  await phoneChecks(page, 360, 740);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The vault gets SATORI: Base needs one step from the person. One card, one button.
  s.balance[st.vault.address.toLowerCase()] = 100n * E18;
  await page.evaluate(() => window.satori.base());
  h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'Central is fine. Base needs one step from you.',
    action: { id: 'delegate', button: 'Delegate', do: 'delegate' }, channels: { base: { state: 'warn', text: 'Not delegated' } } });
  await expect(hero(page)).toHaveAttribute('data-s', 'warn');
  await expect(page.locator('[data-test=action]')).toHaveAttribute('data-action', 'delegate');
  await expect(page.locator('[data-test=claimable-amount]')).toHaveText('0');
  await shots(page, 'warn');
  await phoneChecks(page, 360, 740); // with the action card, the answer still fits
  await page.setViewportSize({ width: 1280, height: 900 });

  // Delegate: the vault is locked, so the passphrase is asked for in the card; then it delegates.
  await page.locator('[data-test=action-button]').click();
  const prompt = page.getByLabel('Vault passphrase to delegate');
  await expect(prompt).toBeVisible();
  await prompt.fill('not it');
  await page.locator('[data-unlock-for=card]').getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-unlock-for=card] [role=alert]')).toHaveText('Wrong passphrase');
  await prompt.fill(PASS);
  await page.locator('[data-unlock-for=card]').getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-test=action]')).toBeHidden({ timeout: 30_000 }); // delegated: nothing needs the person
  expect(rpc.sent.map((t) => t.functionName)).toEqual(['setPredictorFee', 'setAllowedDelegator', 'delegatePredictionPower']);
  // the identity's batch, on its own, 10 s after delegating
  await expect(chip('base').locator('[data-test=chip-text]')).toHaveText(`Round ${ROUND} sent`, { timeout: 30_000 });
  h = await health(page);
  expect(h).toMatchObject({ status: 'ok', channels: { base: { state: 'ok', text: `Round ${ROUND} sent` } } });
  const texts = h.feed.map((f) => f.text);
  expect(texts.indexOf(`Base batch for round ${ROUND}: 1 game`)).toBeLessThan(texts.indexOf('Delegated to this neuron')); // newest first

  // A chip goes to its tab; tabs are hash routes, kept over a reload.
  await chip('base').click();
  await expect(page).toHaveURL(/#wallet$/);
  await expect(page.locator('[data-test=wallet-tab]')).toBeVisible();
  await expect(page.locator('[data-test=tab-wallet]')).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => window.satori.go('#settings'))).toBe('settings');
  await expect(page.locator('#settings-keys')).toBeVisible();
  await expect(page.evaluate(() => window.satori.go('nope'))).rejects.toThrow(/No such tab/);
  expect(central.prod).toEqual([]);
});

test('idle: was asleep two days, catches up, and shows it until the next normal cycle', async ({ context, page }) => {
  test.setTimeout(240_000);
  const { central } = await setup(context);
  const closedAt = dayAt(nowS(), 2, 12); // closed at noon two days ago: 1.5 to 2.5 days, "2 days"
  await seed(page, month(nowS(), { closed: [9], until: closedAt, lastGood: closedAt - H }));
  await start(page);
  let h = await health(page);
  expect(h).toMatchObject({ status: 'idle', title: 'Was asleep', action: null });
  expect(h.line).toMatch(/^Closed for 2 days\. Catching up in \d+ min\.$/);
  expect(h.channels.central.text).toMatch(/^Catching up in \d+ min$/);
  expect(h.feed).toContainEqual(expect.objectContaining({ level: 'idle', text: 'Satori was closed for 2 d' }));
  expect(h.days.slice(-3).map((d) => [d.code, d.ran])).toEqual([['full', true], ['closed', false], ['closed', true]]);

  centralAt(central, nowS() - 60);
  await page.evaluate(() => window.satori.poll());
  await expect(page.locator('[data-test=health-line]')).toHaveText('Closed for 2 days. Caught up just now.');
  await expect(hero(page)).toHaveAttribute('data-s', 'idle');
  await expect(page.locator('[data-test=health-title]')).toHaveText('Was asleep');
  await expect(page.locator('[data-test=chip][data-channel=central]')).toHaveAttribute('data-state', 'ok');
  h = await health(page);
  expect(h.feed).toContainEqual(expect.objectContaining({ level: 'ok', text: 'Caught up: sent 8 predictions' }));
  expect(h.days.at(-1).code).toBe('full');
  await shots(page, 'idle');

  // The next normal cycle: predicting.
  centralAt(central, nowS() - 30, 601);
  await page.evaluate(() => window.satori.poll());
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');
  expect(central.prod).toEqual([]);
});

test('bad: central refuses two batches in a row, then the login; the card goes to the fix', async ({ context, page }) => {
  test.setTimeout(240_000);
  const { central } = await setup(context);
  await seed(page, month(nowS(), { closed: [12], part: [5] }));
  await start(page);
  centralAt(central, nowS() - 3 * H);
  await page.evaluate(() => window.satori.poll());
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');

  // Once: retrying (warn). Twice in a row: not predicting (bad).
  centralAt(central, nowS() - 2 * H, 601);
  central.fail.push(500, 500); // a 5xx is resent once
  await page.evaluate(() => window.satori.poll());
  let h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Retrying', action: { id: 'central-failed', button: 'Try again', do: 'poll' } });
  expect(h.line).toMatch(/^The last poll failed; next try in 11 h\.$/);
  centralAt(central, nowS() - H, 602);
  central.fail.push(500, 500);
  await page.evaluate(() => window.satori.poll());
  await expect(hero(page)).toHaveAttribute('data-s', 'bad');
  await expect(page.locator('[data-test=health-title]')).toHaveText('Not predicting');
  await expect(page.locator('[data-test=health-line]')).toHaveText('Central refused the last 2 batches.');
  await expect(page.locator('[data-test=action-text]')).toHaveText('central 500: boom. Try again now, or check the central address in Settings.');
  await expect(page.locator('[data-test=chip][data-channel=central] [data-test=chip-text]')).toHaveText('2 failed in a row');
  await expect(page.locator('[data-test=day]').last()).toHaveAttribute('data-code', 'full'); // today's first poll went out
  await shots(page, 'bad');

  // Try again: central takes the kept batch; then it refuses the login (bad at once), and the card opens Settings there.
  await page.locator('[data-test=action-button]').click();
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');
  centralAt(central, nowS() - 30, 603);
  central.refuseLogin = true;
  await page.evaluate(() => window.satori.poll());
  h = await health(page);
  expect(h).toMatchObject({ status: 'bad', line: "Central refused this neuron's login.",
    action: { id: 'login-refused', button: 'Open Settings', do: 'go', tab: 'settings', section: 'central' },
    channels: { central: { state: 'bad', text: 'Login refused' } } });
  await page.locator('[data-test=action-button]').click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByLabel('Central URL')).toBeInViewport();
  expect(central.prod).toEqual([]);
});

test('starting: a new neuron is calm before its first poll, then predicting; the days before it are not closed days', async ({ context, page }) => {
  const { central } = await setup(context);
  await openApp(page);
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, vaultWords: w }), [PASS, v.words]);
  const h = await health(page);
  expect(h).toMatchObject({ status: 'idle', title: 'Starting', action: null });
  expect(h.line).toMatch(/^First predictions in \d+ min\.$/);
  expect(h.days.at(-1)).toMatchObject({ code: 'closed', ran: true, today: true });
  expect(h.days.slice(0, -1).every((d) => d.code === 'before' && !d.ran)).toBe(true);
  const before = page.locator('[data-test=day][data-code=before]');
  await expect(before).toHaveCount(29);
  await expect(before.first()).toHaveAttribute('title', /^\w+ \d+: Before this neuron$/);
  await expect(page.locator('[data-test=days-summary]')).toHaveText('0 full days');
  centralAt(central, nowS() - 60);
  await page.evaluate(() => window.satori.poll());
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');
  await expect(page.locator('[data-test=health-line]')).toHaveText('Sent 8 predictions just now · next in 11 h');
  await expect(page.locator('[data-test=day]').last()).toHaveAttribute('data-code', 'full');
  await expect(page.locator('[data-test=days-summary]')).toHaveText('1 full day');
  await shots(page, 'new');
  expect(central.prod).toEqual([]);
});
