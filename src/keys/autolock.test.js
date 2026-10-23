// The wallet locks on its own (docs/design/keys.md#the-wallet-locks-on-its-own): 5 minutes after the last interaction
// while it is open, never in the middle of a wallet action, and at once on a wake past the deadline. Fake timers.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAutoLock, IDLE_MS } from './autolock.js';

let locks;
let busy;
let lockAt;
let auto;
beforeEach(() => {
  vi.useFakeTimers();
  locks = 0;
  busy = false;
  lockAt = undefined;
  auto = createAutoLock({ onLock: () => { locks++; }, busy: () => busy, onChange: (at) => { lockAt = at; } });
});
afterEach(() => vi.useRealTimers());

describe('createAutoLock', () => {
  test('5 minutes', () => {
    expect(IDLE_MS).toBe(5 * 60_000);
  });

  test('locks 5 minutes after it was opened, with no interaction', () => {
    auto.start();
    expect(lockAt).toBe(Date.now() + IDLE_MS);
    expect(auto.lockAt).toBe(lockAt);
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(locks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(locks).toBe(1);
    expect(auto.lockAt).toBe(null);
    expect(lockAt).toBe(null);
  });

  test('each interaction starts the 5 minutes again', () => {
    auto.start();
    vi.advanceTimersByTime(4 * 60_000);
    auto.touch();
    expect(lockAt).toBe(Date.now() + IDLE_MS);
    vi.advanceTimersByTime(4 * 60_000);
    expect(locks).toBe(0);
    auto.touch();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(locks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(locks).toBe(1);
  });

  test('an interaction while nothing is open starts nothing', () => {
    auto.touch();
    expect(auto.lockAt).toBe(null);
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(locks).toBe(0);
  });

  test('locked by hand: nothing left to time', () => {
    auto.start();
    auto.stop();
    expect(lockAt).toBe(null);
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(locks).toBe(0);
  });

  test('never in the middle of a wallet action: it locks once the action ends', () => {
    auto.start();
    busy = true; // a Stake's three transactions, say
    vi.advanceTimersByTime(IDLE_MS + 30_000);
    expect(locks).toBe(0);
    busy = false;
    vi.advanceTimersByTime(5_000);
    expect(locks).toBe(1);
  });

  test('a device that slept past the deadline (its timer late) locks at the first check after it wakes', () => {
    auto.start();
    // the clock jumps 20 minutes and the timer has not fired yet (browser timers don't count sleep)
    vi.setSystemTime(Date.now() + 20 * 60_000);
    auto.check();
    expect(locks).toBe(1);
    auto.check(); // nothing open now
    expect(locks).toBe(1);
  });

  test('check() before the deadline does nothing', () => {
    auto.start();
    vi.setSystemTime(Date.now() + 60_000);
    auto.check();
    expect(locks).toBe(0);
    expect(auto.lockAt).not.toBe(null);
  });

  test('opened again after a lock: another 5 minutes', () => {
    auto.start();
    vi.advanceTimersByTime(IDLE_MS);
    auto.start();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(locks).toBe(1);
    vi.advanceTimersByTime(1);
    expect(locks).toBe(2);
  });
});
