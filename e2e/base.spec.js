// Base in the app (docs/design/base.md), against a fake D6 behind /rpc
// (test/fake-satori.js, run in this test process) and a stub central2
// that serves a merkle proof: the status while locked, Unlock → Delegate
// prediction power, the identity's batch on its own, a round later the claims
// and the next batch, Stop delegating, the transfer lock, sends; the agent API.
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
const sent = (rpc) => rpc.sent.map((t) => t.functionName);

test('the Base card: delegate, the batch on its own, claims, stop, the lock, sends', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc, central } = await setup(context);
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('[data-test=identity]')).toHaveText(/^E/, { timeout: LOAD_TIMEOUT });

  // Locked: the status needs no key; both Base addresses; no gas yet.
  let base = await page.evaluate(() => window.satori.base());
  const I = base.identity.address.toLowerCase();
  const V = base.vault.address.toLowerCase();
  expect(base).toMatchObject({ rpc: ['/rpc'], config: 'bundled', round: ROUND, vault: { delegated: 'none', satori: '0' } });
  await expect(fact(page, 'identity')).toContainText('low, send it a little Base ETH');
  await expect(page.getByText('Unlock the vault to delegate, claim or send.')).toBeVisible();

  rpc.eth[I] = 10n ** 17n;
  rpc.eth[V] = 10n ** 17n;
  s.balance[V] = 100n * E18;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(fact(page, 'vault')).toContainText('100 SATORI · 0.1 ETH');
  await expect(fact(page, 'identity')).not.toContainText('low');
  await expect(fact(page, 'lock')).toHaveText('Free to send');

  // Unlock → Delegate prediction power: the identity's two steps, then the vault's.
  await page.getByLabel('Vault passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByRole('button', { name: 'Delegate prediction power' }).click();
  await expect(fact(page, 'result')).toContainText('Delegated: setPredictorFee(0) by the identity', { timeout: 30_000 });
  expect(rpc.sent.map((t) => [t.from, t.functionName])).toEqual([
    [I, 'setPredictorFee'], [I, 'setAllowedDelegator'], [V, 'delegatePredictionPower'],
  ]);
  await expect(fact(page, 'delegation')).toHaveText('Delegated to the identity · 100 SATORI of prediction power');
  await expect(fact(page, 'lock')).toHaveText('SATORI transfer-locked while delegated');
  await expect(page.getByRole('button', { name: 'Stop delegating' })).toBeVisible();

  await expect(page.locator('[data-test=base-txs] li')).toHaveCount(3);
  await expect(page.locator('[data-test=base-txs] code').first()).toContainText('setPredictorFee(0) (identity) 0x'); // a local fork: no explorer link

  // The identity's batch, on its own, 10 s after delegating: the default game, DOWN (naive on two values).
  // Anyone's new stream has a game but no voting weight: the engine pays it nothing, and it is left out.
  s.streams[7] = { game: 70, named: false, cadence: 60, history: [{ hour: ROUND * 24, value: 1000n }] };
  await expect(fact(page, 'last-batch')).toContainText(`Round ${ROUND}`, { timeout: 30_000 });
  await expect(fact(page, 'last-batch')).toContainText('game 1 ↓');
  const batch = rpc.sent.find((t) => t.functionName === 'predictMultipleWithPayloads');
  expect(batch).toMatchObject({ from: I, args: [[{ gameId: 1, payload: '0x02' }]] });
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
  expect(central.merkleCalls).toEqual([`/api/v1/merkle/proof/${base.vault.address}`]); // the proof alone, as Lite
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

  // Stop delegating: transfer-locked through the next round, then free.
  await page.getByRole('button', { name: 'Stop delegating' }).click();
  await expect(fact(page, 'result')).toContainText('Stopped delegating', { timeout: 30_000 });
  await expect(fact(page, 'lock')).toContainText(`SATORI transfer-locked until round ${ROUND + 2} (free from Oct 18, 00:00 UTC)`);
  const to = '0x' + '44'.repeat(20);
  await page.getByLabel('Amount').fill('1');
  await page.getByLabel('To (0x address)').fill(to);
  await page.getByRole('button', { name: 'Send from the vault' }).click();
  await expect(fact(page, 'action-error')).toContainText(`transfer-locked until round ${ROUND + 2}`);
  rpc.advance(DAY);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(fact(page, 'lock')).toContainText(`until round ${ROUND + 2}`); // round N itself is still locked
  rpc.advance(DAY);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(fact(page, 'lock')).toHaveText('Free to send');
  await page.getByRole('button', { name: 'Send from the vault' }).click();
  await expect(fact(page, 'result')).toContainText('Sent 1 SATORI', { timeout: 30_000 });
  expect(s.balance[to]).toBe(E18);

  // ETH, from the agent API; then Lock: the vault's actions go, the status stays.
  expect(await page.evaluate((t) => window.satori.send({ asset: 'ETH', to: t, amount: '0.01' }), to)).toMatchObject({ hash: expect.any(String) });
  expect(rpc.eth[to]).toBe(10n ** 16n);
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByText('Unlock the vault to delegate, claim or send.')).toBeVisible();
  await expect(page.evaluate(() => window.satori.claim())).rejects.toThrow('Unlock the vault first');
  base = (await page.evaluate(() => window.satori.status())).base;
  expect(base).toMatchObject({ vault: { delegated: 'none', satori: '114' }, lastBatch: { round: ROUND + 1 } });
  expect(sent(rpc).filter((f) => f === 'predictMultipleWithPayloads')).toHaveLength(2);
});

test('the Base settings: the RPC (https or a path on this site; empty is the default) and the batch\'s max fee', async ({ context, page }) => {
  await setup(context);
  await openApp(page);
  await page.evaluate(() => window.satori.setup({ passphrase: 'pass' }));
  await expect(page.locator('[data-test=identity]')).toHaveText(/^E/, { timeout: LOAD_TIMEOUT });
  await expect(fact(page, 'rpc')).toContainText('/rpc: the local fork of Base Sepolia');
  await expect(page.evaluate(() => window.satori.setBaseRpc('http://127.0.0.1:8545'))).rejects.toThrow(/https:\/\/ URL or a path/);
  await expect(page.evaluate(() => window.satori.setBaseMaxFee('-1'))).rejects.toThrow(/positive number of gwei/);
  await page.locator('summary', { hasText: 'Settings' }).click();
  await expect(page.getByLabel('Daily batch: max fee (gwei)')).toHaveValue('2');
  await page.getByLabel('Base RPC').fill('/rpc');
  await page.getByLabel('Daily batch: max fee (gwei)').fill('0.5');
  await page.getByRole('button', { name: 'Save Base settings' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.satori.base()).maxFeeGwei)).toBe(0.5); // saved
  expect(await page.evaluate(() => window.satori.base())).toMatchObject({ rpc: ['/rpc'], rpcSetting: '/rpc', maxFeeGwei: 0.5 });
  await expect(page.getByLabel('Daily batch: max fee (gwei)')).toHaveValue('0.5');
  expect(await page.evaluate(() => window.satori.setBaseRpc(''))).toMatchObject({ rpc: ['/rpc'], rpcSetting: '' }); // the dev server's default
});
