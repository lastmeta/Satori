import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  generateEntropy, deriveKeys, publicKeys, entropyFromWords, signMessage, verifyMessage, createVault, unlock,
} from './index.js';
import { seal, unseal, ITERATIONS } from './seal.js';

vi.setConfig({ testTimeout: 60_000 }); // shared box; noble builds tables on first use

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const jsfx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-js.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const fast = { iterations: 1000 };

describe('derivations match satorilib (Docker neuron)', () => {
  for (const v of fx.vectors) {
    test(v.label, () => {
      expect(deriveKeys(hex(v.entropyHex))).toEqual({ words: v.words, pubkey: v.pubkey, address: v.address });
      expect(publicKeys(hex(v.entropyHex))).toEqual({ pubkey: v.pubkey, address: v.address });
      expect(entropyFromWords(v.words)).toEqual(hex(v.entropyHex));
    });
  }
  test('words tolerate case and extra whitespace', () => {
    const v = fx.vectors[0];
    expect(entropyFromWords(`  ${v.words.toUpperCase().replace(/ /g, '  \n')} `)).toEqual(hex(v.entropyHex));
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
  test('wrong key, wrong address and garbage fail', () => {
    const [a, b] = fx.vectors;
    const sig = signMessage(hex(a.entropyHex), 'hello');
    expect(verifyMessage('hello', sig, { address: a.address })).toBe(true);
    expect(verifyMessage('hello', sig, { pubkey: b.pubkey })).toBe(false);
    expect(verifyMessage('hello', sig, { address: b.address })).toBe(false);
    expect(verifyMessage('hello', 'not base64!', { address: a.address })).toBe(false);
  });
});

describe('seal (PBKDF2-SHA256 → AES-256-GCM)', () => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  test('default record is JSON with its parameters', async () => {
    const rec = await seal(secret, 'correct horse');
    expect(ITERATIONS).toBe(600_000);
    expect(rec).toMatchObject({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 600_000, cipher: 'AES-256-GCM' });
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
    expect(await unseal(rec, 'correct horse')).toEqual(secret);
  });
  test('wrong passphrase throws; fresh salt and iv each time', async () => {
    const a = await seal(secret, 'p', fast);
    const b = await seal(secret, 'p', fast);
    await expect(unseal(a, 'q')).rejects.toThrow(/wrong passphrase/i);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe('unlock / lock', () => {
  const v = fx.vectors[0];
  test('unlock gives address and signing; words need the passphrase again', async () => {
    const vault = await createVault(hex(v.entropyHex), 'pw', fast);
    await expect(unlock(vault, 'nope')).rejects.toThrow(/wrong passphrase/i);
    const id = await unlock(vault, 'pw');
    expect(id.address).toBe(v.address);
    expect(verifyMessage('m', id.sign('m'), { address: v.address })).toBe(true);
    await expect(id.words('nope')).rejects.toThrow(/wrong passphrase/i);
    expect(await id.words('pw')).toBe(v.words);
  });
  test('lock wipes the secret: signing then throws', async () => {
    const id = await unlock(await createVault(hex(v.entropyHex), 'pw', fast), 'pw');
    expect(id.locked).toBe(false);
    id.lock();
    expect(id.locked).toBe(true);
    expect(() => id.sign('m')).toThrow(/locked/i);
    await expect(id.words('pw')).rejects.toThrow(/locked/i);
  });
  test('Lock during the words unseal: the words are not returned', async () => {
    const id = await unlock(await createVault(hex(v.entropyHex), 'pw', fast), 'pw');
    const pending = id.words('pw');
    id.lock();
    await expect(pending).rejects.toThrow(/locked/i);
  });
});
