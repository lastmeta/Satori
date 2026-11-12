// Several wallets in one app (docs/design/wallets.md#several-wallets), in Chrome with the stub central: one active at a
// time, a database each. Add opens Setup on an empty database; a wallet already in the app is refused at setup, with a
// way back; Switch reloads with the other wallet; Remove (asked first) deletes a wallet that is not in use, its file too.
// A wallet imported from words lists its sub-wallets and switches to one (docs/design/wallets.md#sub-wallets).
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils';
import { loaded, openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';
import { evmAddress } from '../src/keys/keys.js';
import { evrmoreAddress } from '../src/keys/hd.js';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/alias-parity.json', import.meta.url)));
const [A, B] = fx.vectors;
const PASS = 'a long test passphrase';
const SHOTS = process.env.SHOTS ? 'docs/screenshots' : null;

const status = (page) => page.evaluate(() => window.satori.status());
const wallets = (page) => page.evaluate(() => window.satori.wallets());
/** `fn` makes the page reload (the switch, Add): wait for the new page to start. → its screen */
async function reloading(page, fn) {
  const next = page.waitForEvent('load', { timeout: LOAD_TIMEOUT });
  await fn();
  await next;
  return loaded(page);
}
const opfsFiles = (page) => page.evaluate(async () => {
  const names = [];
  for await (const [name] of (await navigator.storage.getDirectory()).entries()) names.push(name);
  return names.filter((n) => n.endsWith('.duckdb')).sort();
});
/** A finger on the Wallets list (synthetic touches): row `from` pressed, held `hold` ms, moved past row `to`'s middle, let go. */
const touchDrag = (page, from, to, hold) => page.evaluate(async ([from, to, hold]) => {
  const rows = [...document.querySelectorAll('[data-test=wallet-row]')];
  const a = rows[from].getBoundingClientRect();
  const b = rows[to].getBoundingClientRect();
  const x = a.left + a.width / 2;
  const [y0, y1] = [a.top + a.height / 2, b.top + b.height * (to > from ? 0.75 : 0.25)];
  const target = document.elementFromPoint(x, y0);
  const fire = (type, y) => {
    const t = new Touch({ identifier: 1, target, clientX: x, clientY: y });
    target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fire('touchstart', y0);
  await wait(hold);
  for (let i = 1; i <= 8; i++) { fire('touchmove', y0 + ((y1 - y0) * i) / 8); await wait(16); }
  fire('touchend', y1);
}, [from, to, hold]);
const setupWith = (page, words) => page.evaluate(([p, w]) => window.satori.setup({ passphrase: p, walletWords: w }), [PASS, words]);

test('two wallets: Add, a wallet already in the app refused with a way back, Switch, Remove; each its own database', async ({ context, page }) => {
  test.setTimeout(240_000);
  const stub = await stubCentral(context);
  expect(await openApp(page)).toBe('setup');
  expect((await setupWith(page, A.words)).wallet).toBe(A.ethAddress);
  expect(await wallets(page)).toEqual({ active: 1, wallets: [{ id: 1, address: A.ethAddress, name: null, nameAuto: false, active: true }] }); // no list yet: one wallet

  // Add a wallet (the Wallet tab): Setup on an empty database, the first wallet offered as the way back
  await page.evaluate(() => { location.hash = '#wallet'; });
  await expect(page.locator('[data-test=wallet-row]')).toHaveCount(1);
  expect(await reloading(page, () => page.locator('[data-test=add-wallet]').click())).toBe('setup');
  await expect(page.locator('[data-test=wallet-back]')).toHaveText(`${A.ethAddress.slice(0, 6)}…${A.ethAddress.slice(-4)}`);
  const second = await setupWith(page, B.words);
  expect([second.screen, second.wallet]).toEqual(['home', B.ethAddress]);
  const aliasB = second.alias;
  expect(await wallets(page)).toEqual({ active: 2, wallets: [{ id: 1, address: A.ethAddress, name: null, nameAuto: false, active: false }, { id: 2, address: B.ethAddress, name: null, nameAuto: false, active: true }] });
  expect(await opfsFiles(page)).toEqual(['satori-2.duckdb', 'satori-mvp.duckdb']);
  await expect.poll(() => stub.registered.length).toBe(2); // each wallet registers its own alias
  expect(stub.registered[1]['alias-pubkey']).not.toBe(stub.registered[0]['alias-pubkey']);

  // A wallet already in the app: refused at setup; the way back opens it again
  expect(await reloading(page, () => page.evaluate(() => window.satori.addWallet()))).toBe('setup');
  await expect(setupWith(page, A.words)).rejects.toThrow('This wallet is already in this app');
  expect((await status(page)).screen).toBe('setup');
  await expect(page.locator('[data-test=wallet-back]')).toHaveCount(2);
  expect(await reloading(page, () => page.locator('[data-test=wallet-back]').first().click())).toBe('home');
  expect((await status(page)).wallet).toBe(A.ethAddress);
  expect((await wallets(page)).wallets.map((w) => [w.id, w.address, w.active])).toEqual([[1, A.ethAddress, true], [2, B.ethAddress, false], [3, null, false]]);

  // Switch (the Wallet tab) to the second: its own keys and data again
  await page.evaluate(() => { location.hash = '#wallet'; });
  const rows = page.locator('[data-test=wallet-row]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator('[data-test=wallet-in-use]')).toBeVisible();
  await expect(rows.nth(2)).toContainText('Not set up yet');
  if (SHOTS) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-test=wallets]').screenshot({ path: `${SHOTS}/wallets-phone.png` });
    await page.setViewportSize(size);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-test=wallets]').screenshot({ path: test.info().outputPath('wallets-card.png') });

  // Reorder (the owner, 2026-11-02): a row dragged up or down, the order kept for the next visit
  const order = async () => (await wallets(page)).wallets.map((w) => w.id);
  await expect(page.locator('[data-test=wallet-order-hint]')).toBeVisible();
  const [top, third] = [await rows.nth(0).boundingBox(), await rows.nth(2).boundingBox()];
  await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2, (top.y + third.y) / 2 + 10, { steps: 4 });
  await page.locator('[data-test=wallets]').screenshot({ path: test.info().outputPath('wallets-dragging.png') });
  await page.mouse.move(third.x + third.width / 2, top.y + 4, { steps: 4 });
  await page.mouse.up();
  await expect.poll(order).toEqual([3, 1, 2]);
  await expect(rows.nth(0)).toContainText('Not set up yet');
  expect((await status(page)).wallet).toBe(A.ethAddress); // the drop pressed nothing: no switch
  await touchDrag(page, 0, 1, 0); // a swipe: the page's scroll, no reorder
  await page.waitForTimeout(500);
  expect(await order()).toEqual([3, 1, 2]);
  await touchDrag(page, 0, 1, 450); // pressed and held, then dragged
  await expect.poll(order).toEqual([1, 3, 2]);
  await page.reload();
  expect(await loaded(page)).toBe('home');
  await page.evaluate(() => { location.hash = '#wallet'; });
  await expect(rows.nth(1)).toContainText('Not set up yet');
  expect(await order()).toEqual([1, 3, 2]);
  await expect(page.evaluate(() => window.satori.orderWallets([1, 2]))).rejects.toThrow("each of this app's wallets once");
  expect((await page.evaluate(() => window.satori.orderWallets([1, 2, 3]))).wallets.map((w) => w.id)).toEqual([1, 2, 3]);
  await expect(rows.nth(2)).toContainText('Not set up yet');

  expect(await reloading(page, () => rows.nth(1).locator('[data-test=wallet-switch]').click())).toBe('home');
  const b = await status(page);
  expect([b.wallet, b.alias, b.unlocked]).toEqual([B.ethAddress, aliasB, false]);

  // Remove: asked first; Cancel keeps it; the one in use can't be
  await page.evaluate(() => { location.hash = '#wallet'; });
  await rows.nth(0).locator('[data-test=wallet-remove]').click();
  await expect(page.locator('[data-test=wallet-remove-confirm]')).toContainText('never deleted');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('[data-test=wallet-remove-confirm]')).toBeHidden();
  await expect(page.evaluate(() => window.satori.removeWallet(2))).rejects.toThrow(/switch to another first/);
  // that wallet's own passphrase is asked (the owner, 2026-10-28), checked against its file: wrong, nothing removed
  await expect(page.evaluate(() => window.satori.removeWallet(1))).rejects.toThrow("The wallet's passphrase is needed");
  await rows.nth(0).locator('[data-test=wallet-remove]').click();
  const pass = page.locator('[data-test=wallet-remove-pass]');
  await expect(pass).toBeVisible({ timeout: 30_000 }); // that wallet's file opened to read its keys: seconds on a busy box
  await expect(page.locator('[data-test=wallet-remove-confirm]')).toContainText("Enter that wallet's passphrase to remove it.");
  await pass.fill('not its passphrase');
  await page.locator('[data-test=wallet-remove-yes]').click();
  await expect(page.locator('[data-test=wallets-error]')).toHaveText('Wrong passphrase', { timeout: 30_000 });
  await expect(rows).toHaveCount(3);
  await pass.fill(PASS);
  await page.locator('[data-test=wallet-remove-yes]').click();
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  expect(await page.evaluate(() => window.satori.removeWallet(3))).toEqual({ active: 2, wallets: [{ id: 2, address: B.ethAddress, name: null, nameAuto: false, active: true }] });
  // the first wallet's file set aside, never deleted (its keys may be ones its words can't bring back); the unfinished one had none
  expect(await opfsFiles(page)).toEqual(['satori-2.duckdb']);
  const all = await page.evaluate(async () => { const n = []; for await (const [k] of (await navigator.storage.getDirectory()).entries()) n.push(k); return n; });
  expect(all.filter((n) => /^satori-mvp\.duckdb\.removed-/.test(n))).toHaveLength(1);

  // a reload keeps the second wallet
  await page.reload();
  expect(await loaded(page)).toBe('home');
  expect((await status(page)).wallet).toBe(B.ethAddress);
});

test("sub-wallets: 12 words list their keys, derive 20 more and switch to one, still one wallet; Create's has none", async ({ context, page }) => {
  test.setTimeout(240_000);
  await stubCentral(context);
  const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // BIP-39's test words
  const pub = (path) => bytesToHex(HDKey.fromMasterSeed(mnemonicToSeedSync(WORDS)).derive(path).publicKey);
  expect(await openApp(page)).toBe('setup');
  const made = (await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS)).wallet; // Create: a new wallet
  await page.evaluate(() => { location.hash = '#wallet'; });
  await expect(page.locator('[data-test=wallets]')).toBeVisible();
  await expect(page.locator('[data-test=sub-wallets]')).toBeHidden();

  // Import's 12 words, on the Setup screen, as a second wallet
  expect(await reloading(page, () => page.locator('[data-test=add-wallet]').click())).toBe('setup');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('[data-test=import-wallet]').fill(WORDS);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Passphrase', { exact: true }).filter({ visible: true }).fill(PASS);
  await page.getByLabel('Repeat passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  expect((await status(page)).wallet).toBe(evmAddress(pub("m/44'/60'/0'/0/0")));
  await page.evaluate(() => { location.hash = '#wallet'; });
  const card = page.locator('[data-test=sub-wallets]');
  const rows = card.locator('[data-test=sub-wallet-row]');
  await expect(rows).toHaveCount(21);
  const shows = async (n, label, path, use) => {
    const r = rows.nth(n);
    await expect(r.locator('[data-test=sub-wallet-label]')).toHaveText(label);
    await expect(r.locator('[data-test=sub-wallet-path]')).toHaveText(path);
    await expect(r.locator(`[data-test=sub-wallet-${use}]`)).toHaveCount(1);
  };
  await shows(0, 'The key Import made', "m/44'/60'/0'/0/0", 'in-use');
  await shows(1, 'Receive 0', "m/44'/175'/0'/0/0", 'switch');
  await shows(2, 'Change 0', "m/44'/175'/0'/1/0", 'switch');
  await shows(3, 'Receive 1', "m/44'/175'/0'/0/1", 'switch');
  const change0 = pub("m/44'/175'/0'/1/0");
  await expect(rows.nth(2).locator('[data-test=sub-wallet-evrmore]')).toHaveAttribute('title', evrmoreAddress(change0));
  await expect(rows.nth(2).locator('[data-test=sub-wallet-address]')).toHaveAttribute('title', evmAddress(change0));
  await page.setViewportSize({ width: 390, height: 844 });
  await card.screenshot({ path: test.info().outputPath('sub-wallets-card.png') });

  await card.locator('[data-test=sub-wallet-more]').click(); // Derive 20 more
  await expect(rows).toHaveCount(41);
  await shows(40, 'Change 19', "m/44'/175'/0'/1/19", 'switch');

  // Switch to Change 0: asked first, with the passphrase; a wrong one refused
  await rows.nth(2).locator('[data-test=sub-wallet-switch]').click();
  const confirm = card.locator('[data-test=sub-wallet-confirm]');
  await expect(confirm).toContainText(`Switch to Change 0, ${evmAddress(change0).slice(0, 6)}`);
  await confirm.screenshot({ path: test.info().outputPath('sub-wallets-confirm.png') });
  await card.locator('[data-test=sub-wallet-pass]').fill('not the passphrase');
  await card.locator('[data-test=sub-wallet-yes]').click();
  await expect(card.locator('[data-test=sub-wallets-error]')).toHaveText('Wrong passphrase', { timeout: 30_000 });
  await card.locator('[data-test=sub-wallet-pass]').fill(PASS);
  expect(await reloading(page, () => card.locator('[data-test=sub-wallet-yes]').click())).toBe('home');
  expect((await status(page)).wallet).toBe(evmAddress(change0));
  await page.evaluate(() => { location.hash = '#wallet'; });
  await expect(rows).toHaveCount(41);
  await shows(2, 'Change 0', "m/44'/175'/0'/1/0", 'in-use');
  await shows(0, 'The key Import made', "m/44'/60'/0'/0/0", 'switch');
  // one wallet still, its address the key's now
  expect((await wallets(page)).wallets.map((w) => [w.id, w.address, w.active])).toEqual([[1, made, false], [2, evmAddress(change0), true]]);
  await expect(page.locator('[data-test=wallets] [data-test=wallet-row]')).toHaveCount(2);
});
