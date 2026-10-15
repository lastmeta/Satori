import { describe, expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 }); // the shared box can be slow; noble builds tables on first use
import { readFileSync } from 'node:fs';
import {
  generateEntropy, deriveKeys, entropyFromWords, entropyFromWif,
  signMessage, verifyMessage, nostrKeys, generateNostrSecret, evmAccount,
} from './keys.js';

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const jsfx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-js.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe('derivations match satorilib', () => {
  for (const v of fx.vectors) {
    test(v.label, () => {
      const k = deriveKeys(hex(v.entropyHex));
      expect(k).toEqual({
        entropy: v.entropy, words: v.words, wif: v.wif, pubkey: v.pubkey,
        address: v.address, scripthash: v.scripthash, ethAddress: v.ethAddress,
      });
      expect(evmAccount(hex(v.entropyHex)).address).toBe(v.ethAddress);
    });
  }
});

describe('restore', () => {
  test('words → entropy (mnemonicToEntropy, not seed)', () => {
    for (const v of fx.vectors) expect(entropyFromWords(v.words)).toEqual(hex(v.entropyHex));
  });
  test('words tolerate case and extra whitespace', () => {
    const v = fx.vectors[0];
    expect(entropyFromWords(`  ${v.words.toUpperCase().replace(/ /g, '  \n')} `)).toEqual(hex(v.entropyHex));
  });
  test('rejects bad checksum and 12 words', () => {
    const w = fx.vectors[0].words.split(' ');
    expect(() => entropyFromWords([...w.slice(0, 23), w[0] === 'abandon' ? 'zoo' : 'abandon'].join(' '))).toThrow();
    expect(() => entropyFromWords(w.slice(0, 12).join(' '))).toThrow();
  });
  test('WIF → entropy', () => {
    for (const v of fx.vectors) expect(entropyFromWif(v.wif)).toEqual(hex(v.entropyHex));
  });
  test('rejects uncompressed-flag-less or wrong-version WIF', () => {
    expect(() => entropyFromWif('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ')).toThrow();
    expect(() => entropyFromWif(fx.vectors[0].wif.slice(0, -1) + 'x')).toThrow();
  });
});

describe('keygen', () => {
  test('32 bytes in [1, n)', () => {
    for (let i = 0; i < 20; i++) {
      const e = generateEntropy();
      expect(e).toBeInstanceOf(Uint8Array);
      expect(e.length).toBe(32);
      const k = BigInt('0x' + Buffer.from(e).toString('hex'));
      expect(k > 0n && k < N).toBe(true);
    }
  });
  test('deriveKeys rejects out-of-range keys', () => {
    expect(() => deriveKeys(new Uint8Array(32))).toThrow();
    expect(() => deriveKeys(hex(N.toString(16)))).toThrow();
    expect(() => deriveKeys(new Uint8Array(31).fill(1))).toThrow();
  });
});

describe('Evrmore message signing (cross-verified, never byte-compared to Python)', () => {
  for (const v of fx.vectors) {
    test(`JS verifies satorilib signatures: ${v.label}`, () => {
      for (const s of v.signatures) {
        expect(verifyMessage(s.message, s.signature, { pubkey: v.pubkey })).toBe(true);
        expect(verifyMessage(s.message, s.signature, { address: v.address })).toBe(true);
        expect(verifyMessage(s.message + '!', s.signature, { pubkey: v.pubkey })).toBe(false);
      }
    });
  }
  test('JS signature verifies in JS, wrong key/address fails', () => {
    const [a, b] = fx.vectors;
    const sig = signMessage(hex(a.entropyHex), 'hello');
    expect(atob(sig).length).toBe(65);
    expect(atob(sig).charCodeAt(0)).toBeGreaterThanOrEqual(31); // compressed
    expect(verifyMessage('hello', sig, { address: a.address })).toBe(true);
    expect(verifyMessage('hello', sig, { pubkey: b.pubkey })).toBe(false);
    expect(verifyMessage('hello', sig, { address: b.address })).toBe(false);
    expect(verifyMessage('hello', 'not base64!', { address: a.address })).toBe(false);
  });
  test('JS signatures that satorilib verified are still what JS produces', () => {
    expect(jsfx.satorilibVerified?.signatures).toBe(true);
    for (const s of jsfx.signatures) {
      const v = fx.vectors.find((x) => x.address === s.address);
      expect(signMessage(hex(v.entropyHex), s.message)).toBe(s.signature);
    }
  });
});

describe('Nostr key', () => {
  test('pubkey matches nostr_sdk', () => {
    expect(nostrKeys(fx.nostr.secretHex)).toEqual({ secretHex: fx.nostr.secretHex, pubkeyHex: fx.nostr.pubkeyHex });
  });
  test('generated secret is 64 hex and independent', () => {
    const s = generateNostrSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(nostrKeys(s).pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});
