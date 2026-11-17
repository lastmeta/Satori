// A vote on the Streams tab (docs/design/base.md#vote), on the local fork of Base Sepolia (:8545, node scripts/fork.mjs
// start) with the real contracts: a fresh throwaway wallet funded there and a fresh stream whose game the admin approves
// there. Streams › Contract Streams on a phone: each stream's votes, Vote on the approved one, the amount typed, Burn and
// vote with the passphrase asked in place, the step with its turning ring, the weight read again. SHOTS=1 writes
// docs/screenshots/vote-* (the card, and the composer open, on a phone and a computer).
import { expect, test } from '@playwright/test';
import { createPublicClient, http, parseEther } from 'viem';
import { approveGame, fund, stream } from '../scripts/fork.mjs';
import { DEFAULTS } from '../src/chain/config.js';
import { votingAbi } from '../src/chain/abi.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';
import { FORK, forkRpc, forkUp } from './fork.js';

const PASS = 'correct horse battery';
const chain = createPublicClient({ transport: http(FORK) });
const weightOf = (gameId) => chain.readContract({ address: DEFAULTS.voting, abi: votingAbi, functionName: 'weightOf', args: [gameId] });
const shot = (page, name) => page.screenshot({ path: process.env.SHOTS ? `docs/screenshots/${name}.png` : test.info().outputPath(`${name}.png`) });

test('Streams › Contract Streams: the votes, and a vote burned for an approved game from the wallet, Unlock in place', async ({ context, page }) => {
  test.skip(!(await forkUp()), 'needs the local test chain on :8545: node scripts/fork.mjs start');
  test.setTimeout(300_000);
  await stubCentral(context, { rpc: forkRpc });
  await openApp(page);
  const st = await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('[data-test=alias]')).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: LOAD_TIMEOUT });
  await fund(FORK, [st.wallet], { eth: '0.1', satori: '10' });
  const name = `vote-${Date.now().toString(36)}`;
  const { streamId, gameId } = await stream(FORK, name); // anyone's stream; its game opened for votes by the admin
  await approveGame(FORK, gameId);
  const before = await weightOf(gameId);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.satori.go('streams'));
  const card = page.locator('[data-test=contract-streams]');
  await card.locator('summary').click();
  await expect(card.locator('[data-test=votes-status]')).toContainText("Each round's SATORI is split across these games by their votes.", { timeout: 60_000 });
  const row = card.locator(`[data-test=vote-stream][data-stream="${streamId}"]`);
  const satori = card.locator('[data-test=vote-stream][data-stream="1"]');
  await expect(satori.locator('[data-test=vote-weight]')).toHaveText(/^Its own share of each round( \(\d[\d.]*%\))?: takes no votes$/); // the default game
  await expect(satori.locator('[data-test=vote-open]')).toHaveCount(0); // no Vote
  await expect(row.locator('.sname')).toHaveText(name);
  await expect(row.locator('[data-test=vote-latest]')).toHaveText('1,000.00'); // fork.mjs stream's one value, a plain number
  await expect(row.locator('[data-test=vote-weight]')).toHaveText(before > 0n ? /^Votes: / : 'No votes yet');
  const panel = row.locator('[data-test=vote-panel]');
  await expect(panel).toHaveAttribute('data-open', 'false');
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'vote-card-phone');

  // Vote: the composer eases open under the row; the amount is the person's, the burn said before the button
  await row.locator('[data-test=vote-open]').click();
  await expect(panel).toHaveAttribute('data-open', 'true');
  await expect(row.locator('[data-test=vote-open]')).toHaveAttribute('aria-expanded', 'true');
  const amount = row.locator('[data-test=vote-amount]');
  await expect(amount).toHaveValue('');
  await expect(amount).toBeFocused();
  await expect(row.locator('[data-test=vote-balance]')).toHaveText('Balance: 10 SATORI');
  await expect(row.locator('[data-test=vote-burn]')).toHaveText("Voting burns this SATORI for good: it is destroyed and can't be taken back.");
  await expect(row.locator('[data-test=vote-send]')).toHaveText('Burn and vote');

  // more than the wallet holds: said before the passphrase, nothing sent
  await amount.fill('11');
  await row.locator('[data-test=vote-send]').click();
  const status = row.locator('[data-test=vote-status]');
  await expect(status).toHaveText("That is more than the wallet's 10 SATORI.");
  await expect(status).toHaveAttribute('data-error', 'true');
  await expect(row.locator('[data-test=unlock-prompt]')).toBeHidden();
  await amount.fill('2');
  await expect(row.locator('.vstatus')).toHaveAttribute('data-open', 'false'); // typing again: the line goes
  await page.waitForTimeout(400);
  await shot(page, 'vote-open-phone');

  // Burn and vote: locked, so the passphrase in place; then the step with its turning ring, then what it did
  await row.locator('[data-test=vote-send]').click();
  const prompt = row.locator('[data-unlock-for^="vote-"]');
  await expect(prompt).toBeVisible();
  await prompt.getByLabel('Wallet passphrase to burn and vote').fill(PASS);
  await prompt.getByRole('button', { name: 'Unlock' }).click();
  await expect(row.locator('[data-test=vote-status] .spin')).toBeVisible({ timeout: 30_000 }); // one moving mark while it works
  await expect(status).toContainText(/Sending|Waiting for Base to confirm|Checking it on Base/);
  await expect(status).toHaveText(`Voted: 2 SATORI burned for ${name}.`, { timeout: 120_000 });
  await expect(status).toHaveAttribute('data-error', 'false');
  expect(await weightOf(gameId)).toBe(before + parseEther('2'));
  await expect(row.locator('[data-test=vote-weight]')).toHaveText(/^Votes: \d[\d,.]* SATORI · \d[\d.]*% of each round$/, { timeout: 30_000 });
  await expect(row.locator('[data-test=vote-balance]')).toHaveText('Balance: 8 SATORI');
  await expect(amount).toHaveValue(''); // cleared for the next
  await expect(page.locator('[data-test=wallet-state]')).toHaveText('Locked'); // unlocked for the vote alone
  await shot(page, 'vote-done-phone');

  // a computer: the card, then the composer open
  await page.setViewportSize({ width: 1280, height: 900 });
  await row.locator('[data-test=vote-cancel]').click();
  await expect(panel).toHaveAttribute('data-open', 'false');
  await page.waitForTimeout(400);
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'vote-card-desktop');
  await row.locator('[data-test=vote-open]').click();
  await amount.fill('1.5');
  await page.waitForTimeout(400);
  await shot(page, 'vote-open-desktop');
});
