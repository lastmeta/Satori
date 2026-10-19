// Base in the app (docs/design/base.md), against a fake D6 behind /rpc
// (test/fake-satori.js, run in this test process) and a stub central2
// that serves a merkle proof: the status while locked, Unlock → Stake with
// this neuron, the identity's batch on its own, a round later the claims
// and the next batch, Unstake, when SATORI can be sent, sends; the agent API.
import { expect, test } from '@playwright/test';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const ROUND = 20741;
const DAY = 86400;

async function setup(context) {
  const chain = fakeSatori({ round: ROUND, hour: 9 });
  return { ...chain, central: await stubCentral(context, { rpc: chain.rpc }) };
}

const fact = (page, name) => page.locator(`[data-test=base-${name}]`);
const go = (page, tab) => page.evaluate((t) => window.satori.go(t), tab);
const ASKS = "Stake, Claim and Send ask for the vault's passphrase. The identity sends the daily batch to the Satori contract on its own; it uses gas (Base ETH).";
const sent = (rpc) => rpc.sent.map((t) => t.functionName);

test('the Base card: stake, the batch on its own, claims, unstake, when SATORI can be sent, sends', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc, central } = await setup(context);
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('[data-test=identity]')).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: LOAD_TIMEOUT });

  // Locked: the status needs no key; both Base addresses; no gas yet.
  let base = await page.evaluate(() => window.satori.base());
  const I = base.identity.address.toLowerCase();
  const V = base.vault.address.toLowerCase();
  await expect(page.locator('[data-test=identity]')).toHaveText(base.identity.address); // the Keys card shows the Base addresses
  await expect(page.locator('[data-test=vault]')).toHaveText(base.vault.address);
  expect(base).toMatchObject({ rpc: ['/rpc'], config: 'bundled', round: ROUND, vault: { staked: 'none', satori: '0' } });
  await go(page, 'wallet');
  await expect(fact(page, 'identity')).toHaveText('0 ETH · about 0 daily batches'); // no warning before staking
  await expect(fact(page, 'staking')).toHaveText('Not staked: Stake with this neuron, below');
  const CHOICE = 'Stake with this neuron to let it predict every round, or play Satori Daily by hand.';
  await expect(fact(page, 'play')).toHaveText(CHOICE);
  await expect(fact(page, 'play').getByRole('link', { name: 'Satori Daily' })).toHaveAttribute('href', 'https://app.satorinet.io');
  await expect(fact(page, 'check')).toContainText('Waits until you stake');
  await expect(page.getByText(ASKS)).toBeVisible();

  rpc.eth[I] = 10n ** 17n;
  rpc.eth[V] = 10n ** 17n;
  s.balance[V] = 100n * E18;
  await fact(page, 'refresh').click();
  await expect(fact(page, 'vault')).toContainText('100 SATORI · 0.1 ETH');
  await expect(fact(page, 'identity')).not.toContainText('low');
  await expect(fact(page, 'lock')).toHaveText('Free to send');

  // Unlock → Stake with this neuron: the identity's two steps, then the vault's.
  await go(page, 'settings');
  await page.getByLabel('Vault passphrase', { exact: true }).fill(PASS);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-test=vault-state]')).toHaveText('Unlocked');
  // A word list on the page first (as after a setup in the UI): ArrowJS 1.0.6 reuses its <li> for other lists.
  await page.getByRole('button', { name: 'Identity words' }).click();
  await page.getByLabel('Vault passphrase to show the backup').fill(PASS);
  await page.locator('[data-test=backup-prompt]').getByRole('button', { name: 'Show' }).click();
  await page.getByRole('button', { name: 'Hide' }).click();
  await go(page, 'wallet');
  await page.getByRole('button', { name: 'Stake with this neuron' }).click();
  await expect(fact(page, 'result')).toHaveText('Staked with this neuron.', { timeout: 30_000 });
  expect(rpc.sent.map((t) => [t.from, t.functionName])).toEqual([
    [I, 'setPredictorFee'], [I, 'setAllowedDelegator'], [V, 'delegatePredictionPower'],
  ]);
  await expect(fact(page, 'staking')).toHaveText('Staked: 100 SATORI with this neuron');
  await expect(fact(page, 'play')).toHaveText("Your SATORI is staked with this neuron, so it can't also play Satori Daily by hand. "
    + 'Unstake to play manually.');
  await expect(fact(page, 'lock')).toHaveText("Staked SATORI can't be sent until you unstake");
  await expect(page.getByRole('button', { name: 'Unstake' })).toBeVisible();

  await expect(page.locator('[data-test=base-txs] > *')).toHaveCount(3);
  await expect(page.locator('[data-test=base-txs]')).not.toContainText('renderTemplate');
  await expect(page.locator('[data-test=base-txs] code')).toHaveText([/^Identity: fee to 0 0x/, /^Identity: accepts this vault 0x/,
    /^Vault: stakes with this neuron 0x/]); // plain words; a local fork: no explorer link
  await expect(page.locator('[data-test=base-txs] code').first()).toHaveAttribute('title', /^setPredictorFee\(0\) by the identity · 0x/);

  // The identity's batch, on its own, 10 s after staking: the default game, UP (naive on two values: a tie, which
  // follows the stream's last move, up; Lite's rule said DOWN).
  // Anyone's new stream has a game but no voting weight: the engine pays it nothing, and it is left out.
  s.streams[7] = { game: 70, named: false, cadence: 60, history: [{ hour: ROUND * 24, value: 1000n }] };
  await expect(fact(page, 'last-batch')).toContainText(`Round ${ROUND}`, { timeout: 30_000 });
  await expect(fact(page, 'last-batch')).toContainText('game 1 ↑');
  const batch = rpc.sent.find((t) => t.functionName === 'predictMultipleWithPayloads');
  expect(batch).toMatchObject({ from: I, args: [[{ gameId: 1, payload: '0x01' }]] });
  expect((await page.evaluate(() => window.satori.base())).lastBatch.games).toMatchObject([{ gameId: 1, direction: 1, rule: 'last-move' }]);
  expect(s.predicted[`${I}:${ROUND}`]).toBe(1);

  // A round later: claims (hub.claim, the merkle drop from central's proof, the airdrop) and the next batch.
  rpc.advance(DAY);
  s.rewards[V] = 3n * E18;
  s.airdrop[V] = 7n * E18;
  const proof = ['0x' + 'ab'.repeat(32)];
  central.root = '0xroot';
  central.proofs[V] = { root: '0xroot', address: V, amountWei: (5n * E18).toString(), amount: 5, proof };
  s.merkle.drop[V] = { amount: 5n * E18, proof };
  await page.getByRole('button', { name: 'Claim' }).click();
  await expect(fact(page, 'result')).toContainText('Rewards: claimed 3 SATORI', { timeout: 30_000 });
  await expect(fact(page, 'result')).toContainText('Merkle: claimed 5 SATORI');
  await expect(fact(page, 'result')).toContainText('Airdrop: claimed 7 SATORI');
  expect(new Set(central.merkleCalls)).toEqual(new Set([`/api/v1/merkle/proof/${base.vault.address}`])); // the proof alone, as Lite
  await expect(fact(page, 'vault')).toContainText('115 SATORI');

  // Above the batch's max-fee ceiling it waits for the next check, and says why.
  await page.evaluate(() => window.satori.setBaseMaxFee(0.0000001));
  expect(await page.evaluate(() => window.satori.predictBase())).toMatchObject({ round: ROUND + 1, skipped: expect.stringMatching(/^gas above the ceiling/) });
  await expect(fact(page, 'check')).toContainText('gas above the ceiling');
  await page.evaluate(() => window.satori.setBaseMaxFee(''));
  const next = await page.evaluate(() => window.satori.predictBase());
  expect(next).toMatchObject({ round: ROUND + 1, sent: { games: [{ gameId: 1 }] } });
  await expect(fact(page, 'last-batch')).toContainText(`Round ${ROUND + 1}`);
  expect(await page.evaluate(() => window.satori.predictBase())).toMatchObject({ skipped: 'already predicted this round' });

  // Staked, the identity's gas matters: below a week of batches it says so.
  rpc.eth[I] = 10n ** 12n;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(fact(page, 'identity')).toContainText('low, send it a little Base ETH');
  rpc.eth[I] = 10n ** 17n;

  // Unstake: SATORI can't be sent through the next round, then it can.
  await page.getByRole('button', { name: 'Unstake' }).click();
  await expect(fact(page, 'result')).toHaveText('Unstaked.', { timeout: 30_000 });
  await expect(fact(page, 'play')).toHaveText(CHOICE);
  await expect(fact(page, 'lock')).toHaveText(`SATORI can be sent from Oct 18, 00:00 UTC (round ${ROUND + 3})`);
  const to = '0x' + '44'.repeat(20);
  const review = page.locator('[data-test=send-review]');
  // the zero address burns what it gets: refused before the review
  await page.getByLabel('Amount').fill('1');
  await page.getByLabel('To (0x address)').fill('0x' + '00'.repeat(20));
  await page.getByRole('button', { name: 'Send from the vault' }).click();
  await expect(fact(page, 'action-error')).toHaveText('The zero address (0x000…000) burns what is sent to it: refused.');
  await expect(review).toBeHidden();
  await page.getByLabel('To (0x address)').fill(to);
  await page.getByRole('button', { name: 'Send from the vault' }).click();
  // SATORI that can't be sent is said at the review, before the passphrase
  await expect(fact(page, 'action-error')).toContainText(`SATORI can be sent from Oct 18, 00:00 UTC (round ${ROUND + 3}).`);
  await expect(review).toBeHidden();
  rpc.advance(DAY);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(fact(page, 'lock')).toContainText(`(round ${ROUND + 3})`); // round N itself still can't send
  rpc.advance(DAY);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(fact(page, 'lock')).toHaveText('Free to send');
  // Send's review: the recipient in full, the amount and the asset, the estimated fee; then the passphrase (each time,
  // unlocked or not) and Send, or Back
  await page.getByRole('button', { name: 'Send from the vault' }).click();
  await expect(review).toBeVisible();
  await expect(page.locator('form.send')).toBeHidden();
  await expect(review.locator('[data-test=review-amount]')).toHaveText('1 SATORI');
  await expect(review.locator('[data-test=review-to]')).toHaveText('0x4444444444444444444444444444444444444444'); // in full
  await expect(review.locator('[data-test=review-fee]')).toHaveText(/^about 0\.0+\d+ ETH, at most 0\.0+\d+ ETH \(Base ETH, from the vault\)$/);
  const sentBefore = rpc.sent.length;
  await review.getByRole('button', { name: 'Back' }).click(); // back to the form, as typed
  await expect(review).toBeHidden();
  await expect(page.getByLabel('To (0x address)')).toHaveValue(to);
  await page.getByRole('button', { name: 'Send from the vault' }).click();
  await review.getByLabel('Vault passphrase to send').fill('not the passphrase');
  await review.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(fact(page, 'action-error')).toHaveText('Wrong passphrase');
  expect(rpc.sent.length).toBe(sentBefore); // nothing sent
  await review.getByLabel('Vault passphrase to send').fill(PASS);
  await review.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(fact(page, 'result')).toContainText('Sent 1 SATORI', { timeout: 30_000 });
  await expect(review).toBeHidden();
  await expect(page.getByLabel('Amount')).toHaveValue(''); // the form is cleared after a send
  expect(s.balance[to]).toBe(E18);

  // ETH, from the agent API: the review (quoteSend), then send() with the passphrase, each time even while unlocked;
  // then Lock: the vault's actions go, the status stays.
  expect(await page.evaluate((t) => window.satori.quoteSend({ asset: 'ETH', to: t, amount: '0.01' }), to)).toMatchObject({
    asset: 'ETH', to: '0x4444444444444444444444444444444444444444', amount: '0.01', fee: { gas: expect.any(Number), about: expect.any(String), max: expect.any(String) } });
  await expect(page.evaluate((t) => window.satori.send({ asset: 'ETH', to: t, amount: '0.01' }), to)).rejects.toThrow(/passphrase is needed/);
  await expect(page.evaluate(() => window.satori.send({ asset: 'ETH', to: '0x' + '00'.repeat(20), amount: '0.01', passphrase: 'x' })))
    .rejects.toThrow(/zero address/);
  expect(await page.evaluate(([t, p]) => window.satori.send({ asset: 'ETH', to: t, amount: '0.01', passphrase: p }), [to, PASS]))
    .toMatchObject({ hash: expect.any(String) });
  expect(rpc.eth[to]).toBe(10n ** 16n);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByText(ASKS)).toBeVisible();
  await expect(page.evaluate(() => window.satori.claim())).rejects.toThrow('Unlock the vault first');
  // Claim while locked asks for the passphrase in place, then claims, then the vault locks again: it was unlocked for that
  await page.getByRole('button', { name: 'Claim' }).click();
  await page.getByLabel('Vault passphrase to use the vault').fill(PASS);
  await page.locator('[data-unlock-for=wallet]').getByRole('button', { name: 'Unlock' }).click();
  await expect(fact(page, 'result')).toContainText('Rewards: nothing to claim on-chain', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeHidden();
  expect(await page.evaluate(async () => (await window.satori.status()).unlocked)).toBe(false);
  base = (await page.evaluate(() => window.satori.status())).base;
  expect(base).toMatchObject({ vault: { staked: 'none', satori: '114' }, lastBatch: { round: ROUND + 1 } });
  expect(sent(rpc).filter((f) => f === 'predictMultipleWithPayloads')).toHaveLength(2);

  // The agent API: stake() and unstake() (delegate() and undelegate() until 2026-10-18; no aliases).
  expect(await page.evaluate(() => [typeof window.satori.delegate, typeof window.satori.undelegate])).toEqual(['undefined', 'undefined']);
  await expect(page.evaluate(() => window.satori.stake())).rejects.toThrow('Unlock the vault first');
  await page.evaluate((p) => window.satori.unlock(p), PASS);
  expect(await page.evaluate(() => window.satori.stake())).toMatchObject({ steps: [{ step: 'delegatePredictionPower(identity)', by: 'vault' }], settled: true });
  let v = (await page.evaluate(() => window.satori.base())).vault;
  expect([v.staked, v.stakedWith.toLowerCase()]).toEqual(['identity', I]);
  expect(await page.evaluate(() => window.satori.unstake())).toMatchObject({ steps: [{ step: 'delegatePredictionPower(0x0)', by: 'vault' }], settled: true });
  v = (await page.evaluate(() => window.satori.base())).vault;
  expect(v).toMatchObject({ staked: 'none', lock: { locked: true, indefinite: false } });
});

test("the Satori Network's reward drop before it is claimed: Home's claimable rewards and the Wallet card show it", async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc, central } = await setup(context);
  central.noVaultBase = true;
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  let base = await page.evaluate(() => window.satori.base());
  const V = base.vault.address.toLowerCase();
  // no drop published yet (central2's 404): 0, quietly
  expect(base.claimable).toEqual({ rewards: '0', drop: '0', airdrop: '0', total: '0' });
  expect(base.error).toBe('');
  // a drop with this vault: 3.6185 SATORI (as central2 serves 0xda47…'s), 1.6185 of it claimed before
  const proof = ['0x' + 'ab'.repeat(32)];
  central.root = '0xd97c';
  central.proofs[V] = { root: '0xd97c', address: V, amountWei: '3618509550000000000', amount: 3.61850955, proof };
  s.merkle.drop[V] = { amount: 3618509550000000000n, proof };
  s.merkle.minted[V] = 1618509550000000000n;
  s.airdrop[V] = E18;
  await page.reload(); // a new page load asks central again (it is asked at most hourly)
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  await expect(page.locator('[data-test=claimable-amount]')).toHaveText('3', { timeout: 30_000 });
  await expect(page.locator('[data-test=claimable-parts]')).toHaveText('2 from the Satori Network · 1 airdrop');
  base = await page.evaluate(() => window.satori.base());
  expect(base.claimable).toEqual({ rewards: '0', drop: '2', airdrop: '1', total: '3' });
  await go(page, 'wallet');
  await expect(fact(page, 'claimable')).toHaveText('0 SATORI rewards · 2 SATORI from the Satori Network · 1 SATORI airdrop');

  // no ETH on the vault: Claim says so before it tries (and before asking for the passphrase)
  await go(page, 'home');
  await page.locator('[data-test=claim]').click();
  await expect(page.locator('[data-test=claim-result]')).toHaveText('The vault needs a little Base ETH for gas to claim.');
  await expect(page.locator('[data-unlock-for=claim]')).toBeHidden();
  expect(rpc.sent).toHaveLength(0);

  // with gas: the one Claim runs every claim; the drop is then 0
  rpc.eth[V] = 10n ** 17n;
  await page.evaluate(() => window.satori.base());
  await page.evaluate((p) => window.satori.unlock(p), PASS);
  const r = await page.evaluate(() => window.satori.claim());
  expect(r).toMatchObject({ merkle: { amount: '2' }, airdrop: { amount: '1' }, rewards: { skipped: 'nothing to claim on-chain' } });
  await expect(page.locator('[data-test=claimable-amount]')).toHaveText('0');
  expect((await page.evaluate(() => window.satori.base())).claimable).toMatchObject({ drop: '0', total: '0' });
});

test('staking out of sync (the token-hook bug): Home red on the Contract chip, the Wallet card says it, Unstake explains', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc, central } = await setup(context);
  central.noVaultBase = true; // a central that does not say whom it pays: no mismatch to read past
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const base = await page.evaluate(() => window.satori.base());
  const V = base.vault.address.toLowerCase();
  rpc.eth[base.identity.address.toLowerCase()] = 10n ** 17n;
  rpc.eth[V] = 10n ** 17n;
  s.balance[V] = 100n * E18;
  // not staked, with SATORI: the Stake card is advice (the hero stays green) and says the risk before staking
  await page.evaluate((p) => window.satori.unlock(p), PASS);
  await page.evaluate((p) => window.satori.backup('vault', p), PASS); // the backup shown: its advice gone, the Stake card's turn
  await page.evaluate(() => window.satori.base());
  let h = await page.evaluate(() => window.satori.health());
  expect(h.reasons.find((r) => r.id === 'stake')).toMatchObject({ status: 'advice' });
  expect(h.reasons.filter((r) => r.status === 'warn' || r.status === 'bad')).toEqual([]); // nothing amber or red
  await expect(page.locator('[data-test=action-text]')).toContainText('A known contract issue can block unstaking; a fix is coming in the next contract release.');
  await page.evaluate(() => window.satori.stake());
  expect((await page.evaluate(() => window.satori.base())).vault).toMatchObject({ staked: 'identity', inSync: true });

  s.skipHook(V, 1n); // anyone sends the staked vault 1 wei with the bare gas estimate: its hook runs out of gas
  expect((await page.evaluate(() => window.satori.base())).vault).toMatchObject({ inSync: false, shortfall: '0.000000000000000001' });
  h = await page.evaluate(() => window.satori.health());
  expect(h).toMatchObject({ status: 'bad', title: 'Predicting', line: 'The Satori Network is fine. Staking is out of sync.',
    action: { id: 'stake-out-of-sync', text: "Unstaking will fail until the contract fix. Don't add SATORI to the vault." },
    channels: { contract: { state: 'bad', text: 'Out of sync' } } });
  expect(h.action).not.toHaveProperty('button');
  await expect(page.locator('[data-test=chip][data-channel=contract] [data-test=chip-text]')).toHaveText('Out of sync');
  await expect(page.locator('[data-test=action-button]')).toBeHidden();
  await go(page, 'wallet');
  await expect(fact(page, 'sync')).toHaveText("Staking is out of sync. Unstaking will fail until the contract fix. Don't add SATORI to the vault.");
  await expect(fact(page, 'staking')).toHaveText('Staked: 100 SATORI with this neuron · out of sync');
  // Unstake: the simulate underflows (Panic 0x11); the plain words, not "reverted: Panic", and nothing sent
  const before = rpc.sent.length;
  await page.getByRole('button', { name: 'Unstake' }).click();
  await expect(fact(page, 'action-error')).toHaveText("Staking is out of sync. Unstaking will fail until the contract fix. Don't add SATORI to the vault.",
    { timeout: 30_000 });
  expect(rpc.sent.length).toBe(before);
  await expect(page.evaluate(() => window.satori.unstake())).rejects.toThrow('Staking is out of sync.');
});

test('the Base settings: the RPC (https or a path on this site; empty is the default) and the batch\'s max fee', async ({ context, page }) => {
  await setup(context);
  await openApp(page);
  await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
  await expect(page.locator('[data-test=identity]')).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: LOAD_TIMEOUT });
  await expect(fact(page, 'rpc')).toHaveText('Local test chain (a fork of Base Sepolia)');
  await expect(page.evaluate(() => window.satori.setBaseRpc('http://127.0.0.1:8545'))).rejects.toThrow(/https:\/\/ URL or a path/);
  await expect(page.evaluate(() => window.satori.setBaseMaxFee('-1'))).rejects.toThrow(/positive number of gwei/);
  await go(page, 'settings');
  await expect(page.getByLabel('Daily batch: max fee (gwei)')).toHaveValue(''); // only what is stored: the default is the placeholder
  await page.getByLabel('Base RPC').fill('https://rpc.example');
  await page.getByLabel('Daily batch: max fee (gwei)').fill('0');
  await page.getByRole('button', { name: 'Save contract settings' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'positive number of gwei' })).toBeVisible();
  expect(await page.evaluate(() => window.satori.base())).toMatchObject({ rpcSetting: '', maxFeeSetting: null }); // neither saved
  await page.getByLabel('Base RPC').fill('/rpc');
  await page.getByLabel('Daily batch: max fee (gwei)').fill('0.5');
  await page.getByRole('button', { name: 'Save contract settings' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.satori.base()).maxFeeGwei)).toBe(0.5); // saved
  expect(await page.evaluate(() => window.satori.base())).toMatchObject({ rpc: ['/rpc'], rpcSetting: '/rpc', maxFeeSetting: 0.5, maxFeeGwei: 0.5 });
  await expect(page.getByLabel('Daily batch: max fee (gwei)')).toHaveValue('0.5');
  expect(await page.evaluate(() => window.satori.setBaseRpc(''))).toMatchObject({ rpc: ['/rpc'], rpcSetting: '' }); // the dev server's default
});
