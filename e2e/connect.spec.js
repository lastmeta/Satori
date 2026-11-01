// A connected wallet (docs/design/wallets.md#a-connected-wallet) in Chrome: a wallet app (test/fake-wallet.js, its key
// in node) announced to the page by EIP-6963, on the fake chain behind /rpc and the stub central. Connect on Setup (its
// account, the link it signs; no passphrase), then Stake, Send and the Nostr key's backup each asked of the wallet app,
// a "no" said plainly, and the app still predicting when the wallet app isn't in the browser.
import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { nostrPubkey } from '../src/nostr/event.js';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { fakeWallet } from '../test/fake-wallet.js';
import { loaded, openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const ROUND = 20741;
const fact = (page, name) => page.locator(`[data-test=base-${name}]`);
const go = (page, tab) => page.evaluate((t) => window.satori.go(t), tab);
const status = (page) => page.evaluate(() => window.satori.status());
/** SHOTS=1: a phone's view of `locator` into docs/screenshots. */
async function shot(page, locator, name) {
  if (!process.env.SHOTS) return;
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await locator.screenshot({ path: `docs/screenshots/${name}.png` });
  await page.setViewportSize(size);
}

/** The wallet app, as an extension shows it to every page: announced on request, unless localStorage.noWallet. */
async function installWallet(context, app) {
  await context.exposeFunction('__walletRequest', async (args) => {
    try {
      return { result: await app.provider.request(args) };
    } catch (err) {
      return { error: { code: err.code ?? -32603, message: err.message } };
    }
  });
  await context.addInitScript(() => {
    const provider = {
      async request(args) {
        const r = await window.__walletRequest(args);
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return r.result;
      },
    };
    const info = Object.freeze({ uuid: 'test-wallet', name: 'TestWallet', icon: 'data:,', rdns: 'test.wallet' });
    window.addEventListener('eip6963:requestProvider', () => {
      if (localStorage.getItem('noWallet')) return;
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    });
  });
}

test('Connect a wallet: the link it signs; Stake, Send, Backup asked of its wallet app; a no; the app without it', async ({ browser, context, page }) => {
  test.setTimeout(240_000);
  const { s, rpc } = fakeSatori({ round: ROUND, hour: 9 });
  const central = await stubCentral(context, { rpc });
  const app = fakeWallet({ key: `0x${'3c'.repeat(32)}`, transport: rpc.transport });
  const W = app.address.toLowerCase();
  rpc.eth[W] = 10n ** 17n;
  s.balance[W] = 100n * E18;
  await installWallet(context, app);

  // Setup › Connect a wallet: the wallet found by its name; its account, then the link it signs; no passphrase
  expect(await openApp(page)).toBe('setup');
  await page.locator('[data-test=connect-wallet]').click();
  await expect(page.getByRole('button', { name: 'Connect TestWallet' })).toBeVisible();
  await shot(page, page.locator('[data-test=connect-step]'), 'connect-step-phone');
  await page.getByRole('button', { name: 'Connect TestWallet' }).click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.screen), { timeout: LOAD_TIMEOUT }).toBe('home');
  const st = await status(page);
  expect([st.wallet, st.walletKind, st.connected, st.unlocked]).toEqual([app.address, 'connected', { name: 'TestWallet', found: true, relay: false }, false]);
  expect(app.calls.slice(0, 2)).toEqual(['eth_requestAccounts', 'personal_sign']);
  await expect.poll(() => central.registered.length).toBe(1);
  const link = Buffer.from(central.registered[0]['wallet-link'], 'base64').toString('utf8');
  expect(link).toContain(`alias: ${st.alias}\nwallet: ${app.address}\n`);
  expect(await recoverMessageAddress({ message: link, signature: central.registered[0]['wallet-signature'] })).toBe(app.address);
  await expect.poll(async () => (await status(page)).central.registration?.wallet_address).toBe(app.address); // the network pays it

  // Settings: Connected, no Unlock; Backup has no wallet words
  await go(page, 'settings');
  await expect(page.locator('[data-test=wallet-state]')).toHaveText('Connected');
  await expect(page.locator('[data-test=wallet-connected]')).toContainText('in TestWallet: it asks you each time');
  await expect(page.getByLabel('Wallet passphrase', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Wallet words' })).toBeHidden();
  await shot(page, page.locator('#settings-keys'), 'connected-keys-phone');
  await expect(page.evaluate(() => window.satori.unlock('anything'))).rejects.toThrow('This wallet is connected');

  // Stake (the Wallet tab): no Unlock prompt; the wallet's step sent by its wallet app
  await go(page, 'wallet');
  await expect(page.locator('[data-test=base-connected]')).toContainText('ask TestWallet to approve');
  rpc.eth[st.alias.toLowerCase()] = 10n ** 17n; // gas for the alias's two steps
  await page.getByRole('button', { name: 'Stake with this app' }).click();
  await expect(fact(page, 'result')).toHaveText('Staked with this app.', { timeout: 60_000 });
  await expect(page.locator('[data-test=unlock-prompt]:visible')).toHaveCount(0);
  expect(rpc.sent.filter((t) => t.from === W).map((t) => t.functionName)).toEqual(['delegatePredictionPower']);
  expect(app.calls).toContain('eth_sendTransaction');

  // Send ETH: the review, then "Send in TestWallet", no passphrase
  await page.getByLabel('Asset').selectOption('ETH');
  await page.getByLabel('Amount').fill('0.001');
  await page.getByLabel('To (0x address)').fill('0x4444444444444444444444444444444444444444');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Wallet passphrase to send', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Send in TestWallet' }).click();
  await expect(fact(page, 'result')).toHaveText('Sent 0.001 ETH.', { timeout: 60_000 });
  expect(rpc.sent.at(-1)).toMatchObject({ from: W, to: '0x4444444444444444444444444444444444444444', value: 10n ** 15n });

  // A no in the wallet app: said plainly, nothing sent
  app.state.reject = true;
  const before = rpc.sent.length;
  await page.getByRole('button', { name: 'Unstake' }).click();
  await expect(fact(page, 'action-error')).toContainText('Declined in the wallet app.', { timeout: 30_000 });
  expect(rpc.sent.length).toBe(before);
  app.state.reject = false;

  // The app's keys are random, never from a signature (docs/design/wallets.md#derived-keys): in Backup, each confirmed
  // by a signature in the wallet app
  expect((await page.evaluate(() => window.satori.status())).keysFrom).toBe('random');
  await go(page, 'settings');
  await page.getByRole('button', { name: 'Nostr key' }).click();
  await page.locator('[data-test=backup-prompt]').getByRole('button', { name: 'Confirm in TestWallet' }).click();
  await expect(page.locator('[data-test=backup-key]')).toHaveText(/^nsec1/);
  expect(app.calls.filter((m) => m === 'personal_sign')).toHaveLength(2); // the link, then this
  await page.getByRole('button', { name: 'Alias key' }).click();
  await page.locator('[data-test=backup-prompt]').getByRole('button', { name: 'Confirm in TestWallet' }).click();
  await expect(page.locator('[data-test=backup-key]')).toHaveText(/^0x[0-9a-f]{64}$/);

  // The wallet app not in this browser: the app still runs; a wallet action says where to go
  await page.evaluate(() => localStorage.setItem('noWallet', '1'));
  await page.reload();
  expect(await loaded(page)).toBe('home');
  expect((await status(page)).connected).toEqual({ name: 'TestWallet', found: false, relay: false });
  await go(page, 'settings');
  await expect(page.locator('[data-test=wallet-connected]')).toContainText("TestWallet, which isn't in this browser");
  await go(page, 'wallet');
  await page.getByRole('button', { name: 'Unstake' }).click();
  await expect(fact(page, 'action-error')).toHaveText("TestWallet isn't in this browser: open the app where it is installed.");

  // Settings › Restore keys: backed-up keys replace the generated ones, the wallet app signing the new link; the old stay
  await go(page, 'settings');
  await page.locator('[data-test=restore-alias]').fill('0x' + 'ab'.repeat(32));
  await page.locator('[data-test=restore-keys]').click();
  await expect(page.locator('[data-test=restore-error]')).toHaveText("TestWallet isn't in this browser: open the app where it is installed.");
  await page.evaluate(() => localStorage.removeItem('noWallet'));
  await page.reload();
  expect(await loaded(page)).toBe('home');
  await go(page, 'settings');
  await expect(page.locator('[data-test=restore-wallet]')).toBeVisible();
  const was = await status(page);
  const [put, nostrPut] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  await page.locator('[data-test=restore-alias]').fill('not a key');
  await page.locator('[data-test=restore-keys]').click();
  await expect(page.locator('[data-test=restore-error]')).toHaveText('The alias key: not 24 backup words or a private key.');
  await page.locator('[data-test=restore-alias]').fill(`0x${put}`);
  await page.locator('[data-test=restore-nostr]').fill(nostrPut);
  await Promise.all([page.waitForEvent('load', { timeout: LOAD_TIMEOUT }), page.locator('[data-test=restore-keys]').click()]);
  expect(await loaded(page)).toBe('home');
  expect((await status(page)).alias).toBe(privateKeyToAddress(`0x${put}`));
  expect((await status(page)).wallet).toBe(was.wallet);
  expect((await page.evaluate(() => window.satori.nostr())).pubkey).toBe(nostrPubkey(nostrPut));
  await go(page, 'settings');
  await expect(page.locator('[data-test=retired-keys]')).toBeVisible();
  await expect.poll(() => central.registered.at(-1)['wallet-link'] && Buffer.from(central.registered.at(-1)['wallet-link'], 'base64').toString('utf8')).toContain(`alias: ${privateKeyToAddress(`0x${put}`)}\n`);

  // An agent: this wallet's backup file puts them back, through its wallet app; another wallet's file is refused
  const PASS = 'a backup passphrase';
  const file = await page.evaluate((p) => window.satori.exportBackup(p), PASS);
  const other = { ...file, address: `0x${'11'.repeat(20)}` };
  await expect(page.evaluate((a) => window.satori.restoreKeys(a), { backup: other, passphrase: PASS })).rejects.toThrow("This backup is another wallet's");
  await Promise.all([page.waitForEvent('load', { timeout: LOAD_TIMEOUT }), page.evaluate((a) => window.satori.restoreKeys({ alias: a }), `0x${'cd'.repeat(32)}`)]);
  expect(await loaded(page)).toBe('home');
  expect((await status(page)).alias).toBe(privateKeyToAddress(`0x${'cd'.repeat(32)}`));
  await Promise.all([page.waitForEvent('load', { timeout: LOAD_TIMEOUT }), page.evaluate((a) => window.satori.restoreKeys(a), { backup: file, passphrase: PASS })]);
  expect(await loaded(page)).toBe('home');
  expect((await status(page)).alias).toBe(privateKeyToAddress(`0x${put}`));

  // A wiped browser with no wallet app (an agent's): the backup alone brings it back, the link and all; no signature
  await page.evaluate(() => localStorage.setItem('noWallet', '1'));
  await page.reload();
  expect(await loaded(page)).toBe('home');
  const whole = await page.evaluate((p) => window.satori.exportBackup(p), PASS); // no wallet app asked
  const fresh = await browser.newContext();
  try {
    const seen = await stubCentral(fresh, { rpc });
    const p2 = await fresh.newPage();
    expect(await openApp(p2)).toBe('setup');
    const after = await p2.evaluate(([b, p]) => window.satori.setup({ backup: b, passphrase: p }), [whole, PASS]);
    expect(after).toMatchObject({ screen: 'home', alias: privateKeyToAddress(`0x${put}`), wallet: was.wallet });
    expect((await p2.evaluate(() => window.satori.nostr())).pubkey).toBe(nostrPubkey(nostrPut));
    await expect.poll(() => seen.registered.at(-1)?.['wallet-signature']).toBe(central.registered.at(-1)['wallet-signature']);
    await p2.evaluate((p) => window.satori.exportBackup(p), PASS); // and again tomorrow
  } finally {
    await fresh.close();
  }
});

test('no wallet in this browser (a phone): Connect offers MetaMask and Other wallet (WalletConnect), as the dapp', async ({ page }) => {
  await stubCentral(page.context());
  expect(await openApp(page)).toBe('setup');
  await page.locator('[data-test=connect-wallet]').click();
  await expect(page.locator('[data-test=relay-choices]')).toContainText('No wallet in this browser: connect your wallet app instead.');
  await expect(page.getByRole('button', { name: /^MetaMask/ })).toContainText('Opens the app to approve');
  await expect(page.getByRole('button', { name: /^Other wallet/ })).toContainText('Rainbow, Trust, Coinbase');
  expect(await page.evaluate(() => window.satori.connectWallets())).toEqual([{ rdns: 'metamask-connect', name: 'MetaMask' },
    { rdns: 'walletconnect', name: 'Other wallet' }]);
  // the dev server is on localhost, which a relay can't reach: said, nothing loaded
  await page.getByRole('button', { name: /^MetaMask/ }).click();
  await expect(page.locator('[data-test=connect-step] [role=alert]')).toContainText('on your private network');
});

test('a wallet staked with another address (another app\'s alias): Home offers Stake here, which moves it in one step', async ({ context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc } = fakeSatori({ round: ROUND, hour: 9 });
  await stubCentral(context, { rpc });
  const app = fakeWallet({ key: `0x${'4d'.repeat(32)}`, transport: rpc.transport });
  const W = app.address.toLowerCase();
  const OTHER = '0x' + '5e'.repeat(20);
  rpc.eth[W] = 10n ** 17n;
  s.balance[W] = 100n * E18;
  s.delegateOf[W] = OTHER; // staked from another app
  await installWallet(context, app);

  expect(await openApp(page)).toBe('setup');
  await page.locator('[data-test=connect-wallet]').click();
  await page.getByRole('button', { name: 'Connect TestWallet' }).click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.screen), { timeout: LOAD_TIMEOUT }).toBe('home');
  const { alias } = await status(page);
  rpc.eth[alias.toLowerCase()] = 10n ** 17n;
  await page.evaluate(() => window.satori.base());
  await expect(page.locator('[data-test=action]')).toHaveAttribute('data-action', 'staked-elsewhere');
  await expect(page.locator('[data-test=action]')).toContainText('Your wallet is staked with another address');
  await expect(page.locator('[data-test=chip][data-channel=contract] [data-test=chip-text]')).toHaveText('Staked elsewhere');
  await shot(page, page.locator('[data-test=action]'), 'staked-elsewhere-home');
  await page.locator('[data-test=action-button]').click();
  await expect(page.locator('[data-test=action]')).toBeHidden({ timeout: 60_000 });
  expect(s.delegateOf[W]).toBe(alias.toLowerCase());
  expect(rpc.sent.filter((t) => t.from === W).map((t) => t.functionName)).toEqual(['delegatePredictionPower']); // no Unstake first
});
