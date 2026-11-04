// The alias for the Satori Service (docs/design/wallets.md#the-alias-for-the-satori-service): a Dockerized Neuron's
// alias, imported, signs for the Satori Service; the app's own alias stays for the Satori contract.
import { recoverMessageAddress, verifyMessage } from 'viem';
import { bytesToHex } from '@noble/hashes/utils';
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  newKeys, connectedRecord, loadKeys, withOffchainAlias, keepRetired, backupKeys, connectedBackup, linkMessage, publicKey, evmAddress,
  wordsOf, generateSecret,
} from './index.js';
import { deviceKey, toRest, fromRest } from './atrest.js';
import { loginSignature } from '../central/login.js';

vi.setConfig({ testTimeout: 120_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/alias-parity.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const [, b] = fx.vectors;
const PASS = 'correct horse battery';
const neuron = generateSecret(); // a Dockerized Neuron's alias
const NEURON = { hex: bytesToHex(neuron), address: evmAddress(publicKey(neuron)), pubkey: publicKey(neuron) };
const WALLET = hex(b.entropyHex);
/** The wallet in the app signs the link (the passphrase's wallet in main.js). */
const walletLink = (address) => {
  const message = linkMessage({ alias: address, wallet: b.ethAddress, issued: 1_700_000_000 });
  return { message, signature: loginSignature(WALLET, message) };
};

describe('withOffchainAlias: another alias for the Satori Service', () => {
  test('its private key or its 24 words, linked by the wallet; the app keeps its own alias and Nostr key', async () => {
    const r = await newKeys({ wallet: WALLET }, PASS);
    for (const text of [`0x${NEURON.hex}`, NEURON.hex, wordsOf(neuron)]) {
      const next = await withOffchainAlias(r, text, walletLink);
      expect(next).toEqual({ ...r, offchain: { alias: NEURON.hex, link: walletLink(NEURON.address) } });
      expect(await recoverMessageAddress({ message: next.offchain.link.message, signature: next.offchain.link.signature })).toBe(b.ethAddress);
      expect(next.offchain.link.message).toContain(`alias: ${NEURON.address}`);
    }
  });
  test('loadKeys: its signer logs in to the Satori Service; the alias, the Nostr key and the wallet are unchanged', async () => {
    const r = await newKeys({ wallet: WALLET }, PASS);
    const k = loadKeys(await withOffchainAlias(r, NEURON.hex, walletLink));
    expect(k.offchain.alias).toMatchObject({ pubkey: NEURON.pubkey, evmAddress: NEURON.address });
    expect(await verifyMessage({ address: NEURON.address, message: 'c-1', signature: k.offchain.alias.signCentralLogin('c-1') })).toBe(true);
    expect(k.offchain.link).toEqual(walletLink(NEURON.address));
    const own = loadKeys(r);
    expect([k.alias.evmAddress, k.nostr, k.wallet]).toEqual([own.alias.evmAddress, own.nostr, own.wallet]);
    expect(own.offchain).toBe(null);
  });
  test('nothing, or the app\'s own alias: back to one alias; and the one it had is kept as an earlier key', async () => {
    const r = await newKeys({ wallet: WALLET }, PASS);
    const two = await withOffchainAlias(r, NEURON.hex, walletLink);
    const own = loadKeys(r).alias.backup();
    for (const text of ['', null, own.privateKey, own.words]) {
      const one = await withOffchainAlias(two, text, walletLink);
      expect(one.offchain).toBeUndefined();
      expect(keepRetired(two, one, 5).retired).toEqual([{ alias: NEURON.hex, nostr: r.nostr, at: 5 }]);
    }
    await expect(withOffchainAlias(r, '', walletLink)).rejects.toThrow(/already uses its own alias/);
  });
  test('another import replaces it, and the one replaced is kept; the same one again is refused', async () => {
    const r = await newKeys({ wallet: WALLET }, PASS);
    const two = await withOffchainAlias(r, NEURON.hex, walletLink);
    const other = generateSecret();
    const three = await withOffchainAlias(two, bytesToHex(other), walletLink);
    expect(three.offchain.alias).toBe(bytesToHex(other));
    expect(keepRetired(two, three, 5).retired).toEqual([{ alias: NEURON.hex, nostr: r.nostr, at: 5 }]);
    expect(keepRetired(three, three)).toBe(three); // kept while in use: nothing retired
    await expect(withOffchainAlias(two, NEURON.hex, walletLink)).rejects.toThrow(/uses for the Satori Service now/);
  });
  test('the wallet\'s own key, or text that is no key, is refused', async () => {
    const r = await newKeys({ wallet: WALLET }, PASS);
    await expect(withOffchainAlias(r, b.entropyHex, walletLink)).rejects.toThrow(/wallet's own key/);
    await expect(withOffchainAlias(r, 'not a key', walletLink)).rejects.toThrow(/24 backup words or a private key/);
    const c = await connectedRecord({ address: b.ethAddress, rdns: 'io.metamask', name: 'MetaMask', signLink: async () => '0xsig' });
    await expect(withOffchainAlias(c, b.entropyHex, walletLink)).rejects.toThrow(/wallet's own key/);
  });
  test('a connected wallet: its wallet app signs the link', async () => {
    const c = await connectedRecord({ address: b.ethAddress, rdns: 'io.metamask', name: 'MetaMask', signLink: async () => '0xsig' });
    const link = vi.fn(async (address) => ({ message: `link ${address}`, signature: '0xok' }));
    const next = await withOffchainAlias(c, NEURON.hex, link);
    expect(link).toHaveBeenCalledWith(NEURON.address);
    expect(next.offchain).toEqual({ alias: NEURON.hex, link: { message: `link ${NEURON.address}`, signature: '0xok' } });
    expect(connectedBackup(next, 'offchain')).toEqual({ words: wordsOf(neuron), privateKey: `0x${NEURON.hex}` });
  });
  test('a broken one is refused at load', async () => {
    const r = await newKeys({ wallet: WALLET }, PASS);
    expect(() => loadKeys({ ...r, offchain: { alias: 'nope', link: walletLink(NEURON.address) } })).toThrow(/Satori Service/);
    expect(() => loadKeys({ ...r, offchain: { alias: NEURON.hex } })).toThrow(/Satori Service/);
  });
});

describe('kept like the other keys', () => {
  test('Backup shows it from the passphrase; null when there is none', async () => {
    const r = await newKeys({ wallet: WALLET }, PASS);
    expect(await backupKeys(r, 'offchain', PASS)).toBe(null);
    const two = await withOffchainAlias(r, NEURON.hex, walletLink);
    expect(await backupKeys(two, 'offchain', PASS)).toEqual({ words: wordsOf(neuron), privateKey: `0x${NEURON.hex}` });
    expect((await backupKeys(two, null, PASS)).offchain.privateKey).toBe(`0x${NEURON.hex}`);
  });
  test('sealed at rest with the alias and the Nostr key', async () => {
    const store = new Map();
    const key = await deviceKey({ get: async (k) => store.get(k), put: async (k, v) => store.set(k, v) });
    const two = await withOffchainAlias(await newKeys({ wallet: WALLET }, PASS), NEURON.hex, walletLink);
    const stored = await toRest(two, key);
    expect(JSON.stringify(stored)).not.toContain(NEURON.hex);
    expect(stored.offchain).toBeUndefined();
    expect(await fromRest(stored, key)).toEqual(two);
  });
});
