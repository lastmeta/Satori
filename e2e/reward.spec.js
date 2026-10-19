// The reward address (docs/design/central.md#the-reward-address) against the stub central: not read at load; Settings
// reads it when it opens (a value from before Base reads as not set), Save checks the address before any call, saves
// it signed in by the identity with its steps said, shows it shortened with Copy, and Home notes it; Clear; the agent
// API; central2 as it is today (its old check refuses every 0x address). No vault, no chain. SHOTS=1 writes
// docs/screenshots/reward-{set,none}-{phone,desktop}-{light,dark}.png (else the test's output).
import { expect, test } from '@playwright/test';
import { openApp, polled } from './load.js';
import { stubCentral } from './stub.js';

const POOL = '0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7'; // EIP-55
const OLD = 'EXmPLeRewardAddressFromBeforeBase1'; // what central may still hold until its migration: never shown

const status = (page) => page.evaluate(() => window.satori.status());
const go = (page, tab) => page.evaluate((t) => window.satori.go(t), tab);

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
  stub.reward = OLD;
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
  await polled(page);
  expect(stub.rewardCalls).toEqual([]); // not read at load: only when it is shown or asked for
  expect((await status(page)).central.reward).toEqual({ address: null, at: null, error: null, reading: false });

  // Settings opens: read, signed in; the value from before Base is not set.
  await go(page, 'settings');
  const card = page.locator('#settings-reward');
  await expect(card.locator('[data-test=reward-none]')).toHaveText('Not set · rewards go to your vault');
  await expect(card.locator('[data-test=reward-address]')).toBeHidden();
  await expect(card.locator('[data-test=reward-clear]')).toBeHidden();
  expect(stub.rewardCalls).toEqual([{ method: 'GET', body: null, authorization: expect.stringMatching(/^Bearer jwt-\d+$/) }]);
  await expect(card).not.toContainText(OLD);
  expect((await status(page)).central.reward).toMatchObject({ address: null, error: null });
  await go(page, 'home');
  await go(page, 'settings');
  expect(stub.rewardCalls).toHaveLength(1); // once per page load
  await expect(page.locator('body')).not.toContainText(OLD);
  await shots(page, 'none');

  // Checked before any call: a typo in the checksum, not a Base address.
  const input = card.getByLabel('New reward address');
  const save = card.locator('[data-test=reward-save]');
  await input.fill(POOL.replace('D5f', 'd5f'));
  await save.click();
  await expect(card.locator('[data-test=reward-error]')).toHaveText("That address's capital letters don't match its checksum: check it for a typo.");
  await input.fill(OLD);
  await save.click();
  await expect(card.locator('[data-test=reward-error]')).toHaveText('A reward address is a Base address: 0x and 40 hex characters.');
  expect(stub.rewardCalls).toHaveLength(1);

  // Save: its steps said, at Home's pace, while the Satori Network answers; sent checksummed.
  let release;
  stub.rewardHold = new Promise((r) => { release = r; });
  await input.fill(POOL.toLowerCase());
  await save.click();
  await expect(save).toHaveText('Saving…');
  await expect(save).toBeDisabled();
  await expect(card.locator('[data-test=reward-error]')).toBeHidden();
  await expect(card.locator('[data-test=reward-line]')).toHaveText('Saving the reward address…');
  expect((await page.evaluate(() => window.satori.health())).work).toMatchObject({ task: 'reward', step: 'save', critical: false });
  release();
  stub.rewardHold = null;
  await expect(card.locator('[data-test=reward-line]')).toHaveText(`Saved: the Satori Network sends this neuron's rewards to ${POOL}.`);
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
  await expect(card.locator('[data-test=reward-line]')).toHaveText(`Saved: the Satori Network sends this neuron's rewards to ${POOL}.`);
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
  expect(await page.evaluate(() => window.satori.rewardAddress())).toMatchObject({ address: null });
  expect(await page.evaluate((a) => window.satori.setRewardAddress(a), POOL.toLowerCase())).toMatchObject({ address: POOL });
  expect(await page.evaluate(() => window.satori.rewardAddress())).toMatchObject({ address: POOL });
  const n = stub.rewardCalls.length;
  await expect(page.evaluate(() => window.satori.setRewardAddress('0x123'))).rejects.toThrow('A reward address is a Base address');
  await expect(page.evaluate(() => window.satori.setRewardAddress(`0x${'0'.repeat(40)}`))).rejects.toThrow('The zero address');
  expect(stub.rewardCalls).toHaveLength(n);
  expect(await page.evaluate(() => window.satori.setRewardAddress(''))).toMatchObject({ address: null });
  stub.reward = OLD;
  expect(await page.evaluate(() => window.satori.rewardAddress())).toMatchObject({ address: null });

  // central2 today: its old check refuses every 0x address; said in its words, nothing changed.
  stub.rewardRefuse = 'Invalid Evrmore address';
  await go(page, 'settings');
  await input.fill(POOL);
  await save.click();
  await expect(card.locator('[data-test=reward-error]')).toHaveText('Satori Network 400: Invalid Evrmore address');
  await expect(card.locator('[data-test=reward-none]')).toHaveText('Not set · rewards go to your vault');
  await expect(page.evaluate((a) => window.satori.setRewardAddress(a), POOL)).rejects.toThrow('Satori Network 400: Invalid Evrmore address');
  expect(errors).toEqual([]);
});
