// The hero's pace (docs/design/health.md#work): each step stays long enough to read, counts tick at once, the end waits
// a moment, and nothing piles up. Fake timers.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHold, HOLD_MS, GRACE_MS } from './hold.js';

const step = (key, line = key) => ({ key, working: true, line });
const idle = (line = 'idle') => ({ key: 'idle', working: false, line });

let shown;
let set;
beforeEach(() => {
  vi.useFakeTimers();
  shown = [];
  set = createHold({ show: (v) => shown.push(v.line), now: () => Date.now() });
});
afterEach(() => vi.useRealTimers());

describe('createHold', () => {
  test('the first view, and idle to work, show at once', () => {
    set(idle('Starting'));
    set(step('register'));
    expect(shown).toEqual(['Starting', 'register']);
  });

  test(`a step stays at least ${HOLD_MS} ms before the next replaces it`, () => {
    set(step('register'));
    vi.advanceTimersByTime(200);
    set(step('observations'));
    expect(shown).toEqual(['register']);
    vi.advanceTimersByTime(HOLD_MS - 201);
    expect(shown).toEqual(['register']);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(['register', 'observations']);
  });

  test('a step shown long enough is replaced at once', () => {
    set(step('history'));
    vi.advanceTimersByTime(HOLD_MS + 500);
    set(step('models'));
    expect(shown).toEqual(['history', 'models']);
  });

  test('the same step (its count ticking) shows at once, and keeps its time on screen', () => {
    set(step('history', 'Loading history · 1 of 82 streams'));
    vi.advanceTimersByTime(600);
    set(step('history', 'Loading history · 9 of 82 streams'));
    expect(shown.at(-1)).toBe('Loading history · 9 of 82 streams');
    set(step('models'));
    vi.advanceTimersByTime(399);
    expect(shown.at(-1)).toBe('Loading history · 9 of 82 streams');
    vi.advanceTimersByTime(1);
    expect(shown.at(-1)).toBe('models');
  });

  test('a short step that began while another was held still shows; at most two wait (the next in order, and the latest)', () => {
    set(step('register'));
    vi.advanceTimersByTime(800);
    set(step('observations')); // 0.2 s of work
    vi.advanceTimersByTime(100);
    set(step('history'));
    set(step('models'));
    set(step('send'));
    vi.advanceTimersByTime(100);
    expect(shown).toEqual(['register', 'observations']);
    vi.advanceTimersByTime(HOLD_MS);
    expect(shown).toEqual(['register', 'observations', 'send']); // history and models gave way to the latest
  });

  test('a waiting step takes its latest count', () => {
    set(step('register'));
    set(step('history', 'Loading history · 0 of 82 streams'));
    set(step('history', 'Loading history · 9 of 82 streams'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(shown).toEqual(['register', 'Loading history · 9 of 82 streams']);
  });

  test(`the end waits the rest of the hold, and at least ${GRACE_MS} ms`, () => {
    set(step('send'));
    vi.advanceTimersByTime(300);
    set(idle('Predicting'));
    vi.advanceTimersByTime(HOLD_MS - 301);
    expect(shown).toEqual(['send']);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(['send', 'Predicting']);

    set(step('check'));
    vi.advanceTimersByTime(5000);
    set(idle('Predicting again'));
    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(shown.at(-1)).toBe('check');
    vi.advanceTimersByTime(1);
    expect(shown.at(-1)).toBe('Predicting again');
  });

  test('two tasks back to back (register, then the poll) read as one: the end between them never shows', () => {
    set(step('register'));
    vi.advanceTimersByTime(HOLD_MS + 100);
    set(idle('Getting its first predictions…'));
    vi.advanceTimersByTime(40);
    set(step('observations'));
    vi.advanceTimersByTime(5000);
    expect(shown).toEqual(['register', 'observations']);
  });

  test('idle changes (the health) show at once', () => {
    set(idle('a'));
    set(idle('b'));
    expect(shown).toEqual(['a', 'b']);
  });

  test('delay: work shows only once it has lasted that long; shorter work never shows', () => {
    const out = [];
    const late = createHold({ show: (v) => out.push(v.line), now: () => Date.now(), delay: 1000 });
    late(idle('catalog'));
    late(step('ask'));
    vi.advanceTimersByTime(600);
    late(idle('catalog, 3 streams'));
    vi.advanceTimersByTime(5000);
    expect(out).toEqual(['catalog', 'catalog, 3 streams']);
    late(step('ask', 'Asking the relays · 0 of 2'));
    vi.advanceTimersByTime(999);
    expect(out.at(-1)).toBe('catalog, 3 streams');
    late(step('ask', 'Asking the relays · 1 of 2')); // the same step, still waiting: the latest is what shows
    vi.advanceTimersByTime(1);
    expect(out.at(-1)).toBe('Asking the relays · 1 of 2');
  });
});
