// The agent API for what the screens do (public/llms.txt): an encrypted backup restored in a fresh browser, the Game
// tab by call (its streams, favorites, playing by hand), a day of Home's strip, a Docker (Lite) import; against the fake
// Satori contract behind /rpc (test/fake-satori.js).
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fakeSatori, E18 } from '../test/fake-satori.js';
import { openApp, loaded, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';
import { keysFromWallet } from '../src/keys/derive.js';
import { publicKey, evmAddress } from '../src/keys/keys.js';
import { evrmoreAddress } from '../src/keys/hd.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils';

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
  // the QR code first, big; the address under it, which a tap copies (no Copy button: the owner, 2026-10-30)
  const box = async (sel) => page.locator(`[data-test=wallet-receive-card] ${sel}`).first().boundingBox();
  const [qr, addr] = [await box('[data-test=base-qr]'), await box('[data-test=base-receive-address]')];
  expect(qr.y < addr.y && qr.width >= 240).toBe(true);
  await expect(page.locator('[data-test=wallet-receive-card] button')).toHaveCount(0);
  await page.locator('[data-test=wallet-receive-card]').screenshot({ path: test.info().outputPath('receive.png') });

  // a fresh browser (its storage wiped): the backup restores the same wallet, and all that goes with it
  await call(page, 'poll');
  await call(page, 'setServicePaused', true);
  const none = await call(page, 'exportModels');
  expect(none).toMatchObject({ kind: 'satori-models', v: 1, service: expect.any(String), models: [] }); // this stub's Service has no streams
  const row = { uuid: 'u-a', spec: { companions: [], lambda1: 0.2, lambda2: 0.5 }, score: 0.5, persist: null, influence: null, generation: 2, accepted: 1, fit_key: null };
  expect(await call(page, 'importModels', { ...none, models: [row] })).toBe(1);
  const models = await call(page, 'exportModels');
  expect(models.models).toEqual([row]);
  const whole = await call(page, 'exportBackup', PASS);
  const fresh = await browser.newContext();
  try {
    await stubCentral(fresh, { rpc });
    const p2 = await fresh.newPage();
    await openApp(p2);
    await expect(call(p2, 'setup', { passphrase: 'wrong passphrase', backup: file })).rejects.toThrow('Wrong passphrase');
    await call(p2, 'setup', { passphrase: PASS, backup: JSON.stringify(whole) });
    await expect(p2.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
    expect((await call(p2, 'base')).wallet.address).toBe(V);
    expect((await call(p2, 'backup', 'wallet', PASS)).words).toBe(words);
    expect((await call(p2, 'status')).central.paused).toBe(true);
    expect((await call(p2, 'base')).play).toBe('manual');
    expect((await call(p2, 'game')).favorites).toEqual([1]);
    expect((await call(p2, 'exportModels')).models).toEqual(models.models);
    expect(await call(p2, 'importModels', models)).toBe(models.models.length);
    await expect(call(p2, 'importModels', { ...models, service: 'https://other.example' })).rejects.toThrow('another Satori Service');
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

test('an alias for each job by call: a Docker install\'s for the Satori Service, another for the Satori contract', async ({ context, page }) => {
  test.setTimeout(240_000);
  const stub = await stubCentral(context);
  const [neuron, chain] = fx.vectors; // a Docker install's alias, and another (any keys not this wallet's)
  const reload = async (fn, ...args) => {
    const loaded = page.waitForEvent('load');
    const r = await call(page, fn, ...args);
    await loaded;
    await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
    return r;
  };
  const regsAfter = async (n, count) => {
    await expect.poll(() => stub.registered.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(n + count);
    const regs = stub.registered.slice(n, n + count);
    expect(regs.map((h) => h.proven)).toEqual(regs.map(() => true)); // each signed by the alias it registers
    return regs.map((h) => [h['alias-pubkey'], h['alias-scoring'], h['alias-reported-by'], !!h['wallet-link']]);
  };
  await openApp(page);
  await call(page, 'setup', { passphrase: PASS });
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  let s = await call(page, 'status');
  const own = s.alias;
  expect([s.serviceAlias, s.contractAlias]).toEqual([own, own]);
  const ownPubkey = stub.registered.at(-1)['alias-pubkey'];
  expect(stub.registered.at(-1)['alias-scoring']).toBe('offchain,onchain');
  await expect(call(page, 'setServiceAlias', neuron.entropyHex, { passphrase: 'wrong passphrase' })).rejects.toThrow('Wrong passphrase');

  // the Satori Service's: the neuron's alias registers for off-chain scoring, the app's own for on-chain
  let n = stub.registered.length;
  expect(await reload('setServiceAlias', neuron.entropyHex, { passphrase: PASS })).toEqual({ serviceAlias: neuron.ethAddress, contractAlias: own });
  expect(await regsAfter(n, 2)).toEqual([[neuron.pubkey, 'offchain', 'app', true], [ownPubkey, 'onchain', 'app', true]]);
  expect((await call(page, 'backup', 'offchain', PASS)).privateKey).toBe(`0x${neuron.entropyHex}`);

  // the Satori contract's too: the app's own does neither job; the Wallet tab's alias is the contract's
  n = stub.registered.length;
  expect(await reload('setContractAlias', chain.entropyHex, { passphrase: PASS })).toEqual({ serviceAlias: neuron.ethAddress, contractAlias: chain.ethAddress });
  expect(await regsAfter(n, 2)).toEqual([[neuron.pubkey, 'offchain', 'app', true], [chain.pubkey, 'onchain', 'app', true]]);
  expect((await call(page, 'base')).alias.address).toBe(chain.ethAddress);
  await call(page, 'go', 'service');
  await expect(page.locator('[data-test=alias-offchain-address]')).toHaveAttribute('title', neuron.ethAddress);
  await call(page, 'go', 'contract');
  await expect(page.locator('[data-test=alias-onchain-address]')).toHaveAttribute('title', chain.ethAddress);

  // one key for both jobs: one register, both jobs
  n = stub.registered.length;
  await reload('setContractAlias', neuron.entropyHex, { passphrase: PASS });
  expect(await regsAfter(n, 1)).toEqual([[neuron.pubkey, 'offchain,onchain', 'app', true]]);

  // both handed back: one alias again; the imported ones kept as earlier keys
  await reload('setContractAlias', null);
  await reload('setServiceAlias', null);
  s = await call(page, 'status');
  expect([s.serviceAlias, s.contractAlias]).toEqual([own, own]);
  expect((await call(page, 'backup', 'retired', PASS)).map((k) => k.address)).toEqual(expect.arrayContaining([neuron.ethAddress, chain.ethAddress]));
});

test('a pool by call and on Settings: the open pools, stake with one, unstake (docs/design/central.md#the-pool)', async ({ context, page }) => {
  test.setTimeout(180_000);
  const stub = await stubCentral(context);
  const [big, cheap] = fx.vectors.map((v) => v.ethAddress);
  stub.pools = [{ address: big, pool_name: 'big pool', commission: 40 }, { address: cheap, pool_name: '', commission: 5 }];
  await openApp(page);
  await call(page, 'setup', { passphrase: PASS });
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  expect(await call(page, 'pool')).toMatchObject({ address: null, isPool: false });
  expect(await call(page, 'openPools')).toEqual([{ address: cheap, name: null, commission: 5 }, { address: big, name: 'big pool', commission: 40 }]);
  await expect(call(page, 'stakeWithPool', '0x123')).rejects.toThrow('A pool address is a Base address');
  expect(await call(page, 'stakeWithPool', cheap.toLowerCase())).toMatchObject({ address: cheap, commission: 5 });
  expect(stub.poolCalls.at(-1)).toEqual({ method: 'POST', body: { pool_address: cheap } });

  // on the Satori Service page: what it stakes with now; pick another from the list; unstake
  await call(page, 'go', 'service');
  await expect(page.locator('[data-test=pool-now]')).toContainText('5% fee');
  await page.locator('[data-test=pool-pick]', { hasText: 'big pool' }).click();
  await expect(page.locator('[data-test=pool-input]')).toHaveValue(big);
  await page.click('[data-test=pool-stake]');
  await expect(page.locator('[data-test=pool-now]')).toContainText('big pool');
  await expect(page.locator('[data-test=pool-done]')).toContainText('Staked with big pool');
  expect(stub.lending).toBe(big);
  await page.fill('[data-test=pool-input]', `0x${'ab'.repeat(20)}`);
  await page.click('[data-test=pool-stake]');
  await expect(page.locator('[data-test=pool-error]')).toContainText('Pool not found');
  await page.click('[data-test=pool-unstake]');
  await expect(page.locator('[data-test=pool-now]')).toHaveText('No pool');
  expect(await call(page, 'pool')).toMatchObject({ address: null, workerOf: null });

  // a pool lists this app as its worker without asking: the Worker card shows it, and Leave pool takes it off
  stub.workerOf = { address: big, pool_name: 'big pool' };
  expect(await call(page, 'pool')).toMatchObject({ workerOf: { address: big, name: 'big pool' } });
  await expect(page.locator('[data-test=worker-pool-now]')).toContainText('big pool');
  await page.click('[data-test=worker-pool-leave]');
  await expect(page.locator('[data-test=worker-pool-now]')).toHaveText('None');
  await expect(page.locator('[data-test=worker-pool-leave]')).toBeHidden();
  expect(stub.workerOf).toBe(null);
  await expect(call(page, 'leaveWorkerPool')).rejects.toThrow('No pool lists this app as its worker.');
  stub.workerOf = { address: cheap, pool_name: '' };
  expect(await call(page, 'pool')).toMatchObject({ workerOf: { address: cheap, name: null } });
  expect(await call(page, 'leaveWorkerPool')).toMatchObject({ workerOf: null });
});

test("sub-wallets by call: a private key's wallet has none; 12 words list theirs, derive more and switch; another wallet's key refused", async ({ context, page }) => {
  test.setTimeout(240_000);
  await stubCentral(context);
  const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // BIP-39's test words
  const key = (path) => HDKey.fromMasterSeed(mnemonicToSeedSync(WORDS)).derive(path);
  const addressOf = (path) => evmAddress(bytesToHex(key(path).publicKey));
  const reloading = async (fn) => {
    const next = page.waitForEvent('load', { timeout: LOAD_TIMEOUT });
    const out = await fn();
    await next;
    expect(await loaded(page)).toBe('home');
    return out;
  };
  // the first wallet: Receive 1's own private key, imported by itself
  await openApp(page);
  const receive1 = (await call(page, 'setup', { passphrase: PASS, walletWords: `0x${bytesToHex(key("m/44'/175'/0'/0/1").privateKey)}` })).wallet;
  expect(receive1).toBe(addressOf("m/44'/175'/0'/0/1"));
  expect(await call(page, 'subWallets')).toBe(null);
  await expect(call(page, 'deriveSubWallets')).rejects.toThrow('This wallet was not imported from words: it has no sub-wallets.');

  // a second wallet, from the 12 words
  const next = page.waitForEvent('load', { timeout: LOAD_TIMEOUT });
  await call(page, 'addWallet');
  await next;
  expect(await loaded(page)).toBe('setup');
  expect((await call(page, 'setup', { passphrase: PASS, walletWords: WORDS })).wallet).toBe(addressOf("m/44'/60'/0'/0/0"));
  let sw = await call(page, 'subWallets');
  expect([sw.at, sw.count, sw.rows.length]).toEqual([null, 10, 21]);
  const change0 = bytesToHex(key("m/44'/175'/0'/1/0").publicKey);
  expect(sw.rows.slice(0, 3)).toEqual([
    { n: 0, kind: 'import', index: null, path: "m/44'/60'/0'/0/0", evrmore: evrmoreAddress(bytesToHex(key("m/44'/60'/0'/0/0").publicKey)), address: addressOf("m/44'/60'/0'/0/0"), inUse: true },
    { n: 1, kind: 'receive', index: 0, path: "m/44'/175'/0'/0/0", evrmore: evrmoreAddress(bytesToHex(key("m/44'/175'/0'/0/0").publicKey)), address: addressOf("m/44'/175'/0'/0/0"), inUse: false },
    { n: 2, kind: 'change', index: 0, path: "m/44'/175'/0'/1/0", evrmore: evrmoreAddress(change0), address: evmAddress(change0), inUse: false },
  ]);
  expect(sw.rows[3]).toMatchObject({ n: 3, kind: 'receive', index: 1, address: receive1 });
  sw = await call(page, 'deriveSubWallets');
  expect([sw.count, sw.rows.length, sw.rows[40].path]).toEqual([20, 41, "m/44'/175'/0'/1/19"]);
  expect((await call(page, 'subWallets')).count).toBe(20);

  // a switch: the passphrase, never the row in use, never another wallet's key
  await expect(call(page, 'useSubWallet', 3, PASS)).rejects.toThrow('This wallet is already in this app');
  await expect(call(page, 'useSubWallet', 2, 'not the passphrase')).rejects.toThrow('Wrong passphrase');
  await expect(call(page, 'useSubWallet', 0, PASS)).rejects.toThrow('That key is the one in use.');
  await expect(call(page, 'useSubWallet', 41, PASS)).rejects.toThrow('No sub-wallet 41: rows 0 to 40.');
  const aliasBefore = (await call(page, 'status')).alias;
  expect(await reloading(() => call(page, 'useSubWallet', 2, PASS))).toEqual({ reloading: true });
  const st = await call(page, 'status');
  expect([st.wallet, st.unlocked]).toEqual([evmAddress(change0), false]);
  expect(st.alias).toBe(evmAddress(publicKey(keysFromWallet(key("m/44'/175'/0'/1/0").privateKey).alias)));
  sw = await call(page, 'subWallets');
  expect([sw.at, sw.count, sw.rows.filter((r) => r.inUse).map((r) => r.n)]).toEqual([{ change: 1, index: 0 }, 20, [2]]);
  expect((await call(page, 'wallets')).wallets.map((w) => [w.id, w.address, w.active])).toEqual([[1, receive1, false], [2, evmAddress(change0), true]]);
  const earlier = await call(page, 'backup', 'retired', PASS); // the alias it had, kept
  expect(earlier.map((k) => k.address)).toContain(aliasBefore);
});
