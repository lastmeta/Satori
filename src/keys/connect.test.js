import { describe, expect, test } from 'vitest';
import { recoverMessageAddress } from 'viem';
import { findWallets, requestAddress, signText, connectedWallet, showKeysText, INJECTED } from './connect.js';
import { connectedRecord, loadKeys, unlockWallet, backupKeys, connectedBackup, CONNECTED, linkMessage } from './index.js';
import { publicKey, evmAddress } from './keys.js';
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
  test('a new alias and Nostr key, the wallet\'s address and how to find it again, its link signed by the wallet', async () => {
    const app = appOf('31');
    const r = await connectedRecord({ address: app.address, rdns: 'io.metamask', name: 'MetaMask',
      signLink: (message) => signText(app.provider, app.address, message) });
    expect(r).toMatchObject({ v: 1, wallet: { kind: 'connected', address: app.address, rdns: 'io.metamask', name: 'MetaMask' } });
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
    const r = await connectedRecord({ address: app.address, rdns: INJECTED, name: 'Browser wallet', signLink: (m) => signText(app.provider, app.address, m) });
    await expect(unlockWallet(r, 'anything')).rejects.toThrow(CONNECTED);
    await expect(backupKeys(r, 'alias', 'anything')).rejects.toThrow(CONNECTED);
    expect(connectedBackup(r, 'alias')).toEqual({ words: expect.any(String), privateKey: `0x${r.alias}` });
    expect(connectedBackup(r, 'nostr')).toEqual({ nsec: expect.stringMatching(/^nsec1/), secret: r.nostr });
    expect(Object.keys(connectedBackup(r))).toEqual(['alias', 'nostr']);
    expect(() => connectedBackup(r, 'wallet')).toThrow("This wallet's words are in Browser wallet: back it up there.");
  });
  test('the text a connected wallet signs to show the app\'s keys', () => {
    expect(showKeysText('0x' + 'ab'.repeat(20), 1792000000)).toBe(`Satori: show this app's keys\nwallet: 0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB\nissued: 1792000000`);
  });
});
