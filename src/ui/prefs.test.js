// Per-device UI choices (src/ui/prefs.js): the Models tab's sort, kept as the theme is (localStorage, never required),
// and the sort menu's keys (a WAI-ARIA menu button: arrows move, Home/End, Escape closes and returns focus, Tab leaves).
import { describe, expect, test } from 'vitest';
import { readPref, writePref, menuKey, SORT_KEY, snapshotOf, readSnapshot, writeSnapshot, SNAPSHOT_KEY } from './prefs.js';

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

describe('the last visit\'s Home (docs/design/health.md#the-last-visit): painted at once on a revisit until live data arrives', () => {
  const health = {
    status: 'ok', tone: 'idle', title: 'Predicting', line: 'Sent 82 predictions 2 h ago · next in 9 h',
    action: { id: 'backup', text: 'Back up', button: 'Back up', do: 'backup' }, reasons: [{ id: 'backup' }], work: null,
    days: [{ date: '2026-10-19', code: 'full', ran: true, today: true }],
    channels: { network: { state: 'ok', tone: 'idle', text: '82 sent 2 h ago', lastTraffic: 1 }, contract: { state: 'idle', tone: 'off', text: 'Not staked' },
      relays: { state: 'idle', tone: 'off', text: 'No streams' } },
    feed: [{ at: 1, level: 'ok', text: 'Sent 82 predictions to the Satori Network' }],
  };
  const base = { claimable: { rewards: '0', drop: '3.6', airdrop: '0', total: '3.6' }, wallet: { satori: '100', staked: 'none', eth: '0.1' },
    alias: { batchesLeft: 40, eth: '0.1' }, lastBatch: { round: 1 } };
  test('small: what Home draws, without the card (its buttons need the neuron), the work or the traffic', () => {
    const snap = snapshotOf({ health, base, at: 1_800_000_000_000 });
    expect(snap).toEqual({ v: 1, at: 1_800_000_000_000,
      health: { status: 'ok', tone: 'idle', title: 'Predicting', line: health.line, days: health.days, feed: health.feed,
        channels: { network: { state: 'ok', tone: 'idle', text: '82 sent 2 h ago' }, contract: { state: 'idle', tone: 'off', text: 'Not staked' },
          relays: { state: 'idle', tone: 'off', text: 'No streams' } } },
      base: { claimable: base.claimable, wallet: { satori: '100', staked: 'none' }, alias: { batchesLeft: 40 } } });
    expect(JSON.stringify(snap).length).toBeLessThan(2000);
  });
  test('kept and read back; storage blocked, absent, or holding something else: none, nothing thrown', () => {
    const s = memory();
    expect(readSnapshot(s)).toBe(null);
    expect(writeSnapshot(snapshotOf({ health, base, at: 5 }), s)).toBe(true);
    expect(s.m.has(SNAPSHOT_KEY)).toBe(true);
    expect(readSnapshot(s)).toMatchObject({ v: 1, at: 5, health: { title: 'Predicting' } });
    for (const bad of ['{', '"x"', '{"v":2,"at":1,"health":{}}', '{"v":1,"at":1,"health":{"title":7}}', 'null']) {
      s.setItem(SNAPSHOT_KEY, bad);
      expect(readSnapshot(s), bad).toBe(null);
    }
    expect(readSnapshot(blocked)).toBe(null);
    expect(writeSnapshot(snapshotOf({ health, base, at: 5 }), blocked)).toBe(false);
    expect(readSnapshot(null)).toBe(null);
  });
  test('no base read yet: its part is left out', () => {
    expect(snapshotOf({ health, base: null, at: 1 }).base).toBe(null);
  });
});
