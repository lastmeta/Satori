// Central's login signature and the address central keys a peer by: protocol
// details, checked against satorilib's own output (identity-parity.json).
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loginSignature, verifyLoginSignature, centralAddress } from './login.js';

vi.setConfig({ testTimeout: 60_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const jsfx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-js.json', import.meta.url)));
const edges = JSON.parse(readFileSync(new URL('../../test/fixtures/satorilib-edges.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));

describe("central's login signature (satorilib's evrmore verify, central auth.py)", () => {
  for (const v of fx.vectors) {
    test(`verifies satorilib's signatures: ${v.label}`, () => {
      for (const s of v.signatures) {
        expect(verifyLoginSignature(s.message, s.signature, { pubkey: v.pubkey })).toBe(true);
        expect(verifyLoginSignature(s.message, s.signature, { address: v.address })).toBe(true);
        expect(verifyLoginSignature(s.message + '!', s.signature, { pubkey: v.pubkey })).toBe(false);
      }
    });
  }
  test('signatures satorilib verified are still what this code makes', () => {
    expect(jsfx.satorilibVerified?.signatures).toBe(true);
    for (const s of jsfx.signatures) {
      const v = fx.vectors.find((x) => x.address === s.address);
      expect(loginSignature(hex(v.entropyHex), s.message)).toBe(s.signature);
    }
  });
  test('a signature flagged uncompressed matches only the uncompressed key, as python-evrmorelib', () => {
    const u = edges.uncompressedSignature;
    for (const [field, expected] of Object.entries(u.verifies)) {
      const by = field.startsWith('pubkey') ? 'pubkey' : 'address';
      expect(verifyLoginSignature(u.message, u.signature, { [by]: u[field] }), field).toBe(expected);
    }
  });
  test('wrong key, wrong address and garbage fail', () => {
    const [a, b] = fx.vectors;
    const sig = loginSignature(hex(a.entropyHex), 'hello');
    expect(verifyLoginSignature('hello', sig, { pubkey: a.pubkey })).toBe(true);
    expect(verifyLoginSignature('hello', sig, { pubkey: b.pubkey })).toBe(false);
    expect(verifyLoginSignature('hello', sig, { address: b.address })).toBe(false);
    expect(verifyLoginSignature('hello', 'not base64!', { pubkey: a.pubkey })).toBe(false);
  });
});

test("centralAddress: the address central derives from a pubkey (satorilib's generateAddress)", () => {
  for (const v of fx.vectors) expect(centralAddress(v.pubkey)).toBe(v.address);
  expect(() => centralAddress('nope')).toThrow();
});
