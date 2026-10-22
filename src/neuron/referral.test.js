import { describe, expect, test } from 'vitest';
import { inviteLink, referrerOf } from './referral.js';

const A = '0x' + 'ab'.repeat(20);

describe('referrerOf: the ?ref= of a URL', () => {
  test('an address, as written (checksummed or not)', () => {
    expect(referrerOf(`?ref=${A}`)).toBe(A);
    expect(referrerOf(`?tab=wallet&ref=${A}`)).toBe(A);
    expect(referrerOf('?ref=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  });
  test('anything else is none: no ref, a short one, not hex, the zero address, a wrong checksum', () => {
    for (const s of ['', '?', '?ref=', '?ref=0x1234', `?ref=${A}00`, '?ref=' + 'z'.repeat(42), `?ref=0x${'0'.repeat(40)}`,
      '?ref=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd']) {
      expect(referrerOf(s), s).toBeNull();
    }
  });
  test('only the first ref counts', () => {
    expect(referrerOf(`?ref=${A}&ref=0x${'cd'.repeat(20)}`)).toBe(A);
  });
});

describe('inviteLink', () => {
  test('the origin and the vault, as the dapp writes it', () => {
    expect(inviteLink('https://neuron.satorinet.io', A)).toBe(`https://neuron.satorinet.io/?ref=${A}`);
    expect(inviteLink('http://localhost:5173', A)).toBe(`http://localhost:5173/?ref=${A}`);
  });
  test('none without an origin or a vault', () => {
    expect(inviteLink('', A)).toBe('');
    expect(inviteLink('https://x.io', '')).toBe('');
  });
});
