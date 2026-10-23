import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, sign } from 'viem/accounts';
import {
  generateSecret, secretFromWords, wordsOf, publicKey, evmAddress, signDigest, privateKeyHex,
} from './keys.js';

vi.setConfig({ testTimeout: 60_000 }); // shared box; noble builds tables on first use

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/alias-parity.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe('one secret: its words, public key and Base address, as satorilib makes them', () => {
  for (const v of fx.vectors) {
    test(v.label, () => {
      const s = hex(v.entropyHex);
      expect(wordsOf(s)).toBe(v.words);
      expect(secretFromWords(v.words)).toEqual(s);
      expect(publicKey(s)).toBe(v.pubkey);
      expect(evmAddress(v.pubkey)).toBe(v.ethAddress); // satorilib's ethAddress, Account.from_key(entropy)
      expect(evmAddress(publicKey(s))).toBe(privateKeyToAccount(`0x${v.entropyHex}`).address);
      expect(privateKeyHex(s)).toBe(`0x${v.entropyHex}`); // what a Base wallet's "Import account" takes
    });
  }
  test('words tolerate case and extra whitespace', () => {
    const v = fx.vectors[0];
    expect(secretFromWords(`  ${v.words.toUpperCase().replace(/ /g, '  \n')} `)).toEqual(hex(v.entropyHex));
  });
  test('rejects a bad checksum, 12 words, and words whose key is out of range', () => {
    const w = fx.vectors[0].words.split(' ');
    expect(() => secretFromWords([...w.slice(0, 23), w[0] === 'abandon' ? 'zoo' : 'abandon'].join(' '))).toThrow();
    expect(() => secretFromWords(w.slice(0, 12).join(' '))).toThrow();
    expect(() => secretFromWords(`${'abandon '.repeat(23)}art`)).toThrow(/range/); // valid words, key 0
  });
});

describe('keygen', () => {
  test('32 bytes in [1, n), 24 words round trip', () => {
    for (let i = 0; i < 10; i++) {
      const s = generateSecret();
      expect(s.length).toBe(32);
      const k = BigInt('0x' + Buffer.from(s).toString('hex'));
      expect(k > 0n && k < N).toBe(true);
      expect(wordsOf(s).split(' ')).toHaveLength(24);
      expect(secretFromWords(wordsOf(s))).toEqual(s);
    }
  });
  test('rejects out-of-range keys', () => {
    expect(() => publicKey(new Uint8Array(32))).toThrow();
    expect(() => wordsOf(hex(N.toString(16)))).toThrow();
    expect(() => publicKey(new Uint8Array(31).fill(1))).toThrow();
  });
});

describe('Base (EVM)', () => {
  test('an uncompressed or malformed public key', () => {
    const v = fx.vectors[0];
    expect(() => evmAddress('02' + '00'.repeat(32))).toThrow();
    expect(() => evmAddress('nope')).toThrow();
    expect(evmAddress(v.pubkey.toUpperCase())).toBe(v.ethAddress);
  });
  test('signDigest is viem\'s sign over the same 32 bytes (RFC 6979, low-S)', async () => {
    const v = fx.vectors[1];
    const hash = `0x${'ab'.repeat(32)}`;
    const ours = signDigest(hex(v.entropyHex), hex('ab'.repeat(32)));
    const theirs = await sign({ hash, privateKey: `0x${v.entropyHex}` });
    expect(ours).toEqual({ r: theirs.r, s: theirs.s, yParity: theirs.yParity, v: theirs.v });
    expect(() => signDigest(hex(v.entropyHex), new Uint8Array(31))).toThrow();
  });
});
