// The Dev Fee tab (docs/design/devfee.md) against test/fake-satori.js's splitters (A 60 % C, 40 % B; C and B 50/50)
// behind /rpc: hidden for a wallet not in them; for a payee of C, its share, Claim (what waits in A moved down first)
// with the inline Unlock, who can trigger its payout, Redirect's tally and a vote, the authority's card, and Move your
// slot, after which the tab goes.
import { expect, test } from '@playwright/test';
import { fakeSatori, E18, SPLIT_A, SPLIT_B, SPLIT_C } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const NEW = `0x${'ab'.repeat(20)}`;
const t = (page, id) => page.locator(`[data-test=${id}]`);

test('Dev Fee: only for a wallet in the splitters; its share, Claim, the trigger, Redirect, the authority, Move your slot', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc } = fakeSatori();
  page.on('pageerror', (e) => { throw e; });
  await stubCentral(context, { rpc });
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const V = (await page.evaluate(() => window.satori.base())).wallet.address.toLowerCase();

  // not in the splitters: no tab, and go('devfee') refuses
  expect(await page.evaluate(() => window.satori.devFee())).toMatchObject({ shown: false, top: expect.stringMatching(/^0x6C57/i) });
  await expect(t(page, 'nav-devfee')).toBeHidden();
  await expect(t(page, 'tab-devfee')).toBeHidden();
  expect(await page.evaluate(() => { try { window.satori.go('devfee'); return 'went'; } catch (e) { return e.message; } })).toMatch(/only for a wallet in the dev fee's splitters/);

  // a payee of C: 100 SATORI in A (C's 60 % → 30 for the wallet) and 10 in C (5 for it)
  s.splitters[SPLIT_C].slots[0].payee = V;
  s.balance[SPLIT_A] = 100n * E18;
  s.balance[SPLIT_C] = 10n * E18;
  rpc.eth[V] = 10n ** 17n;
  const view = await page.evaluate(() => window.satori.devFee());
  expect(view.splitters.find((x) => x.mine)).toMatchObject({ address: expect.stringMatching(/^0x52b7/i), parent: expect.stringMatching(/^0x6C57/i),
    thresholdPct: 90, mine: { slotId: 0, pct: 50, wholePct: 30, claimable: '5', waiting: '30' } });
  await expect(t(page, 'nav-devfee')).toBeVisible();
  await page.evaluate(() => window.satori.go('devfee'));
  const slot = t(page, 'devfee-slot');
  await expect(slot.locator('[data-test=devfee-share]')).toHaveText('50% of this splitter · 30% of the whole dev fee');
  await expect(slot.locator('[data-test=devfee-claimable]')).toHaveText('35 SATORI');
  await expect(slot.locator('[data-test=devfee-waiting]')).toHaveText('30 SATORI of it is still in the top splitter: Claim moves it down to yours first (two transactions).');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('devfee-phone.png'), fullPage: true });

  // Claim, locked: the passphrase in the card, then the two transactions
  await slot.getByRole('button', { name: 'Claim' }).click();
  await slot.getByLabel('Wallet passphrase to claim or change your dev fee slot').fill(PASS);
  await slot.getByRole('button', { name: 'Unlock' }).click();
  await expect(slot.locator('[data-test=devfee-result]')).toHaveText('Claimed 35 SATORI.', { timeout: 30_000 });
  expect(s.balance[V]).toBe(35n * E18);
  expect(rpc.sent.filter((x) => x.functionName === 'withdraw').map((x) => x.to.toLowerCase())).toEqual([SPLIT_A, SPLIT_C]);
  await expect(slot.locator('[data-test=devfee-claimable]')).toHaveText('0 SATORI');
  await expect(slot.locator('[data-test=devfee-claim]')).toBeHidden();

  // the rest unlocked (an in-card Unlock locks the wallet again after its action, as Claim on the Wallet tab)
  await page.evaluate((p) => window.satori.unlock(p), PASS);
  // who can trigger the payout: one address, saved
  await slot.locator('[data-test=devfee-trigger-card] summary').click();
  await slot.locator('[data-test=devfee-trigger-to]').fill(NEW);
  await slot.locator('[data-test=devfee-trigger]').click();
  await expect(slot.locator('[data-test=devfee-result]')).toHaveText(/^Only 0xabab…abab \(and you\) can trigger your payout now\.$/i);
  expect(s.splitters[SPLIT_C].trigger[0]).toBe(NEW);
  await expect(slot.locator('[data-test=devfee-trigger-card] summary')).toHaveText(/^Only 0xabab…abab can trigger your payout$/i);

  // Redirect C: the tally, then my agreement (C needs 90 %: both payees)
  const redirect = t(page, 'devfee-redirect');
  await redirect.locator('summary').click();
  await redirect.locator('[data-test=devfee-redirect-to]').fill(NEW);
  await redirect.locator('[data-test=devfee-redirect-check]').click();
  await expect(redirect.locator('[data-test=devfee-tally] p.small').last()).toHaveText('0% agree of 90% needed. Not enough yet. You have not agreed.');
  await redirect.locator('[data-test=devfee-vote]').click();
  await expect(redirect.locator('[data-test=devfee-result]')).toHaveText(/^You agreed to redirect it to 0xabab…abab\.$/i);
  await expect(redirect.locator('[data-test=devfee-tally] p.small').last()).toHaveText('50% agree of 90% needed. Not enough yet. You have agreed.');
  await expect(redirect.locator('[data-test=devfee-vote]')).toHaveText('Take back my agreement');

  // B's authority: its card; an offer, typed twice
  s.splitters[SPLIT_B].authority = V;
  await t(page, 'devfee-refresh').click();
  const auth = t(page, 'devfee-authority');
  await expect(auth.locator('h2')).toHaveText('Authority of Splitter 0xc082…F5f7');
  const offer = auth.locator('[data-test=devfee-offer]');
  await offer.getByLabel('Offer it to').fill(NEW);
  await offer.getByLabel('The same address again').fill(`0x${'ac'.repeat(20)}`);
  await offer.getByRole('button', { name: 'Offer' }).click();
  await expect(auth.locator('[data-test=devfee-error]')).toHaveText('The two addresses do not match.');
  await offer.getByLabel('The same address again').fill(NEW);
  await offer.getByRole('button', { name: 'Offer' }).click();
  await expect(auth.locator('[data-test=devfee-result]')).toHaveText(/^Offered to 0xabab…abab: it moves when they accept\.$/i);
  expect(s.splitters[SPLIT_B].pending).toBe(NEW);
  await page.screenshot({ path: test.info().outputPath('devfee-all-phone.png'), fullPage: true });
  s.splitters[SPLIT_B].authority = '0x0000000000000000000000000000000000000000';
  s.splitters[SPLIT_B].pending = '0x0000000000000000000000000000000000000000';

  // Move your slot: typed twice; then this wallet is no longer in the splitters, and the tab goes (Home)
  await slot.locator('[data-test=devfee-move-card] summary').click();
  const move = slot.locator('[data-test=devfee-move]');
  await move.getByLabel('New address').fill(NEW);
  await move.getByLabel('The same address again').fill(NEW);
  await move.getByRole('button', { name: 'Move my slot' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-tab', 'home', { timeout: 30_000 });
  expect(s.splitters[SPLIT_C].slots[0].payee).toBe(NEW);
  await expect(t(page, 'nav-devfee')).toBeHidden();
  await expect(t(page, 'tab-devfee')).toBeHidden();
});
