import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  generateEntropy, deriveKeys, publicKeys, entropyFromWords, entropyFromWif, signMessage, verifyMessage,
} from './keys.js';

vi.setConfig({ testTimeout: 60_000 }); // shared box; noble builds tables on first use

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const jsfx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-js.json', import.meta.url)));
const edges = JSON.parse(readFileSync(new URL('../../test/fixtures/satorilib-edges.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe('derivations match satorilib (Docker neuron)', () => {
  for (const v of fx.vectors) {
    test(v.label, () => {
      expect(deriveKeys(hex(v.entropyHex))).toEqual({
        entropy: v.entropy, words: v.words, wif: v.wif, pubkey: v.pubkey, address: v.address, scripthash: v.scripthash,
      });
      expect(publicKeys(hex(v.entropyHex))).toEqual({ pubkey: v.pubkey, address: v.address });
      expect(entropyFromWords(v.words)).toEqual(hex(v.entropyHex));
      expect(entropyFromWif(v.wif)).toEqual(hex(v.entropyHex));
    });
  }
  test('words tolerate case and extra whitespace', () => {
    const v = fx.vectors[0];
    expect(entropyFromWords(`  ${v.words.toUpperCase().replace(/ /g, '  \n')} `)).toEqual(hex(v.entropyHex));
  });
  test('rejects a WIF with a bad checksum or no compression flag', () => {
    const w = fx.vectors[0].wif;
    expect(() => entropyFromWif(w.slice(0, -1) + (w.endsWith('1') ? '2' : '1'))).toThrow();
    expect(() => entropyFromWif('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ')).toThrow(/compressed/);
  });
  test('rejects a bad checksum and 12 words', () => {
    const w = fx.vectors[0].words.split(' ');
    expect(() => entropyFromWords([...w.slice(0, 23), w[0] === 'abandon' ? 'zoo' : 'abandon'].join(' '))).toThrow();
    expect(() => entropyFromWords(w.slice(0, 12).join(' '))).toThrow();
  });
});

describe('keygen', () => {
  test('32 bytes in [1, n), 24 words round trip', () => {
    for (let i = 0; i < 10; i++) {
      const e = generateEntropy();
      expect(e.length).toBe(32);
      const k = BigInt('0x' + Buffer.from(e).toString('hex'));
      expect(k > 0n && k < N).toBe(true);
      const { words } = deriveKeys(e);
      expect(words.split(' ')).toHaveLength(24);
      expect(entropyFromWords(words)).toEqual(e);
    }
  });
  test('rejects out-of-range keys', () => {
    expect(() => deriveKeys(new Uint8Array(32))).toThrow();
    expect(() => deriveKeys(hex(N.toString(16)))).toThrow();
    expect(() => deriveKeys(new Uint8Array(31).fill(1))).toThrow();
  });
});

describe('Evrmore message signing', () => {
  for (const v of fx.vectors) {
    test(`verifies satorilib signatures: ${v.label}`, () => {
      for (const s of v.signatures) {
        expect(verifyMessage(s.message, s.signature, { pubkey: v.pubkey })).toBe(true);
        expect(verifyMessage(s.message, s.signature, { address: v.address })).toBe(true);
        expect(verifyMessage(s.message + '!', s.signature, { pubkey: v.pubkey })).toBe(false);
      }
    });
  }
  test('JS signatures that satorilib verified are still what JS produces', () => {
    expect(jsfx.satorilibVerified?.signatures).toBe(true);
    for (const s of jsfx.signatures) {
      const v = fx.vectors.find((x) => x.address === s.address);
      expect(signMessage(hex(v.entropyHex), s.message)).toBe(s.signature);
    }
  });
  test('a signature flagged uncompressed matches only the uncompressed key, as python-evrmorelib', () => {
    const u = edges.uncompressedSignature;
    for (const [field, expected] of Object.entries(u.verifies)) {
      const by = field.startsWith('pubkey') ? 'pubkey' : 'address';
      expect(verifyMessage(u.message, u.signature, { [by]: u[field] }), field).toBe(expected);
    }
  });
  test('wrong key, wrong address and garbage fail', () => {
    const [a, b] = fx.vectors;
    const sig = signMessage(hex(a.entropyHex), 'hello');
    expect(verifyMessage('hello', sig, { address: a.address })).toBe(true);
    expect(verifyMessage('hello', sig, { pubkey: b.pubkey })).toBe(false);
    expect(verifyMessage('hello', sig, { address: b.address })).toBe(false);
    expect(verifyMessage('hello', 'not base64!', { address: a.address })).toBe(false);
  });
});
