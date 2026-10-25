// Home's health (docs/design/health.md) in Chrome, each state driven with the stub central and a fake chain behind
// /rpc; "was asleep" from a seeded activity log. Also the phone's first screen (390 × 844 and 360 × 740: the answer
// without scrolling, tap targets of 44 px, no sideways scroll on any tab) and the screenshots of each state, phone and
// computer, light and dark (SHOTS=1 writes them to docs/screenshots/home-*.png; else to the test's output), and a new
// neuron's first day.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, polled, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/alias-parity.json', import.meta.url)));
const v = fx.vectors[2]; // the wallet: its words, and central's name for it
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
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, walletWords: w }), [PASS, v.words]);
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
  for (const tab of ['models', 'streams', 'wallet', 'settings', 'home']) {
    await page.evaluate((t) => window.satori.go(t), tab);
    const r = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const shown = (el) => box(el).width > 0 && box(el).height > 0;
      const small = [...document.querySelectorAll('button, input:not([type=checkbox]), select, textarea, summary, nav a, a.chan, a.mrow')]
        .filter(shown).filter((el) => !el.matches('[data-test=day]')) // the strip's days: 14 across a phone, a grid not a list of targets
        .filter((el) => box(el).height < 44 || box(el).width < 44).map((el) => el.outerHTML.slice(0, 90));
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

test('ok, then the Stake card (advice, the risk said; the inline Unlock), then ok on Base too, then warn (gas low)', async ({ context, page }) => {
  test.setTimeout(240_000);
  const { s, rpc, central } = await setup(context);
  await seed(page, month(nowS(), { closed: [6, 7], part: [3] }));
  centralAt(central, nowS() - 60);
  await start(page);
  const st = await page.evaluate(() => window.satori.base());
  rpc.eth[st.alias.address.toLowerCase()] = 10n ** 17n;
  rpc.eth[st.wallet.address.toLowerCase()] = 10n ** 17n;
  await page.evaluate(() => window.satori.base());

  // A month in: this session's first poll runs at once, central's 8 streams with their history, each forecast
  // (bvar), sent. Predicting.
  expect((await polled(page)).lastSubmit).toMatchObject({ successful: 8 });
  let h = await health(page);
  expect(h).toMatchObject({ status: 'ok', title: 'Predicting', action: null, reasons: [] });
  expect(h.days).toHaveLength(30);
  expect(h.days.slice(-8).map((d) => d.code)).toEqual(['closed', 'closed', 'full', 'full', 'part', 'full', 'full', 'full']); // days 7 and 6 ago closed, 3 ago Base failed
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting');
  await expect(page.locator('[data-test=health-line]')).toHaveText(/^Sent 8 predictions just now · next in 11 h$/);
  await expect(page.locator('[data-test=action]')).toBeHidden();
  const chip = (c) => page.locator(`[data-test=chip][data-channel=${c}]`);
  await expect(chip('network')).toHaveAttribute('data-state', 'ok');
  await expect(chip('network').locator('[data-test=chip-text]')).toHaveText('8 sent just now');
  await expect(chip('contract')).toHaveAttribute('data-state', 'idle');
  await expect(chip('contract').locator('[data-test=chip-text]')).toHaveText('Not staked');
  await expect(chip('relays').locator('[data-test=chip-text]')).toHaveText('No streams');
  // off: a plain grey disc, its words say why (a moon was not understood: docs/design/OVERVIEW.md#icons)
  expect(await chip('relays').locator('.ico').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
  await expect(page.locator('[data-test=day]').last()).toHaveAttribute('data-code', 'full');
  await expect(page.locator('[data-test=day].today')).toHaveCount(1);
  await expect(page.locator('[data-test=home-stream]')).toHaveCount(8);
  await expect(page.locator('[data-test=feed-item]').filter({ hasText: 'Sent 8 predictions to the Satori Network' }).first()).toBeVisible();
  await shots(page, 'ok');
  await phoneChecks(page, 390, 844);
  await phoneChecks(page, 360, 740);
  // Poll now with nothing new: nothing to predict or send, so up to date, never "0 sent"
  expect(await page.evaluate(() => window.satori.poll())).toMatchObject({ poll: { new: 0, predicted: 0 }, submit: null });
  await expect(chip('network').locator('[data-test=chip-text]')).toHaveText('Up to date');
  await expect(page.locator('[data-test=health-line]')).toHaveText('Up to date · next in 11 h');
  await expect(page.locator('[data-test=feed-item]').filter({ hasText: 'Checked the Satori Network: up to date' })).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The wallet gets SATORI: staking is offered as advice while the contract bug is live (the hero stays green), and the
  // card says the risk before staking. One card, one button.
  s.balance[st.wallet.address.toLowerCase()] = 100n * E18;
  await page.evaluate(() => window.satori.base());
  h = await health(page);
  expect(h).toMatchObject({ status: 'ok', title: 'Predicting', line: 'Up to date · next in 11 h',
    action: { id: 'stake', button: 'Stake', do: 'stake', text: "Stake with this app to earn on the Satori contract. While staked, your SATORI "
      + "can't be sent until you unstake." },
    channels: { contract: { state: 'idle', tone: 'off', text: 'Not staked' } } });
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');
  await expect(page.locator('[data-test=action]')).toHaveAttribute('data-action', 'stake');
  await expect(page.locator('[data-test=claimable-amount]')).toHaveText('0');
  await shots(page, 'stake');
  await phoneChecks(page, 360, 740); // with the action card, the answer still fits
  await page.setViewportSize({ width: 1280, height: 900 });

  // Stake: the wallet is locked, so the passphrase is asked for in the card; then it stakes.
  await page.locator('[data-test=action-button]').click();
  const prompt = page.getByLabel('Wallet passphrase to stake', { exact: true });
  await expect(prompt).toBeVisible();
  await prompt.fill('not it');
  await page.locator('[data-unlock-for=card]').getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-unlock-for=card] [role=alert]')).toHaveText('Wrong passphrase');
  await prompt.fill(PASS);
  await page.locator('[data-unlock-for=card]').getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-test=action]')).toBeHidden({ timeout: 30_000 }); // staked: nothing needs the person
  expect(rpc.sent.map((t) => t.functionName)).toEqual(['setPredictorFee', 'setAllowedDelegator', 'delegatePredictionPower']);
  // unlocked in the card for the Stake alone: locked again once it is done
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeHidden();
  expect(await page.evaluate(async () => (await window.satori.status()).unlocked)).toBe(false);
  // the alias's batch, on its own, 10 s after staking
  await expect(chip('contract').locator('[data-test=chip-text]')).toHaveText(`Round ${ROUND} sent`, { timeout: 30_000 });
  h = await health(page);
  expect(h).toMatchObject({ status: 'ok', channels: { contract: { state: 'ok', text: `Round ${ROUND} sent` } } });
  const texts = h.feed.map((f) => f.text);
  expect(texts.indexOf(`Satori contract batch for round ${ROUND}: 1 game`)).toBeLessThan(texts.indexOf('Staked with this app')); // newest first

  // Staked, the alias's gas runs low: something needs the person (amber), and the card goes to the Wallet.
  rpc.eth[st.alias.address.toLowerCase()] = 10n ** 12n;
  await page.evaluate(() => window.satori.base());
  h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'The Satori Network is fine. Gas for the daily batch is running low.',
    action: { id: 'gas-low', button: 'Add gas', do: 'go', tab: 'wallet' } });
  await expect(hero(page)).toHaveAttribute('data-s', 'warn');
  await shots(page, 'warn');
  rpc.eth[st.alias.address.toLowerCase()] = 10n ** 17n;
  await page.evaluate(() => window.satori.base());

  // Base's RPC goes down while central is fine: the batch check fails twice, Base is red, and the neuron predicts
  // only in part (it read a red "Predicting"); Home and health() say the same
  await page.route('**/rpc', (route) => route.abort());
  await page.evaluate(() => window.satori.predictBase());
  await page.evaluate(() => window.satori.predictBase());
  await expect(page.locator('[data-test=health-title]')).toHaveText('Partly predicting');
  await expect(hero(page)).toHaveAttribute('data-s', 'bad');
  await expect(page.locator('[data-test=health-line]')).toHaveText('The Satori Network is fine. The Satori contract batch failed 2 times.');
  h = await health(page);
  expect(h).toMatchObject({ status: 'bad', title: 'Partly predicting', action: { id: 'base-failing' },
    channels: { network: { state: 'ok' }, contract: { state: 'bad', text: 'Failed 2 times' } } });
  await shots(page, 'partly');
  await page.unroute('**/rpc');
  await page.evaluate(() => window.satori.base());

  // A chip opens its card under the chips; tabs are hash routes, kept over a reload.
  await chip('contract').click();
  await expect(page.locator('[data-test=chip-card]')).toHaveAttribute('data-open', 'true');
  await expect(page.locator('[data-test=contract-card]')).toBeVisible();
  await page.evaluate(() => window.satori.go('streams'));
  await expect(page).toHaveURL(/#streams$/);
  await expect(page.locator('[data-test=streams-tab]')).toBeVisible();
  await expect(page.locator('[data-test=tab-streams]')).toHaveAttribute('aria-current', 'page');
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
  centralAt(central, nowS() - 60);
  const release = central.hold(); // the catch-up poll runs at once; held here to see it
  await start(page);
  let h = await health(page);
  expect(h).toMatchObject({ status: 'idle', title: 'Was asleep', action: null, line: 'Closed for 2 days. Catching up now…' });
  await expect(page.locator('[data-test=health-title]')).toHaveText('Was asleep');
  expect(h.channels.network.text).toBe('Catching up now…');
  expect(h.feed).toContainEqual(expect.objectContaining({ level: 'idle', text: 'Satori was closed for 2 d' }));
  expect(h.days.slice(-3).map((d) => [d.code, d.ran])).toEqual([['full', true], ['closed', false], ['closed', true]]);

  release(); // no Poll now
  await expect(page.locator('[data-test=health-line]')).toHaveText('Closed for 2 days. Caught up just now.', { timeout: LOAD_TIMEOUT }); // history, bvar
  await expect(hero(page)).toHaveAttribute('data-s', 'idle'); // until the next normal cycle
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting'); // caught up
  await expect(page.locator('[data-test=chip][data-channel=network]')).toHaveAttribute('data-state', 'ok');
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

test('a failed send: amber, named, retried in minutes; a second quick failure stays amber, then green, never red; then the login refused is red', async ({ context, page }) => {
  test.setTimeout(240_000);
  const { central } = await setup(context);
  await seed(page, month(nowS(), { closed: [12], part: [5] }));
  centralAt(central, nowS() - 3 * H);
  await start(page);
  await polled(page); // the first poll, at once
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');
  // every status the hero shows from here on
  await page.evaluate(() => {
    const el = document.querySelector('[data-test=health]');
    window.seenStatus = [];
    new MutationObserver(() => window.seenStatus.push(el.dataset.s)).observe(el, { attributes: true, attributeFilter: ['data-s'] });
  });
  const network = page.locator('[data-test=chip][data-channel=network] [data-test=chip-text]');
  const central_ = async () => (await page.evaluate(() => window.satori.status())).central;

  // The send fails (a 503 and its one resend): amber, the line names it, the next try in 2 min (it said "poll", 11 h).
  centralAt(central, nowS() - 2 * H, 601);
  central.fail.push(503, 503);
  await page.evaluate(() => window.satori.poll());
  let h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'Sending failed; next try in 2 min.',
    action: { id: 'central-failed', button: 'Try again', do: 'poll' } });
  expect(await central_()).toMatchObject({ failures: 1, pending: 8 });
  await expect(network).toHaveText('Sending failed');

  // Try again minutes later, and it fails again: still amber (it turned red here), the next try in 10 min.
  central.fail.push(503, 503);
  await page.locator('[data-test=action-button]').click();
  await expect(page.locator('[data-test=health-line]')).toHaveText('Sending failed; next try in 10 min.', { timeout: LOAD_TIMEOUT });
  await expect(hero(page)).toHaveAttribute('data-s', 'warn');
  expect(await central_()).toMatchObject({ failures: 2 });
  await shots(page, 'retrying');

  // Then central takes it: green, the kept predictions sent, 11 h from this success.
  await page.locator('[data-test=action-button]').click();
  await expect(hero(page)).toHaveAttribute('data-s', 'ok', { timeout: LOAD_TIMEOUT });
  const c = await central_();
  expect(c).toMatchObject({ failures: 0, pending: 0 });
  expect(c.nextPoll - nowS()).toBeGreaterThan(11 * H - 60);
  expect(central.batches.at(-1)).toHaveLength(8);
  expect(await page.evaluate(() => window.seenStatus)).not.toContain('bad');
  await expect(page.locator('[data-test=day]').last()).toHaveAttribute('data-code', 'full');

  // The login refused: red at once (only the person can fix it), and the card opens Settings there.
  centralAt(central, nowS() - 30, 603);
  central.refuseLogin = true;
  await page.evaluate(() => window.satori.poll());
  h = await health(page);
  expect(h).toMatchObject({ status: 'bad', title: 'Not predicting', line: "The Satori Network refused this app's login.",
    action: { id: 'login-refused', button: 'Open Settings', do: 'go', tab: 'settings', section: 'central' },
    channels: { network: { state: 'bad', text: 'Login refused' } } });
  await expect(hero(page)).toHaveAttribute('data-s', 'bad');
  await shots(page, 'bad');
  await page.locator('[data-test=action-button]').click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByLabel('Satori Network server')).toBeInViewport();
  expect(central.prod).toEqual([]);
});

test('register fails, then succeeds: it registers again before each poll until it does', async ({ context, page }) => {
  const { central } = await setup(context);
  centralAt(central, nowS() - 60);
  central.failRegister = 4; // the load's register and the one before the first poll, each resent once
  await start(page);
  await polled(page); // the first poll runs anyway
  expect(central.registered).toHaveLength(4);
  let h = await health(page);
  expect(h.action).toMatchObject({ id: 'not-registered', button: 'Try again', do: 'poll' });
  expect(h.action.text).toMatch(/It registers again before each poll until it succeeds\.$/);
  await expect(page.locator('[data-test=chip][data-channel=network] [data-test=chip-text]')).toHaveText('Not registered');

  // Try again: the poll registers first, and central takes it this time
  await page.locator('[data-test=action-button]').click();
  await expect.poll(async () => (await health(page)).reasons.map((r) => r.id), { timeout: LOAD_TIMEOUT }).not.toContain('not-registered');
  expect((await page.evaluate(() => window.satori.status())).central.registration).toMatchObject({ ok: true, walletMismatch: false });
  await polled(page); // that poll, done
  // registered: the next poll does not register again
  await page.evaluate(() => window.satori.poll());
  expect(central.polls).toEqual([4, 5, 5]); // how many registers came before each poll
  h = await health(page);
  expect(h).toMatchObject({ status: 'ok', title: 'Predicting' });
  expect(central.prod).toEqual([]);
});

test('starting: a new neuron polls at once, calm while it gets its first predictions, then predicting with no Poll now; the days before it are not closed days', async ({ context, page }) => {
  const { central } = await setup(context);
  centralAt(central, nowS() - 60);
  const release = central.hold(); // the first poll runs at once after register; held here to see it
  await openApp(page);
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, walletWords: w }), [PASS, v.words]);
  const h = await health(page);
  expect(h).toMatchObject({ status: 'idle', title: 'Starting', line: 'Getting its first predictions…', action: null });
  expect(h.channels.network.text).toBe('First poll now…');
  expect(h.work).toMatchObject({ task: 'central', step: 'observations', text: "Fetching today's observations…" });
  await expect(page.locator('[data-test=health-line]')).toHaveText("Fetching today's observations…"); // the step it is on
  await expect.poll(() => central.polls).toEqual([1]); // after the register
  expect(h.days.at(-1)).toMatchObject({ code: 'closed', ran: true, today: true });
  expect(h.days.slice(0, -1).every((d) => d.code === 'before' && !d.ran)).toBe(true);
  const before = page.locator('[data-test=day][data-code=before]');
  await expect(before).toHaveCount(29);
  await expect(before.first()).toHaveAttribute('title', /^\w+ \d+: Before this app$/);
  await expect(page.locator('[data-test=days-summary]')).toHaveText('0 full days');
  release();
  await expect(hero(page)).toHaveAttribute('data-s', 'ok', { timeout: LOAD_TIMEOUT }); // history, bvar
  await expect(page.locator('[data-test=health-line]')).toHaveText('Sent 8 predictions just now · next in 11 h');
  await expect(page.locator('[data-test=day]').last()).toHaveAttribute('data-code', 'full');
  await expect(page.locator('[data-test=days-summary]')).toHaveText('1 full day');
  await shots(page, 'new');

  // Today, tapped: the card shows its predictions and the contract's day; tapped again, it closes. Days before: not tappable.
  await expect(before.first()).toBeDisabled();
  const today = page.locator('[data-test=day].today');
  const panel = page.locator('[data-test=day-detail]');
  await today.click();
  await expect(today).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toHaveAttribute('data-open', 'true');
  await expect(panel.locator('[data-test=day-network]')).toHaveText(/^Sent 8 predictions, at \d+:\d\d [AP]M\.$/);
  await expect(panel.locator('[data-test=day-contract]')).toHaveText(/^Not sent/);
  await today.click();
  await expect(panel).toHaveAttribute('data-open', 'false');
  await expect(today).toHaveAttribute('aria-pressed', 'false');
  expect(central.prod).toEqual([]);
});

test('starting with a wallet mismatch: the title says Starting; the mismatch leads the status, the line and the card', async ({ context, page }) => {
  const { central } = await setup(context);
  central.otherWallet = fx.vectors[3].ethAddress; // central pays this wallet's rewards to another Base address
  const release = central.hold(); // the first poll runs at once after register; held here to see the title before it
  await start(page);
  await expect(hero(page)).toHaveAttribute('data-s', 'warn'); // registered: the mismatch
  let h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Starting', line: "The Satori Network pays this wallet's rewards to another address.",
    action: { id: 'wallet-mismatch', button: 'Link this wallet', do: 'relink' } });
  expect(h.reasons.map((r) => r.id)).toEqual(['wallet-mismatch', 'starting']);
  await expect(page.locator('[data-test=health-title]')).toHaveText('Starting');
  await expect(page.locator('[data-test=health-line]')).toHaveText("Fetching today's observations…"); // the poll, held: its step
  await expect(page.locator('[data-test=action]')).toHaveAttribute('data-action', 'wallet-mismatch');

  // The first poll: predicting, the mismatch still there.
  centralAt(central, nowS() - 60);
  release();
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting', { timeout: LOAD_TIMEOUT }); // history, bvar
  h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Predicting', action: { id: 'wallet-mismatch' } });
  await expect(hero(page)).toHaveAttribute('data-s', 'warn');
  expect(central.prod).toEqual([]);
});

test("traffic: a chip glows while its channel talks and fades after; the status is untouched; reduced motion is still", async ({ context, page }) => {
  const { central } = await setup(context);
  centralAt(central, nowS() - 60);
  await start(page);
  await polled(page);
  const chip = (c) => page.locator(`[data-test=chip][data-channel=${c}]`);
  await expect(chip('network')).not.toHaveAttribute('data-live', { timeout: 15_000 }); // quiet after the first poll

  // A poll: central's stub serves it (held here), so the Central chip glows; its status stays ok.
  const release = central.hold();
  const before = Date.now();
  await page.evaluate(() => void window.satori.poll());
  await expect(chip('network')).toHaveAttribute('data-live', '');
  await expect(chip('network')).toHaveAttribute('data-state', 'ok');
  const h = await health(page);
  expect(h.channels.network.lastTraffic).toBeGreaterThanOrEqual(before);
  expect(h.channels.network.lastTraffic).toBeLessThanOrEqual(Date.now());
  expect(await chip('network').evaluate((el) => getComputedStyle(el, '::after').opacity)).not.toBe('0'); // fading in or in
  release();
  await expect.poll(async () => (await health(page)).channels.network.lastTraffic).toBeGreaterThan(h.channels.network.lastTraffic);
  await expect(chip('network')).not.toHaveAttribute('data-live', { timeout: 10_000 }); // 1.5 s after the last, then the fade
  await expect.poll(() => chip('network').evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('0');

  // Base's RPC (the fake chain behind /rpc) glows the Base chip.
  await page.evaluate(() => window.satori.base());
  expect((await health(page)).channels.contract.lastTraffic).toBeGreaterThanOrEqual(before);

  // prefers-reduced-motion: no fades, a still tint.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await chip('network').evaluate((el) => getComputedStyle(el, '::after').transitionDuration)).toBe('0s');
  expect(central.prod).toEqual([]);
});

test('an iPhone: Setup and Settings say how Satori runs; the hero says Keep Satori open while it works; Home offers Add to Home Screen, once', async ({ browser }) => {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const { central } = await setup(context);
  centralAt(central, nowS() - 60);
  const RUNS = "Satori works while it's open. Leave it open, or install it, and it predicts on its own.";
  const ADD = 'Add it to your Home Screen (Share › Add to Home Screen): it opens on its own screen and keeps your keys. '
    + 'The added app starts empty: set it up there, or restore it from your 24 words.';
  await openApp(page);
  await expect(page.locator('.setup [data-test=runs-while-open]')).toHaveText(RUNS);
  await expect(page.locator('.setup [data-test=install-hint]')).toHaveText(ADD); // no prompt on iOS: how to add it
  expect((await page.evaluate(() => window.satori.status())).app).toMatchObject({ canInstall: false, addTo: 'ios' });

  // a phone: every step of the work says to keep Satori open, not only the sending
  const release = central.hold();
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, walletWords: w }), [PASS, v.words]); // central pays it: no mismatch
  await expect(page.locator('[data-test=health-line]')).toHaveText("Keep Satori open · Fetching today's observations…");
  await expect(hero(page)).toHaveAttribute('data-tone', 'working'); // the words, not the colour: vivid stays for what is critical
  expect((await health(page)).work.text).toBe("Fetching today's observations…"); // agents read the step itself
  release();
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting', { timeout: LOAD_TIMEOUT });

  // Home: Add to Home Screen as advice (the words given are the backup: no Back up card before it); Got it puts it away, for good
  await expect(page.locator('[data-test=action]')).toHaveAttribute('data-action', 'install');
  await expect(page.locator('[data-test=action-text]')).toHaveText(`Satori works while it's open. ${ADD}`);
  await expect(hero(page)).toHaveAttribute('data-s', 'ok'); // advice: the hero stays green
  await page.locator('[data-test=action-button]').click(); // Got it
  await expect(page.locator('[data-test=action]')).toBeHidden();
  await page.reload();
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting', { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=action]')).toBeHidden();

  // Settings › This device says it too, with the same way to add it
  await page.evaluate(() => window.satori.go('settings'));
  await expect(page.locator('#settings-device [data-test=runs-while-open]')).toHaveText(RUNS);
  await expect(page.locator('#settings-device [data-test=install-hint]')).toHaveText(ADD);
  expect(central.prod).toEqual([]);
  await context.close();
});

test('the wallet linked from another app (a newer link held): Link this wallet signs a fresh one; the card goes', async ({ context, page }) => {
  const { central } = await setup(context);
  await start(page);
  central.heldIssued = nowS() + 2; // another app links this wallet now: newer than this one's
  await page.reload(); // it registers on each load
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=action]')).toHaveAttribute('data-action', 'wallet-mismatch', { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=action-text]')).toContainText('It refused the wallet\'s link: the link is older than the one held for this wallet.');
  await page.waitForTimeout(2500); // past the held link's issued
  const before = central.registered.length;
  await page.locator('[data-test=action-button]').click();
  await page.getByLabel('Wallet passphrase to link').fill(PASS);
  await page.locator('[data-unlock-for=card]').getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-test=action]')).not.toHaveAttribute('data-action', 'wallet-mismatch', { timeout: 30_000 });
  expect(central.registered.length).toBe(before + 1); // sent at once
  const link = Buffer.from(central.registered.at(-1)['wallet-link'], 'base64').toString('utf8');
  expect(Number(link.split('\n')[3].replace('issued: ', ''))).toBeGreaterThanOrEqual(central.heldIssued);
  expect((await page.evaluate(() => window.satori.status())).central.registration).toMatchObject({ wallet_address: v.ethAddress, walletLinkError: null });
});
