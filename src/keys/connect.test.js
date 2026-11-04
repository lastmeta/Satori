import { describe, expect, test } from 'vitest';
import { recoverMessageAddress } from 'viem';
import { findWallets, requestAddress, signText, connectedWallet, showKeysText, INJECTED } from './connect.js';
import { connectedRecord, recordFromBackup, restoredRecord, keepRetired, loadKeys, unlockWallet, backupKeys, connectedBackup, CONNECTED, linkMessage } from './index.js';
import { publicKey, evmAddress, wordsOf } from './keys.js';
import { nsec } from '../nostr/event.js';
import { fakeWallet } from '../../test/fake-wallet.js';

const noChain = { request: async () => { throw new Error('no chain here'); } };
const appOf = (byte) => fakeWallet({ key: `0x${byte.repeat(32)}`, transport: () => noChain });

/** A window where `wallets` announce themselves (EIP-6963) on the request, and maybe an injected one. */
function windowWith(wallets, injected = null) {
  const target = new EventTarget();
  target.ethereum = injected;
  target.addEventListener('eip6963:requestProvider', () => {
    for (const w of wallets) target.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), { detail: w }));
  });
  return target;
}

describe('finding the wallets in this browser (EIP-6963, else window.ethereum)', () => {
  test('each announced wallet once, by its rdns and name; the injected one only when none announce', async () => {
    const mm = { info: { rdns: 'io.metamask', name: 'MetaMask' }, provider: appOf('11').provider };
    const rb = { info: { rdns: 'me.rainbow', name: 'Rainbow' }, provider: appOf('12').provider };
    const found = await findWallets({ win: windowWith([mm, rb, mm], { request: () => {} }), wait: 5 });
    expect(found.map((w) => [w.rdns, w.name])).toEqual([['io.metamask', 'MetaMask'], ['me.rainbow', 'Rainbow']]);
    const injected = { request: () => {} };
    expect(await findWallets({ win: windowWith([], injected), wait: 5 })).toEqual([{ rdns: INJECTED, name: 'Browser wallet', provider: injected }]);
    expect(await findWallets({ win: windowWith([]), wait: 5 })).toEqual([]);
  });
});

describe('the wallet app: its account, its checked signatures', () => {
  test('requestAddress: its chosen account, EIP-55', async () => {
    const app = appOf('21');
    app.state.accounts = [app.address.toLowerCase()];
    expect(await requestAddress(app.provider)).toBe(app.address);
  });
  test('signText: personal_sign, checked to recover to the address; another account\'s signature is refused', async () => {
    const app = appOf('22');
    const sig = await signText(app.provider, app.address, 'hello');
    expect(await recoverMessageAddress({ message: 'hello', signature: sig })).toBe(app.address);
    await expect(signText(app.provider, '0x' + '99'.repeat(20), 'hello')).rejects.toThrow('signed with another account');
  });
  test('connectedWallet: what the chain module signs with; its account asked for before each signature', async () => {
    const app = appOf('23');
    const w = connectedWallet({ address: app.address, name: 'MetaMask', provider: app.provider });
    expect(w).toMatchObject({ evmAddress: app.address, name: 'MetaMask', connected: true, locked: false });
    await w.provider.request({ method: 'eth_chainId' });
    expect(app.calls).toEqual(['eth_chainId']); // a read: nothing asked first
    app.state.accounts = ['0x' + '98'.repeat(20)];
    await expect(w.provider.request({ method: 'personal_sign', params: ['0x00', app.address] }))
      .rejects.toThrow(`MetaMask is on another account: choose ${app.address} in it, then try again.`);
  });
});

describe('a connected wallet\'s record (docs/design/wallets.md#a-connected-wallet)', () => {
  test('its alias and Nostr key random, the wallet\'s address and how to find it again, its link signed by the wallet', async () => {
    const app = appOf('31');
    const sign = (message) => signText(app.provider, app.address, message);
    const r = await connectedRecord({ address: app.address, rdns: 'io.metamask', name: 'MetaMask', signLink: sign });
    expect(r).toMatchObject({ v: 1, from: 'random', wallet: { kind: 'connected', address: app.address, rdns: 'io.metamask', name: 'MetaMask' } });
    const aliasAddress = evmAddress(publicKey(Uint8Array.from(r.alias.match(/../g), (b) => parseInt(b, 16))));
    expect(r.link.message).toBe(linkMessage({ alias: aliasAddress, wallet: app.address, issued: r.created }));
    expect(await recoverMessageAddress({ message: r.link.message, signature: r.link.signature })).toBe(app.address);
    expect(JSON.stringify(r)).not.toMatch(/"data"|"yaml"|kdf/); // nothing of the wallet's but its address
    const k = loadKeys(r);
    expect(k.wallet).toEqual({ pubkey: null, evmAddress: app.address, connected: { rdns: 'io.metamask', name: 'MetaMask' } });
    expect(k.alias.evmAddress).toBe(aliasAddress);
  });
  test('no Unlock and no passphrase; Backup: the alias\'s and the Nostr key\'s, never the wallet\'s words', async () => {
    const app = appOf('32');
    const sign = (m) => signText(app.provider, app.address, m);
    const r = await connectedRecord({ address: app.address, rdns: INJECTED, name: 'Browser wallet', signLink: sign });
    await expect(unlockWallet(r, 'anything')).rejects.toThrow(CONNECTED);
    await expect(backupKeys(r, 'alias', 'anything')).rejects.toThrow(CONNECTED);
    expect(connectedBackup(r, 'alias')).toEqual({ words: expect.any(String), privateKey: `0x${r.alias}` });
    expect(connectedBackup(r, 'nostr')).toEqual({ nsec: expect.stringMatching(/^nsec1/), secret: r.nostr });
    expect(Object.keys(connectedBackup(r))).toEqual(['alias', 'nostr', 'retired', 'offchain', 'onchain']);
    expect(() => connectedBackup(r, 'wallet')).toThrow("This wallet's words are in Browser wallet: back it up there.");
  });
  test('no signature makes its keys (the audit, 2026-10-31): the wallet signs only the link, and the same wallet connected again gets other keys', async () => {
    const app = appOf('33');
    const signed = [];
    const signLink = (m) => { signed.push(m); return signText(app.provider, app.address, m); };
    const [a, b] = [await connectedRecord({ address: app.address, rdns: INJECTED, name: 'Browser wallet', signLink }),
      await connectedRecord({ address: app.address, rdns: INJECTED, name: 'Browser wallet', signLink })];
    expect(signed).toEqual([a.link.message, b.link.message]);
    expect(a.alias).not.toBe(b.alias);
    expect(a.nostr).not.toBe(b.nostr);
  });
  test('restoredRecord: its alias, its Nostr key or both from a backup, a new link for them; refused otherwise', async () => {
    const app = appOf('34');
    const sign = (m) => signText(app.provider, app.address, m);
    const r = await connectedRecord({ address: app.address, rdns: INJECTED, name: 'Browser wallet', signLink: sign });
    const held = await connectedRecord({ address: app.address, rdns: INJECTED, name: 'Browser wallet', signLink: sign }); // the backed-up ones
    const both = await restoredRecord(r, { alias: `0x${held.alias}`, nostr: nsec(held.nostr) }, sign);
    expect([both.alias, both.nostr, both.from, both.wallet]).toEqual([held.alias, held.nostr, 'random', r.wallet]);
    expect(both.link.message).toContain(`alias: ${loadKeys(held).alias.evmAddress}\nwallet: ${app.address}\n`);
    expect(await recoverMessageAddress({ message: both.link.message, signature: both.link.signature })).toBe(app.address);
    expect(keepRetired(r, both).retired).toEqual([{ alias: r.alias, nostr: r.nostr, at: expect.any(Number) }]); // storing keeps the old
    // a backup alone (no wallet app, no signature): the same keys and the link it already signed
    const back = recordFromBackup({ address: app.address, aliasWords: `0x${both.alias}`, nostrKey: nsec(both.nostr), retired: [], connected: { rdns: INJECTED, name: 'Browser wallet', link: both.link } });
    expect([back.alias, back.nostr, back.from, back.link, back.wallet]).toEqual([both.alias, both.nostr, 'random', both.link, both.wallet]);
    expect(loadKeys(back).wallet.evmAddress).toBe(app.address);
    const words = await restoredRecord(r, { alias: wordsOf(Uint8Array.from(held.alias.match(/../g), (b) => parseInt(b, 16))), nostr: '' }, sign);
    expect([words.alias, words.nostr]).toEqual([held.alias, r.nostr]); // an empty one is kept
    expect((await restoredRecord(r, { nostr: held.nostr }, sign))).toMatchObject({ alias: r.alias, nostr: held.nostr });
    const never = () => { throw new Error('signed'); };
    await expect(restoredRecord(r, { alias: ' ', nostr: '' }, never)).rejects.toThrow('Give the alias key, the Nostr key, or both.');
    await expect(restoredRecord(r, { alias: 'nonsense' }, never)).rejects.toThrow('The alias key: not 24 backup words or a private key.');
    await expect(restoredRecord(r, { nostr: 'nonsense' }, never)).rejects.toThrow('Not a Nostr key');
    await expect(restoredRecord(r, { alias: r.alias, nostr: r.nostr }, never)).rejects.toThrow('Those are the keys this app has now.');
    await expect(restoredRecord(r, { alias: '34'.repeat(32) }, never)).rejects.toThrow('The alias and the wallet must not be the same key.'); // appOf's key
  });
  test('the text a connected wallet signs to show the app\'s keys', () => {
    expect(showKeysText('0x' + 'ab'.repeat(20), 1792000000)).toBe(`Satori: show this app's keys\nwallet: 0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB\nissued: 1792000000`);
  });
});
