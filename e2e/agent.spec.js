// The agent API for what the screens do (public/llms.txt): an encrypted backup restored in a fresh browser, the Game
// tab by call (its streams, favorites, playing by hand), a day of Home's strip, a Docker (Lite) import; against the fake
// Satori contract behind /rpc (test/fake-satori.js).
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';
import { keysFromWallet } from '../src/keys/derive.js';
import { publicKey, evmAddress } from '../src/keys/keys.js';

const PASS = 'correct horse battery';
const ROUND = 20741;
const fx = JSON.parse(readFileSync(new URL('../test/fixtures/alias-parity.json', import.meta.url)));
const call = (page, fn, ...args) => page.evaluate(([f, a]) => window.satori[f](...a), [fn, args]);
const hourly = (n, f) => Array.from({ length: n }, (_, i) => ({ hour: ROUND * 24 - n + i, value: BigInt(Math.round(f(i))) }));

test('an encrypted backup, restored in a fresh browser; the game by call; a day of the strip', async ({ browser, context, page }) => {
  test.setTimeout(180_000);
  const { s, rpc } = fakeSatori({ round: ROUND, hour: 9 });
  await stubCentral(context, { rpc });
  s.streams[2] = { game: 2, named: false, cadence: 60, name: 'bitcoin', history: hourly(48, (i) => 80000 + i) };
  s.weights[2] = 3n * E18;
  await openApp(page);
  await call(page, 'setup', { passphrase: PASS });
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  const V = (await call(page, 'base')).wallet.address;
  rpc.eth[V.toLowerCase()] = 10n ** 17n;

  // the backup: every key sealed with the passphrase, nothing in clear
  const file = await call(page, 'exportBackup', PASS);
  expect(file).toMatchObject({ kind: 'satori-backup', v: 1, address: V });
  const words = (await call(page, 'backup', 'wallet', PASS)).words;
  expect(JSON.stringify(file)).not.toContain(words.split(' ')[0] + ' ' + words.split(' ')[1]);
  await expect(call(page, 'exportBackup', 'wrong passphrase')).rejects.toThrow('Wrong passphrase');

  // the game: automatic until the person asks; then its streams, favorites, and a play from the wallet
  let g = await call(page, 'game');
  expect(g).toMatchObject({ play: 'auto', by: 'wallet', playedToday: null });
  expect(g.streams.map((x) => [x.streamId, x.name, x.eligible])).toEqual([[2, 'bitcoin', true], [1, 'satori', true]]);
  await expect(call(page, 'playGame', [{ streamId: 2, direction: 'up' }])).rejects.toThrow(/setPlay\('manual'\)/);
  await call(page, 'setPlay', 'manual');
  expect(await call(page, 'setGameFavorites', [1])).toEqual([1]);
  expect((await call(page, 'game')).streams.map((x) => x.streamId)).toEqual([1, 2]);
  await expect(call(page, 'playGame', [{ streamId: 2, direction: 'up' }])).rejects.toThrow('Unlock the wallet first');
  await expect(call(page, 'playGame', [{ streamId: 9, direction: 'up' }])).rejects.toThrow("Stream 9 can't be played now.");
  await call(page, 'unlock', PASS);
  const sent = await call(page, 'playGame', [{ streamId: 2, direction: 'up' }, { streamId: 1, direction: 'down' }]);
  expect(sent).toMatchObject({ count: 2, by: 'wallet', hash: expect.stringMatching(/^0x/) });
  expect(s.batches[0]).toMatchObject({ from: V.toLowerCase(), requests: [{ gameId: 2, payload: '0x01' }, { gameId: 1, payload: '0x02' }] });
  g = await call(page, 'game');
  expect(g.playedToday).toMatchObject({ count: 2 });
  expect(g.opensAt).toBe((g.round + 1) * 86400); // bitcoin isn't a Sentiment stream: the next 00:00 UTC
  await expect(call(page, 'remindMe')).rejects.toThrow("This browser can't wake Satori with a notification."); // the dev server
  expect(g.streams.every((x) => x.alreadyPredicted)).toBe(true);

  // a day of Home's strip
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  expect(await call(page, 'day', today)).toMatchObject({ date: today, network: expect.any(Object), contract: expect.any(Object) });

  // Home's next-step card put away for 3 days (kept on this device); the Wallet tab's Receive: the address and its QR code
  await call(page, 'dismiss', 'next-step');
  expect(Number(await page.evaluate(() => localStorage.getItem('satori-next-step')))).toBeGreaterThan(0);
  await call(page, 'go', 'wallet');
  await page.locator('[data-test=base-receive]').click();
  await expect(page.locator('[data-test=base-receive-address]')).toHaveText(V);
  await expect(page.locator('[data-test=base-qr]')).toHaveAttribute('src', /^data:image\/svg\+xml/);

  // a fresh browser (its storage wiped): the backup restores the same wallet
  const fresh = await browser.newContext();
  try {
    await stubCentral(fresh, { rpc });
    const p2 = await fresh.newPage();
    await openApp(p2);
    await expect(call(p2, 'setup', { passphrase: 'wrong passphrase', backup: file })).rejects.toThrow('Wrong passphrase');
    await call(p2, 'setup', { passphrase: PASS, backup: JSON.stringify(file) });
    await expect(p2.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
    expect((await call(p2, 'base')).wallet.address).toBe(V);
    expect((await call(p2, 'backup', 'wallet', PASS)).words).toBe(words);
  } finally {
    await fresh.close();
  }
});

test('a Docker (Lite) install imported by call', async ({ context, page }) => {
  test.setTimeout(120_000);
  await stubCentral(context);
  const current = fx.vectors[fx.wallets.current.vector];
  const derived = keysFromWallet(Uint8Array.from(current.entropyHex.match(/../g), (x) => parseInt(x, 16))).alias; // the alias, from the wallet
  await openApp(page);
  await call(page, 'importDocker', { wallet: fx.wallets.current.yaml, password: fx.wallets.password, passphrase: PASS });
  await expect(page.locator('[data-test=alias]')).toHaveText(evmAddress(publicKey(derived)), { timeout: 30_000 });
  expect((await call(page, 'base')).wallet.address).toBe(fx.vectors[fx.wallets.current.vector].ethAddress);
});
