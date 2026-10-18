// Per-device UI choices (src/ui/prefs.js): the Models tab's sort, kept as the theme is (localStorage, never required),
// and the sort menu's keys (a WAI-ARIA menu button: arrows move, Home/End, Escape closes and returns focus, Tab leaves).
import { describe, expect, test } from 'vitest';
import { readPref, writePref, menuKey, SORT_KEY } from './prefs.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };

describe('readPref / writePref: this device\'s choice, or the default', () => {
  test('kept and read back; an unknown or missing value is the default', () => {
    const s = memory();
    expect(readPref(SORT_KEY, ['quality', 'name'], 'quality', s)).toBe('quality');
    expect(writePref(SORT_KEY, 'name', s)).toBe(true);
    expect(s.m.get('satori-models-sort')).toBe('name');
    expect(readPref(SORT_KEY, ['quality', 'name'], 'quality', s)).toBe('name');
    s.setItem(SORT_KEY, 'size');
    expect(readPref(SORT_KEY, ['quality', 'name'], 'quality', s)).toBe('quality');
  });
  test('storage blocked or absent: the default, nothing thrown', () => {
    expect(readPref(SORT_KEY, ['quality', 'name'], 'quality', blocked)).toBe('quality');
    expect(writePref(SORT_KEY, 'name', blocked)).toBe(false);
    expect(readPref(SORT_KEY, ['quality', 'name'], 'quality', null)).toBe('quality');
    expect(writePref(SORT_KEY, 'name', null)).toBe(false);
  });
});

describe('menuKey: the sort menu by keyboard', () => {
  test('arrows move (wrapping), Home and End; Escape closes back to the button; Tab closes and moves on; others: nothing', () => {
    expect(menuKey('ArrowDown', 0, 2)).toEqual({ focus: 1 });
    expect(menuKey('ArrowDown', 1, 2)).toEqual({ focus: 0 });
    expect(menuKey('ArrowUp', 0, 2)).toEqual({ focus: 1 });
    expect(menuKey('Home', 1, 2)).toEqual({ focus: 0 });
    expect(menuKey('End', 0, 2)).toEqual({ focus: 1 });
    expect(menuKey('Escape', 1, 2)).toEqual({ close: true, restore: true });
    expect(menuKey('Tab', 1, 2)).toEqual({ close: true, restore: false });
    expect(menuKey('a', 0, 2)).toBeNull();
  });
});
