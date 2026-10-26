import { describe, expect, test } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { keysFromWallet, keysFromWords, keysFromSignature, keysText, aliasPath, nostrPath } from './derive.js';
import { generateSecret, secretFromWords, wordsOf } from './keys.js';

describe('derived keys', () => {
  test('the Nostr key is NIP-06 (its test vectors)', () => {
    expect(keysFromWords('leader monkey parrot ring guide accident before fence cannon height naive bean').nostr)
      .toBe('7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a');
    expect(keysFromWords('what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade').nostr)
      .toBe('c15d739894c81a2fcfd3a2df85a0d2c0dbc47a280d092799f144d73d7ae78add');
  });

  test('the paths: the alias fully hardened, the Nostr key NIP-06; another index another key', () => {
    expect([aliasPath(), nostrPath(), aliasPath(2)]).toEqual(["m/44'/60'/1'/0'/0'", "m/44'/1237'/0'/0/0", "m/44'/60'/1'/0'/2'"]);
    const w = generateSecret();
    const [a, b] = [keysFromWallet(w), keysFromWallet(w, 1)];
    expect(bytesToHex(a.alias)).not.toBe(bytesToHex(b.alias));
    expect(a.nostr).not.toBe(b.nostr);
  });

  test('a wallet in the app: the same from its words or its key, on any device; never the wallet itself', () => {
    const w = generateSecret();
    const a = keysFromWallet(w);
    const again = keysFromWallet(secretFromWords(wordsOf(w)));
    expect([bytesToHex(again.alias), again.nostr]).toEqual([bytesToHex(a.alias), a.nostr]);
    expect(a.alias).toHaveLength(32);
    expect(bytesToHex(a.alias)).not.toBe(bytesToHex(w));
    expect(a.nostr).not.toBe(bytesToHex(a.alias));
  });

  test('a connected wallet: its signature of the fixed text; the same signature the same keys; not 65 bytes, none', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const text = keysText(account.address);
    expect(text).toBe(`Satori: make this app's keys\nwallet: ${account.address}`);
    const [s1, s2] = [await account.signMessage({ message: text }), await account.signMessage({ message: text })];
    expect(s1).toBe(s2); // RFC 6979
    const k = keysFromSignature(s1);
    expect(bytesToHex(keysFromSignature(s2).alias)).toBe(bytesToHex(k.alias));
    expect(k.nostr).toMatch(/^[0-9a-f]{64}$/);
    expect(keysFromSignature(`0x${'ab'.repeat(100)}`)).toBe(null);
  });
});
