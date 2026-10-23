// The reward address (docs/design/central.md#the-reward-address) against the stub central: not read at load; Settings
// reads it when it opens (its moving mark and words meanwhile), Save checks the address before any call (this
// neuron's identity refused), saves it signed in by the identity with its steps said and the mark turning, shows it
// shortened with Copy, and Home notes it; Clear; this app's vault and identity named; the agent API; a refusal; another
// Satori Network forgets the last words. No vault, no chain. SHOTS=1 writes
// docs/screenshots/reward-{none,set,identity}-{phone,desktop}-{light,dark}.png and reward-saving-phone-light.png (else the
// test's output).
import { expect, test } from '@playwright/test';
import { openApp, polled } from './load.js';
import { stubCentral } from './stub.js';

const POOL = '0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7'; // EIP-55
const IDENTITY = "That is this app's alias. This app claims rewards only from the vault, so rewards sent to the "
  + 'alias would sit unclaimed. Use another address, or Clear to send them to your vault.';

const status = (page) => page.evaluate(() => window.satori.status());
const go = (page, tab) => page.evaluate((t) => window.satori.go(t), tab);
/** The page's running CSS animations: [where] ('<class><pseudo>'). */
const animations = (page) => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSAnimation)
  .map((a) => `${a.effect.target.className}${a.effect.pseudoElement ?? ''}`));
/** Hold the stub's reward-address calls until the function it returns is called. */
const hold = (stub) => {
  let release;
  stub.rewardHold = new Promise((r) => { release = r; });
  return () => { stub.rewardHold = null; release(); };
};

async function shots(page, name) {
  const dir = process.env.SHOTS ? 'docs/screenshots' : test.info().outputPath();
  const top = (block) => page.evaluate((b) => document.getElementById('settings-reward').scrollIntoView({ block: b }), block);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await top('start');
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${dir}/reward-${name}-phone-${scheme}.png` });
    await page.setViewportSize({ width: 1280, height: 900 });
    await top('center');
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${dir}/reward-${name}-desktop-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('reward address: read when Settings opens, checked, saved with its steps, shown, noted on Home, cleared; the agent API', async ({ context, page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const stub = await stubCentral(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  const { identity, vault } = await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
  await polled(page);
  expect(stub.rewardCalls).toEqual([]); // not read at load: only when it is shown or asked for
  expect((await status(page)).central.reward).toEqual({ address: null, whose: null, at: null, error: null, reading: false });

  // Settings opens: read, signed in; its moving mark and words while the Satori Network answers; then not set.
  const card = page.locator('#settings-reward');
  let release = hold(stub);
  await go(page, 'settings');
  await expect(card.locator('[data-test=reward-none]')).toHaveText('Reading it from the Satori Network…');
  await expect(card.locator('[data-test=reward-reading]')).toBeVisible();
  expect(await animations(page)).toEqual(['spin::after']); // the one moving thing on the screen
  release();
  await expect(card.locator('[data-test=reward-none]')).toHaveText('Not set · rewards go to your vault');
  await expect(card.locator('[data-test=reward-reading]')).toBeHidden();
  expect(await animations(page)).toEqual([]);
  await expect(card.locator('[data-test=reward-address]')).toBeHidden();
  await expect(card.locator('[data-test=reward-whose]')).toBeHidden();
  await expect(card.locator('[data-test=reward-clear]')).toBeHidden();
  expect(stub.rewardCalls).toEqual([{ method: 'GET', body: null, authorization: expect.stringMatching(/^Bearer jwt-\d+$/) }]);
  expect((await status(page)).central.reward).toMatchObject({ address: null, whose: null, error: null });
  await go(page, 'home');
  await go(page, 'settings');
  expect(stub.rewardCalls).toHaveLength(1); // once per page load
  await shots(page, 'none');

  // Checked before any call: a typo in the checksum, not a Base address, this app's own identity.
  const input = card.getByLabel('New reward address');
  const save = card.locator('[data-test=reward-save]');
  await input.fill(POOL.replace('D5f', 'd5f'));
  await save.click();
  await expect(card.locator('[data-test=reward-error]')).toHaveText("That address's capital letters don't match its checksum: check it for a typo.");
  await input.fill(POOL.slice(0, -2));
  await save.click();
  await expect(card.locator('[data-test=reward-error]')).toHaveText('A reward address is a Base address: 0x and 40 hex characters.');
  await input.fill(identity.toLowerCase());
  await save.click();
  await expect(card.locator('[data-test=reward-error]')).toHaveText(IDENTITY);
  expect(stub.rewardCalls).toHaveLength(1);

  // Save: its steps said, at Home's pace, the mark turning, while the Satori Network answers; sent checksummed.
  release = hold(stub);
  await input.fill(POOL.toLowerCase());
  await save.click();
  await expect(save).toHaveText('Saving…');
  await expect(save).toBeDisabled();
  await expect(card.locator('[data-test=reward-error]')).toBeHidden();
  await expect(card.locator('[data-test=reward-line]')).toHaveText('Saving the reward address…');
  await expect(card.locator('[data-test=reward-saving]')).toBeVisible();
  expect(await animations(page)).toEqual(['spin::after']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.getElementById('settings-reward').scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: process.env.SHOTS ? 'docs/screenshots/reward-saving-phone-light.png' : test.info().outputPath('reward-saving.png') });
  expect((await page.evaluate(() => window.satori.health())).work).toMatchObject({ task: 'reward', step: 'save', critical: false });
  release();
  await expect(card.locator('[data-test=reward-line]')).toHaveText(`Saved: the Satori Network sends this app's rewards to ${POOL}.`);
  await expect(card.locator('[data-test=reward-saving]')).toBeHidden();
  await expect(save).toHaveText('Save');
  expect(stub.rewardCalls.at(-1)).toMatchObject({ method: 'POST', body: { reward_address: POOL } });
  expect(stub.reward).toBe(POOL);
  await expect(card.locator('[data-test=reward-address]')).toHaveText('0x3a91…B6E7');
  await expect(card.locator('[data-test=reward-address]')).toHaveAttribute('title', POOL);
  await expect(card.locator('[data-test=reward-none]')).toBeHidden();
  await expect(card.locator('[data-test=reward-clear]')).toBeVisible();
  await expect(input).toHaveValue('');
  expect((await status(page)).central.reward).toMatchObject({ address: POOL, error: null });
  await shots(page, 'set');
  // phone: nothing scrolls sideways; the buttons are tap-sized
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  for (const el of await card.locator('button:visible, input:visible').all()) {
    const { width, height } = await el.boundingBox();
    expect(Math.min(width, height), await el.evaluate((e) => e.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // Home notes it for a day, with the whole address.
  const h = await page.evaluate(() => window.satori.health());
  expect(h.notices[0]).toMatchObject({ what: 'reward', text: `Reward address set to ${POOL}` });
  expect(h.status).not.toBe('bad');

  // Saving the same again is no change; Clear: back to the vault, noted.
  await input.fill(POOL);
  await save.click();
  await expect(card.locator('[data-test=reward-line]')).toHaveText(`Saved: the Satori Network sends this app's rewards to ${POOL}.`);
  await card.locator('[data-test=reward-clear]').click();
  await expect(card.locator('[data-test=reward-none]')).toHaveText('Not set · rewards go to your vault');
  await expect(card.locator('[data-test=reward-line]')).toHaveText('Cleared: rewards go to your vault.');
  expect(stub.rewardCalls.at(-1)).toMatchObject({ method: 'POST', body: { reward_address: null } });
  expect(stub.reward).toBeNull();
  const notices = (await page.evaluate(() => window.satori.health())).notices.filter((n) => n.what === 'reward');
  expect(notices.map((n) => n.text)).toEqual(['Reward address cleared: rewards go to your vault', `Reward address set to ${POOL}`]);
  await go(page, 'home');
  await expect(page.locator('[data-test=notice-line][data-what=reward]').first()).toContainText('Reward address cleared: rewards go to your vault');

  // The agent API: read, set (lower case in, checksummed out), refused before any call, cleared with ''.
  expect(await page.evaluate(() => window.satori.rewardAddress())).toMatchObject({ address: null, whose: null });
  expect(await page.evaluate((a) => window.satori.setRewardAddress(a), POOL.toLowerCase())).toMatchObject({ address: POOL, whose: null });
  expect(await page.evaluate(() => window.satori.rewardAddress())).toMatchObject({ address: POOL });
  const n = stub.rewardCalls.length;
  await expect(page.evaluate(() => window.satori.setRewardAddress('0x123'))).rejects.toThrow('A reward address is a Base address');
  await expect(page.evaluate(() => window.satori.setRewardAddress(`0x${'0'.repeat(40)}`))).rejects.toThrow('The zero address');
  await expect(page.evaluate((a) => window.satori.setRewardAddress(a), identity)).rejects.toThrow(IDENTITY);
  expect(stub.rewardCalls).toHaveLength(n);
  expect(await page.evaluate(() => window.satori.setRewardAddress(''))).toMatchObject({ address: null });

  // Central holds this app's own address (an old value reads as the same key's Base address: central 8dcc016): named.
  await go(page, 'settings');
  stub.reward = vault.toLowerCase();
  expect(await page.evaluate(() => window.satori.rewardAddress())).toMatchObject({ address: vault, whose: 'vault' });
  await expect(card.locator('[data-test=reward-whose]')).toHaveText('your vault');
  await expect(card.locator('[data-test=reward-identity]')).toBeHidden();
  await expect(card.locator('[data-test=reward-line]')).toBeHidden(); // the last save's words ("Cleared: …") went with the read
  stub.reward = identity;
  expect(await page.evaluate(() => window.satori.rewardAddress())).toMatchObject({ address: identity, whose: 'identity' });
  await expect(card.locator('[data-test=reward-whose]')).toHaveText('your alias');
  await expect(card.locator('[data-test=reward-identity]')).toContainText("rewards sent there aren't claimed here");
  await expect(card.locator('[data-test=reward-clear]')).toBeVisible();
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await shots(page, 'identity');
  await page.setViewportSize({ width: 390, height: 844 });

  // A refusal is said in the Satori Network's words; nothing changes.
  stub.rewardRefuse = 'Invalid Base address';
  await input.fill(POOL);
  await save.click();
  await expect(card.locator('[data-test=reward-error]')).toHaveText('Satori Network 400: Invalid Base address');
  await expect(card.locator('[data-test=reward-whose]')).toHaveText('your alias');
  await expect(page.evaluate((a) => window.satori.setRewardAddress(a), POOL)).rejects.toThrow('Satori Network 400: Invalid Base address');
  stub.rewardRefuse = null;

  // Another Satori Network: the last one's words go; its reward address is read (Settings is open).
  await card.locator('[data-test=reward-clear]').click();
  await expect(card.locator('[data-test=reward-line]')).toHaveText('Cleared: rewards go to your vault.');
  await input.fill('0x123');
  await save.click();
  await expect(card.locator('[data-test=reward-error]')).toBeVisible();
  const other = await stubCentral(context, { url: 'https://central.test' });
  other.reward = POOL;
  await page.evaluate(() => window.satori.setCentral('https://central.test'));
  await expect(card.locator('[data-test=reward-address]')).toHaveText('0x3a91…B6E7');
  await expect(card.locator('[data-test=reward-line]')).toBeHidden();
  await expect(card.locator('[data-test=reward-error]')).toBeHidden();
  expect(other.rewardCalls).toEqual([expect.objectContaining({ method: 'GET' })]);
  expect(errors).toEqual([]);
});
