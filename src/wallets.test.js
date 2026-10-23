import { describe, expect, test } from 'vitest';
import { activeOf, pathOf, withAdded, withAddress, withActive, withoutWallet, walletsView, FIRST_FILE, ALREADY } from './wallets.js';

const A = '0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7';
const B = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';

describe('the wallets list (docs/design/wallets.md#several-wallets)', () => {
  test('no list: one wallet in the first file', () => {
    expect(activeOf(null)).toEqual({ id: 1, file: FIRST_FILE, address: null });
    expect(pathOf(activeOf(null))).toBe('opfs://satori-mvp.duckdb');
    expect(walletsView(null, A)).toEqual({ active: 1, wallets: [{ id: 1, address: A, active: true }] });
  });

  test('Add: the first wallet kept with its address, a new one active in a file of its own; ids go on from the highest', () => {
    const one = withAdded(null, A);
    expect(one).toEqual({ v: 1, active: 2, wallets: [{ id: 1, file: FIRST_FILE, address: A }, { id: 2, file: 'satori-2.duckdb', address: null }] });
    expect(pathOf(activeOf(one))).toBe('opfs://satori-2.duckdb');
    const two = withAdded(withoutWallet(withActive(withAdded(one), 1), 3).list);
    expect(two.wallets.map((w) => [w.id, w.file])).toEqual([[1, FIRST_FILE], [2, 'satori-2.duckdb'], [3, 'satori-3.duckdb']]);
  });

  test('the active wallet\'s address, set after its setup; one already in the list is refused, in any letter case', () => {
    const l = withAddress(withAdded(null, A), B);
    expect(activeOf(l)).toMatchObject({ id: 2, address: B });
    expect(() => withAddress(withAdded(null, A), A.toLowerCase())).toThrow(ALREADY);
    expect(withAddress(l, B).wallets).toEqual(l.wallets); // its own address again: fine
  });

  test('Switch: only to a wallet in the list', () => {
    const l = withAddress(withAdded(null, A), B);
    expect(withActive(l, 1).active).toBe(1);
    expect(() => withActive(l, 9)).toThrow('No wallet 9 in this app.');
  });

  test('Remove: never the wallet in use; another goes with its file named', () => {
    const l = withAddress(withAdded(null, A), B);
    expect(() => withoutWallet(l, 2)).toThrow(/switch to another first/);
    expect(withoutWallet(l, 1)).toEqual({ list: { v: 1, active: 2, wallets: [{ id: 2, file: 'satori-2.duckdb', address: B }] }, file: FIRST_FILE });
    expect(() => withoutWallet(l, 7)).toThrow('No wallet 7 in this app.');
  });

  test('nothing given is changed', () => {
    const l = withAdded(null, A);
    const before = JSON.stringify(l);
    withAddress(l, B);
    withActive(l, 1);
    withoutWallet(l, 1);
    withAdded(l);
    expect(JSON.stringify(l)).toBe(before);
  });
});
