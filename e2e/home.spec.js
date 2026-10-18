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
  for (const tab of ['models', 'streams', 'wallet', 'settings', 'home']) {
    await page.evaluate((t) => window.satori.go(t), tab);
    const r = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const shown = (el) => box(el).width > 0 && box(el).height > 0;
      const small = [...document.querySelectorAll('button, input:not([type=checkbox]), select, textarea, summary, nav a, a.chan, a.mrow')]
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

test('ok, then warn (Stake from the action card, with the inline Unlock), then ok on Base too', async ({ context, page }) => {
  test.setTimeout(240_000);
  const { s, rpc, central } = await setup(context);
  await seed(page, month(nowS(), { closed: [6, 7], part: [3] }));
  centralAt(central, nowS() - 60);
  await start(page);
  const st = await page.evaluate(() => window.satori.base());
  rpc.eth[st.identity.address.toLowerCase()] = 10n ** 17n;
  rpc.eth[st.vault.address.toLowerCase()] = 10n ** 17n;
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
  await expect(chip('network').locator('[data-test=chip-text]')).toHaveText('Up to date · next in 11 h');
  await expect(page.locator('[data-test=health-line]')).toHaveText('Up to date · next in 11 h');
  await expect(page.locator('[data-test=feed-item]').filter({ hasText: 'Checked the Satori Network: up to date' })).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The vault gets SATORI: Base needs one step from the person. One card, one button.
  s.balance[st.vault.address.toLowerCase()] = 100n * E18;
  await page.evaluate(() => window.satori.base());
  h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'The Satori Network is fine. The Satori contract needs one step from you.',
    action: { id: 'stake', text: "Your vault's SATORI isn't earning on the Satori contract. Stake with this neuron.", button: 'Stake', do: 'stake' },
    channels: { contract: { state: 'warn', text: 'Not staked' } } });
  await expect(hero(page)).toHaveAttribute('data-s', 'warn');
  await expect(page.locator('[data-test=action]')).toHaveAttribute('data-action', 'stake');
  await expect(page.locator('[data-test=claimable-amount]')).toHaveText('0');
  await shots(page, 'warn');
  await phoneChecks(page, 360, 740); // with the action card, the answer still fits
  await page.setViewportSize({ width: 1280, height: 900 });

  // Stake: the vault is locked, so the passphrase is asked for in the card; then it stakes.
  await page.locator('[data-test=action-button]').click();
  const prompt = page.getByLabel('Vault passphrase to stake');
  await expect(prompt).toBeVisible();
  await prompt.fill('not it');
  await page.locator('[data-unlock-for=card]').getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-unlock-for=card] [role=alert]')).toHaveText('Wrong passphrase');
  await prompt.fill(PASS);
  await page.locator('[data-unlock-for=card]').getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-test=action]')).toBeHidden({ timeout: 30_000 }); // staked: nothing needs the person
  expect(rpc.sent.map((t) => t.functionName)).toEqual(['setPredictorFee', 'setAllowedDelegator', 'delegatePredictionPower']);
  // the identity's batch, on its own, 10 s after staking
  await expect(chip('contract').locator('[data-test=chip-text]')).toHaveText(`Round ${ROUND} sent`, { timeout: 30_000 });
  h = await health(page);
  expect(h).toMatchObject({ status: 'ok', channels: { contract: { state: 'ok', text: `Round ${ROUND} sent` } } });
  const texts = h.feed.map((f) => f.text);
  expect(texts.indexOf(`Satori contract batch for round ${ROUND}: 1 game`)).toBeLessThan(texts.indexOf('Staked with this neuron')); // newest first

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

  // A chip goes to its tab; tabs are hash routes, kept over a reload.
  await chip('contract').click();
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

test('bad: central refuses two batches in a row, then the login; the card goes to the fix', async ({ context, page }) => {
  test.setTimeout(240_000);
  const { central } = await setup(context);
  await seed(page, month(nowS(), { closed: [12], part: [5] }));
  centralAt(central, nowS() - 3 * H);
  await start(page);
  await polled(page); // the first poll, at once
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');

  // Once: retrying (warn), still predicting. Twice in a row: not predicting (bad).
  centralAt(central, nowS() - 2 * H, 601);
  central.fail.push(500, 500); // a 5xx is resent once
  await page.evaluate(() => window.satori.poll());
  let h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Predicting', action: { id: 'central-failed', button: 'Try again', do: 'poll' } });
  expect(h.line).toMatch(/^The last poll failed; next try in 11 h\.$/);
  centralAt(central, nowS() - H, 602);
  central.fail.push(500, 500);
  await page.evaluate(() => window.satori.poll());
  await expect(hero(page)).toHaveAttribute('data-s', 'bad');
  await expect(page.locator('[data-test=health-title]')).toHaveText('Not predicting');
  await expect(page.locator('[data-test=health-line]')).toHaveText('The Satori Network refused the last 2 batches.');
  await expect(page.locator('[data-test=action-text]')).toHaveText("Satori Network 500: boom. Try again now, or check the Satori Network's address in Settings.");
  await expect(page.locator('[data-test=chip][data-channel=network] [data-test=chip-text]')).toHaveText('2 failed in a row');
  await expect(page.locator('[data-test=day]').last()).toHaveAttribute('data-code', 'full'); // today's first poll went out
  await shots(page, 'bad');

  // Try again: central takes the kept batch; then it refuses the login (bad at once), and the card opens Settings there.
  await page.locator('[data-test=action-button]').click();
  await expect(hero(page)).toHaveAttribute('data-s', 'ok');
  centralAt(central, nowS() - 30, 603);
  central.refuseLogin = true;
  await page.evaluate(() => window.satori.poll());
  h = await health(page);
  expect(h).toMatchObject({ status: 'bad', line: "The Satori Network refused this neuron's login.",
    action: { id: 'login-refused', button: 'Open Settings', do: 'go', tab: 'settings', section: 'central' },
    channels: { network: { state: 'bad', text: 'Login refused' } } });
  await page.locator('[data-test=action-button]').click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByLabel('Satori Network server')).toBeInViewport();
  expect(central.prod).toEqual([]);
});

test('starting: a new neuron polls at once, calm while it gets its first predictions, then predicting with no Poll now; the days before it are not closed days', async ({ context, page }) => {
  const { central } = await setup(context);
  centralAt(central, nowS() - 60);
  const release = central.hold(); // the first poll runs at once after register; held here to see it
  await openApp(page);
  await page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, vaultWords: w }), [PASS, v.words]);
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
  await expect(before.first()).toHaveAttribute('title', /^\w+ \d+: Before this neuron$/);
  await expect(page.locator('[data-test=days-summary]')).toHaveText('0 full days');
  release();
  await expect(hero(page)).toHaveAttribute('data-s', 'ok', { timeout: LOAD_TIMEOUT }); // history, bvar
  await expect(page.locator('[data-test=health-line]')).toHaveText('Sent 8 predictions just now · next in 11 h');
  await expect(page.locator('[data-test=day]').last()).toHaveAttribute('data-code', 'full');
  await expect(page.locator('[data-test=days-summary]')).toHaveText('1 full day');
  await shots(page, 'new');
  expect(central.prod).toEqual([]);
});

test('starting with a vault mismatch: the title says Starting; the mismatch leads the status, the line and the card', async ({ context, page }) => {
  const { central } = await setup(context);
  central.otherVault = fx.vectors[3].ethAddress; // central pays this vault's rewards to another Base address
  const release = central.hold(); // the first poll runs at once after register; held here to see the title before it
  await start(page);
  await expect(hero(page)).toHaveAttribute('data-s', 'warn'); // registered: the mismatch
  let h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Starting', line: "The Satori Network pays this vault's rewards to another address.",
    action: { id: 'vault-mismatch', button: 'Open Settings', do: 'go', tab: 'settings', section: 'keys' } });
  expect(h.reasons.map((r) => r.id)).toEqual(['vault-mismatch', 'starting']);
  await expect(page.locator('[data-test=health-title]')).toHaveText('Starting');
  await expect(page.locator('[data-test=health-line]')).toHaveText("Fetching today's observations…"); // the poll, held: its step
  await expect(page.locator('[data-test=action]')).toHaveAttribute('data-action', 'vault-mismatch');

  // The first poll: predicting, the mismatch still there.
  centralAt(central, nowS() - 60);
  release();
  await expect(page.locator('[data-test=health-title]')).toHaveText('Predicting', { timeout: LOAD_TIMEOUT }); // history, bvar
  h = await health(page);
  expect(h).toMatchObject({ status: 'warn', title: 'Predicting', action: { id: 'vault-mismatch' } });
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
