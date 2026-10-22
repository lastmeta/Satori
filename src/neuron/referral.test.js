import { describe, expect, test, vi } from 'vitest';
import { inviteLink, referrerOf, shareLink } from './referral.js';

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

describe('shareLink: the device\'s share sheet, else copied', () => {
  const clipboard = () => ({ writeText: vi.fn(async () => {}) });
  test('the share sheet when there is one', async () => {
    const nav = { share: vi.fn(async () => {}), clipboard: clipboard() };
    expect(await shareLink(A, nav)).toBe('shared');
    expect(nav.share).toHaveBeenCalledWith({ title: 'Satori neuron', url: A });
    expect(nav.clipboard.writeText).not.toHaveBeenCalled();
  });
  test('a sheet closed with no choice is not an error and copies nothing', async () => {
    const nav = { share: vi.fn(async () => { throw new DOMException('closed', 'AbortError'); }), clipboard: clipboard() };
    expect(await shareLink(A, nav)).toBe('cancelled');
    expect(nav.clipboard.writeText).not.toHaveBeenCalled();
  });
  test('no share sheet (a computer), or one that fails: copied', async () => {
    const plain = { clipboard: clipboard() };
    expect(await shareLink(A, plain)).toBe('copied');
    expect(plain.clipboard.writeText).toHaveBeenCalledWith(A);
    const broken = { share: vi.fn(async () => { throw new Error('NotAllowedError'); }), clipboard: clipboard() };
    expect(await shareLink(A, broken)).toBe('copied');
  });
  test('nothing to share with, or nowhere to copy: none', async () => {
    expect(await shareLink('', { clipboard: clipboard() })).toBeNull();
    expect(await shareLink(A, {})).toBeNull();
    expect(await shareLink(A, { clipboard: { writeText: async () => { throw new Error('denied'); } } })).toBeNull();
  });
});
