// Sub-wallets (docs/design/wallets.md#sub-wallets): words from Satori's mobile app or Satori GO hold more keys than the
// one Import made; the record keeps the words sealed and the Evrmore account's xpub in clear, and a switch makes the
// wallet one of them, as Import of that key would.
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils';
import { evrmoreAddress, subWallets, secretAt, sealWords, rowAt, MORE } from './hd.js';
import { newKeys, withSubWallet, loadKeys, unlockWallet, evmAddress, keyFromText, NO_SUB_WALLETS } from './index.js';
import { keysFromWallet } from './derive.js';
import { deviceKey, toRest, fromRest } from './atrest.js';
import { createSession } from '../session.js';

vi.setConfig({ testTimeout: 180_000 }); // the passphrase's PBKDF2, twice per record, on a shared box

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/alias-parity.json', import.meta.url)));
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // BIP-39's test words
const PASS = 'correct horse battery';
const at = (path) => HDKey.fromMasterSeed(mnemonicToSeedSync(WORDS)).derive(path);
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));

describe('an Evrmore address, and the rows from the xpub', () => {
  test("a real key's Evrmore address (P2PKH, version 33) and Base address", () => {
    const pubkey = '028b7a46c3339c02698944ac75a8f243379e85ac5db57a362b8d4953f4ac7dd74f';
    expect(evrmoreAddress(pubkey)).toBe('ESLzcaPXWNn4DvUe5ths7Tqq1f3yh3yuKf');
    expect(evmAddress(pubkey)).toBe('0xb2E152fBbeEAD1E093D512B50BE64aFdB2C4680c');
  });

  test("12 words: the import's own key first, then receive and change alternating, each the key its path gives", async () => {
    const hd = await sealWords(WORDS, PASS);
    expect(hd).toMatchObject({ words: 12, at: null, count: MORE, first: bytesToHex(at("m/44'/60'/0'/0/0").publicKey),
      xpub: at("m/44'/175'/0'").publicExtendedKey, kdf: { name: 'PBKDF2' }, cipher: { name: 'AES-GCM' } });
    expect(JSON.stringify(hd)).not.toContain('abandon');
    const { rows } = subWallets(hd);
    expect(rows).toHaveLength(1 + 2 * MORE);
    expect(rows.slice(0, 5).map((r) => [r.n, r.kind, r.index, r.path, r.inUse])).toEqual([
      [0, 'import', null, "m/44'/60'/0'/0/0", true],
      [1, 'receive', 0, "m/44'/175'/0'/0/0", false],
      [2, 'change', 0, "m/44'/175'/0'/1/0", false],
      [3, 'receive', 1, "m/44'/175'/0'/0/1", false],
      [4, 'change', 1, "m/44'/175'/0'/1/1", false],
    ]);
    expect(rows.at(-1)).toMatchObject({ n: 20, kind: 'change', index: 9, path: "m/44'/175'/0'/1/9" });
    for (const r of rows.slice(0, 4)) { // the xpub's public keys are the words' own, at each path
      const pub = bytesToHex(at(r.path).publicKey);
      expect([r.evrmore, r.address]).toEqual([evrmoreAddress(pub), evmAddress(pub)]);
    }
    for (const n of [0, 2, 3]) { // the passphrase opens the words: the row's private key
      const s = await secretAt(hd, n, PASS);
      expect(bytesToHex(s)).toBe(bytesToHex(at(rows[n].path).privateKey));
    }
    await expect(secretAt(hd, 2, 'not the passphrase')).rejects.toThrow('Wrong passphrase');
    expect(() => rowAt(hd, 21)).toThrow('No sub-wallet 21: rows 0 to 20.');
    expect(subWallets({ ...hd, count: 20 }).rows).toHaveLength(41); // Derive 20 more
    expect(subWallets(null)).toBe(null);
  });

  test("24 words: the words' own key first, with no path", async () => {
    const v = fx.vectors[1];
    const hd = await sealWords(v.words, PASS);
    expect([hd.words, hd.first]).toEqual([24, v.pubkey]);
    expect(subWallets(hd).rows[0]).toMatchObject({ kind: 'import', path: null, address: v.ethAddress, inUse: true });
    expect(bytesToHex(await secretAt(hd, 0, PASS))).toBe(v.entropyHex);
  });
});

describe('the record', () => {
  test('Import of words keeps them for the sub-wallets; a private key, a WIF or a new wallet does not', async () => {
    const twelve = keyFromText('Test, test test test test test test test test test test junk.');
    expect(twelve.words).toBe('test test test test test test test test test test test junk');
    const r = await newKeys({ wallet: twelve.secret, words: twelve.words }, PASS);
    expect(evmAddress(r.hd.first)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'); // MetaMask's first account: the wallet
    expect(r.hd.first).toBe(r.wallet.pubkey);
    const v = fx.vectors[0];
    const words24 = keyFromText(v.words.toUpperCase());
    expect(words24.words).toBe(v.words);
    expect((await newKeys({ wallet: words24.secret, words: words24.words }, PASS)).hd).toMatchObject({ words: 24, first: v.pubkey });
    for (const text of [`0x${v.entropyHex}`, 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn']) { // a private key, a WIF
      const key = keyFromText(text);
      expect(key.words).toBe(null);
      expect((await newKeys({ wallet: key.secret, words: key.words }, PASS)).hd).toBeUndefined();
    }
    await expect(newKeys({ wallet: hex(fx.vectors[1].entropyHex), words: twelve.words }, PASS)).rejects.toThrow("These words are not the wallet's.");
  });

  test('a well-formed hd is read; a malformed one refused; at rest it passes as it is', async () => {
    const { secret, words } = keyFromText(WORDS);
    const r = await newKeys({ wallet: secret, words }, PASS);
    expect(() => loadKeys(r)).not.toThrow();
    expect(() => loadKeys({ ...r, hd: { ...r.hd, at: { change: 1, index: 9 } } })).not.toThrow();
    for (const bad of [{ xpub: 'xpub' }, { first: 'zz' }, { at: { change: 2, index: 0 } }, { at: { change: 0, index: 10 } }, { at: undefined },
      { count: 3 }, { words: 15 }, { data: null }]) {
      expect(() => loadKeys({ ...r, hd: { ...r.hd, ...bad } }), JSON.stringify(bad)).toThrow('The stored sub-wallets are not readable.');
    }
    const key = await deviceKey((() => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); } }; })());
    const stored = await toRest(r, key);
    expect(stored.hd).toEqual(r.hd);
    expect(await fromRest(stored, key)).toEqual(r);
  });

  test('a switch: the wallet becomes the row\'s key, as Import of it would; the old keys kept; created and hd kept', async () => {
    const { secret, words } = keyFromText(WORDS);
    const r = await newKeys({ wallet: secret, words }, PASS);
    const imported = { ...r, created: 1_790_000_000, offchain: { alias: 'aa'.repeat(32), link: { message: 'm', signature: 's' } },
      onchain: { alias: 'bb'.repeat(32), link: { message: 'm', signature: 's' } } };
    await expect(withSubWallet(imported, 2, 'not the passphrase')).rejects.toThrow('Wrong passphrase');
    await expect(withSubWallet(imported, 0, PASS)).rejects.toThrow('That key is the one in use.');
    await expect(withSubWallet(imported, 2)).rejects.toThrow("The wallet's passphrase is needed");
    await expect(withSubWallet(imported, 99, PASS)).rejects.toThrow('No sub-wallet 99');
    const next = await withSubWallet(imported, 2, PASS); // Change 0
    const change0 = at("m/44'/175'/0'/1/0");
    expect(next.wallet.pubkey).toBe(bytesToHex(change0.publicKey));
    const derived = keysFromWallet(change0.privateKey);
    expect([next.alias, next.nostr, next.from]).toEqual([bytesToHex(derived.alias), derived.nostr, 'wallet']);
    expect(next.link.message).toContain(`wallet: ${evmAddress(next.wallet.pubkey)}`);
    expect(next.created).toBe(1_790_000_000);
    expect(next.hd).toEqual({ ...r.hd, at: { change: 1, index: 0 } });
    expect([next.offchain, next.onchain]).toEqual([undefined, undefined]); // their links were the old wallet's
    expect((await unlockWallet(next, PASS)).wallet.pubkey).toBe(next.wallet.pubkey); // sealed with the same passphrase
    expect(subWallets(next.hd).rows.filter((x) => x.inUse).map((x) => x.n)).toEqual([2]);

    // saved: every key it replaced is kept (the alias and Nostr key, and each job's alias)
    const m = new Map();
    const db = { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, checkpoint: async () => {} };
    const s = createSession({ db, restKey: async () => null });
    await s.save(imported);
    await s.save(next);
    expect(s.walletPublic.evmAddress).toBe(evmAddress(bytesToHex(change0.publicKey)));
    expect(s.record.retired.map((k) => k.alias).sort()).toEqual([r.alias, 'aa'.repeat(32), 'bb'.repeat(32)].sort());
    expect(s.record.retired.every((k) => k.nostr === r.nostr)).toBe(true);

    // and back to the import's own key
    const back = await withSubWallet(next, 0, PASS);
    expect([back.wallet.pubkey, back.alias, back.hd.at]).toEqual([r.wallet.pubkey, r.alias, null]);
    await expect(withSubWallet({ ...r, hd: undefined }, 1, PASS)).rejects.toThrow(NO_SUB_WALLETS);
  });
});
