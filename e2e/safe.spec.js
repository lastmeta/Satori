// The Safe tab (docs/design/safe.md) against test/fake-satori.js's Safe (3 of 5) and a faked Safe service behind its
// URL: hidden for a wallet that owns no Safe; for an owner, the appoint authority appointed with the inline Unlock, two more owners'
// signatures, Execute; an upgrade proposed by the agent call; a freeze that asks first.
import { expect, test } from '@playwright/test';
import { fakeSatori } from '../test/fake-satori.js';
import { fakeSafeService } from '../test/fake-safe-service.js';
import { publicKey, evmAddress, signDigest } from '../src/keys/keys.js';
import { safeTx, signSafeTx } from '../src/chain/safe.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const PASS = 'correct horse battery';
const t = (page, id) => page.locator(`[data-test=${id}]`);
const signerOf = (hex) => {
  const secret = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};
const others = [signerOf('33'.repeat(32)), signerOf('44'.repeat(32))];

test('Safe: only for an owner; propose, the others sign, execute; an upgrade by the agent call; a freeze asks', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc } = fakeSatori();
  const svc = fakeSafeService();
  page.on('pageerror', (e) => { throw e; });
  await stubCentral(context, { rpc });
  await context.route('https://api.safe.global/**', svc.route);
  await openApp(page);
  await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const V = (await page.evaluate(() => window.satori.base())).wallet.address;

  expect(await page.evaluate(() => window.satori.safe())).toEqual({ shown: false, safes: [] });
  await expect(t(page, 'nav-safe')).toBeHidden();

  s.safe.owners.splice(0, 3, V, ...others.map((o) => o.evmAddress));
  rpc.eth[V.toLowerCase()] = 10n ** 17n;
  const view = await page.evaluate(() => window.satori.safe());
  expect(view.safes[0]).toMatchObject({ threshold: '3', nonce: '0', keys: { freeze: { hook: false } }, pending: [] });
  expect(Object.keys(view.safes[0].keys)).toEqual(['root', 'upgrade', 'freeze', 'loader']); // no fee key: 15% for good
  await expect(t(page, 'nav-safe')).toBeVisible();
  await expect(t(page, 'app-wallet')).toHaveText('Safe owner');
  await page.evaluate(() => window.satori.go('safe'));
  await expect(t(page, 'safe-threshold')).toHaveText('3 of 5 owners');

  // the appoint authority appointed, locked: the passphrase in the card
  const NEW = `0x${'cd'.repeat(20)}`;
  const fee = page.locator('[data-test=safe-card][data-key=root][data-action=appoint]');
  await fee.locator('summary').click();
  await fee.locator('[data-test=safe-input]').fill(NEW);
  await fee.locator('[data-test=safe-again]').fill(NEW);
  await fee.locator('[data-test=safe-propose]').click();
  await fee.getByLabel('Wallet passphrase to sign the proposal').fill(PASS);
  await fee.getByRole('button', { name: 'Unlock' }).click();
  await expect(fee.locator('[data-test=safe-result]')).toHaveText(/^Proposed as the Safe's transaction 0/, { timeout: 30_000 });
  const row = page.locator('[data-test=safe-tx][data-nonce="0"]');
  await expect(row).toContainText(/Appoint 0xcdcd…cdcd the appoint authority/i);
  await expect(row).toContainText('1 of 3 signed, you too');
  await expect(row.locator('[data-test=safe-execute]')).toBeHidden();

  // the two other owners sign (as they would in their own apps), then Execute
  const tx = svc.txs[0];
  for (const o of others) {
    const sig = await signSafeTx(o, 84532, safeTx({ safe: tx.safe, to: tx.to, data: tx.data, nonce: tx.nonce }));
    await svc.fetch(`https://api.safe.global/tx-service/basesep/api/v1/multisig-transactions/${tx.safeTxHash}/confirmations/`, { method: 'POST', body: JSON.stringify({ signature: sig }) });
  }
  await page.evaluate((p) => window.satori.unlock(p), PASS);
  await t(page, 'safe-refresh').click();
  await expect(row).toContainText('3 of 3 signed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('safe-phone.png'), fullPage: true });
  // no gas: said what to do (not the RPC's "Missing or invalid parameters"); with some, it runs
  rpc.eth[V.toLowerCase()] = 0n;
  await row.locator('[data-test=safe-execute]').click();
  await expect(t(page, 'safe-waiting').locator('[data-test=safe-error]')).toHaveText(/^To execute, this wallet needs a little Base ETH for gas\./);
  expect(s.safe.nonce).toBe(0n);
  rpc.eth[V.toLowerCase()] = 10n ** 17n;
  await row.locator('[data-test=safe-execute]').click();
  await expect(t(page, 'safe-waiting').locator('[data-test=safe-result]')).toHaveText('Executed.', { timeout: 30_000 });
  expect(s.appoint).toBe(NEW);
  expect(s.safe.nonce).toBe(1n);
  await expect(page.locator('[data-test=safe-tx]')).toHaveCount(0);
  await expect(page.locator('[data-test=safe-now-appoint]')).toHaveText(/^0xcdcd…cdcd$/i);

  // an upgrade by the agent call; a freeze that asks first
  const up = await page.evaluate(() => window.satori.safePropose('upgrade', 'upgrade', `hub 0x${'ab'.repeat(20)}`));
  expect(up.nonce).toBe('1');
  const freeze = page.locator('[data-test=safe-card][data-key=freeze][data-action=hook]');
  await freeze.locator('summary').click();
  await freeze.locator('[data-test=safe-ask]').click();
  await freeze.locator('[data-test=safe-propose]').click();
  await expect(freeze.locator('[data-test=safe-result]')).toHaveText(/^Proposed as the Safe's transaction 2/);
  await expect(page.locator('[data-test=safe-tx]')).toHaveText([/Upgrade Hub to 0xabab…abab/i, /Freeze the transfer hook, for good/]);
  expect((await page.evaluate(() => window.satori.safe())).safes[0].pending.map((p) => [p.nonce, p.signatures, p.next])).toEqual([['1', 1, true], ['2', 1, false]]);
});
