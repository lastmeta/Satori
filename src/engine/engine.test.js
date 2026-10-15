import { describe, expect, test } from 'vitest';
import {
  clean, seedFor, rng, sesLevel, forecast, direction, UP, DOWN,
  MIN_SES_POINTS, MIN_DIRECTION_POINTS,
} from './index.js';

const keyA = new Uint8Array(33).fill(2);
const keyB = Uint8Array.from({ length: 33 }, (_, i) => i * 7);
const keys = Array.from({ length: 40 }, (_, j) => Uint8Array.from({ length: 33 }, (_, i) => (i * 31 + j * 17 + j * i) & 255));

/** Deterministic random walk (does not use the engine RNG). */
function walk(n, seed = 1, start = 100) {
  let s = seed >>> 0;
  const out = [start];
  for (let i = 1; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(out[i - 1] + (s / 2 ** 32 - 0.5) * 2);
  }
  return out;
}

describe('clean', () => {
  test('keeps finite numbers and numeric strings, drops the rest', () => {
    expect(clean([1, '2.5', NaN, 'abc', null, undefined, '', ' ', Infinity, -Infinity, true, 3, '1e3']))
      .toEqual([1, 2.5, 3, 1000]);
  });
  test('accepts a Float64Array (DuckDB/Arrow column)', () => {
    expect(clean(new Float64Array([1, 2, NaN]))).toEqual([1, 2]);
  });
  test('empty or missing input gives []', () => {
    expect(clean([])).toEqual([]);
    expect(clean(undefined)).toEqual([]);
  });
});

describe('seed', () => {
  test('same key and stream give the same seed; any change gives another', () => {
    expect(seedFor(keyA, 's1', 'pick')).toBe(seedFor(keyA, 's1', 'pick'));
    expect(seedFor(keyA, 's1', 'pick')).not.toBe(seedFor(keyB, 's1', 'pick'));
    expect(seedFor(keyA, 's1', 'pick')).not.toBe(seedFor(keyA, 's2', 'pick'));
    expect(seedFor(keyA, 's1', 'pick')).not.toBe(seedFor(keyA, 's1', 'k'));
  });
  test('hex key equals its bytes', () => {
    const hex = Array.from(keyB, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(seedFor(hex, 's', 'p')).toBe(seedFor(keyB, 's', 'p'));
    expect(seedFor('0x' + hex, 's', 'p')).toBe(seedFor(keyB, 's', 'p'));
  });
  test('rng is deterministic and in [0, 1)', () => {
    const a = rng(42), b = rng(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('sesLevel', () => {
  test('alpha 1 is the last value', () => {
    expect(sesLevel([1, 5, 3], 1)).toBe(3);
  });
  test('hand-computed level', () => {
    // l0=10, l1=0.5*20+0.5*10=15, l2=0.5*10+0.5*15=12.5
    expect(sesLevel([10, 20, 10], 0.5)).toBeCloseTo(12.5, 12);
  });
});

describe('forecast', () => {
  test('no points → null', () => {
    expect(forecast([], { key: keyA, stream: 's' })).toBeNull();
    expect(forecast(['x', NaN], { key: keyA, stream: 's' })).toBeNull();
  });
  test('one point → naive', () => {
    expect(forecast([7], { key: keyA, stream: 's' })).toEqual({ model: 'naive', t1: 7, t2: 7 });
  });
  test(`fewer than ${MIN_SES_POINTS} points → naive last value`, () => {
    const r = forecast([1, 2, 3, 4, 5, 6, 7, 8, 9], { key: keyA, stream: 's' });
    expect(r).toEqual({ model: 'naive', t1: 9, t2: 9 });
  });
  test('t1 equals t2 (closed-form flat horizons)', () => {
    for (const k of keys.slice(0, 10)) {
      const r = forecast(walk(200, 3), { key: k, stream: 's' });
      expect(r.t1).toBe(r.t2);
    }
  });
  test('a trending series picks naive (SES lags)', () => {
    const up = Array.from({ length: 50 }, (_, i) => i);
    for (const k of keys.slice(0, 10)) {
      expect(forecast(up, { key: k, stream: 's' })).toMatchObject({ model: 'naive', t1: 49, t2: 49 });
    }
  });
  test('noise around a mean picks SES with a small alpha, forecast near the mean', () => {
    // alternating 9/11: naive error 2 every step, SES at small alpha ~1
    const s = Array.from({ length: 60 }, (_, i) => (i % 2 ? 11 : 9));
    const r = forecast(s, { key: keyA, stream: 's' });
    expect(r.model).toBe('ses');
    expect(r.alpha).toBeLessThan(0.5);
    expect(Math.abs(r.t1 - 10)).toBeLessThan(1);
  });
  test('constant series → the constant, no NaN', () => {
    const s = new Array(30).fill(5);
    for (const k of keys.slice(0, 10)) {
      const r = forecast(s, { key: k, stream: 's' });
      expect(r.t1).toBe(5);
      expect(r.t2).toBe(5);
    }
  });
  test('constant zero series → 0', () => {
    expect(forecast(new Array(30).fill(0), { key: keyA, stream: 's' }).t1).toBe(0);
  });
  test('deterministic for the same key and stream', () => {
    const s = walk(300, 9);
    expect(forecast(s, { key: keyB, stream: 'x' })).toEqual(forecast(s, { key: keyB, stream: 'x' }));
  });
  test('the pick stays within 1% of the best rolling MAE and differs across nodes', () => {
    const s = walk(300, 11);
    const picks = new Set();
    for (const k of keys) {
      const r = forecast(s, { key: k, stream: 'x' });
      picks.add(`${r.model}:${r.alpha}`);
      expect(r.mae).toBeLessThanOrEqual(r.bestMae * 1.01 + 1e-12);
    }
    expect(picks.size).toBeGreaterThan(1);
  });
  test('huge values do not overflow', () => {
    const s = walk(100, 5).map((x, i) => (i % 2 ? 1e307 : -1e307) * (1 + x / 1e4));
    const r = forecast(s, { key: keyA, stream: 's' });
    expect(Number.isFinite(r.t1)).toBe(true);
    expect(Math.abs(r.t1)).toBeLessThanOrEqual(1.1e307);
  });
  test('huge constant series → the constant', () => {
    expect(forecast(new Array(20).fill(1.5e308), { key: keyA, stream: 's' }).t1).toBe(1.5e308);
  });
  test('tiny values keep their scale', () => {
    const s = walk(60, 2).map((x) => x * 1e-300);
    const r = forecast(s, { key: keyA, stream: 's' });
    expect(r.t1).not.toBe(0);
    expect(Math.abs(r.t1 - s.at(-1))).toBeLessThan(1e-298);
  });
  test('strings and junk are cleaned first', () => {
    const r = forecast(['1', '2', 'x', NaN, ...Array.from({ length: 20 }, (_, i) => String(i + 3))], { key: keyA, stream: 's' });
    expect(r.model).toBe('naive');
    expect(r.t1).toBe(22);
  });
  test('works without a key (uses a fixed seed)', () => {
    const s = walk(50, 4);
    expect(forecast(s)).toEqual(forecast(s));
  });
});

describe('direction', () => {
  test('strictly rising → UP, strictly falling → DOWN, for every node', () => {
    const up = Array.from({ length: 30 }, (_, i) => i * 1.5);
    const down = up.map((x) => -x);
    for (const k of keys) {
      expect(direction(up, { key: k, stream: 's' })).toBe(UP);
      expect(direction(down, { key: k, stream: 's' })).toBe(DOWN);
    }
  });
  test('UP is 1 and DOWN is 2 (Docker / contract encoding)', () => {
    expect(UP).toBe(1);
    expect(DOWN).toBe(2);
  });
  test('a random walk does not give all DOWN (or all UP) across seeds', () => {
    const dirs = new Set();
    for (let w = 1; w <= 5; w++) {
      const s = walk(100, w);
      for (const k of keys) dirs.add(direction(s, { key: k, stream: `s${w}` }));
    }
    expect(dirs).toEqual(new Set([UP, DOWN]));
  });
  test('flat series → seeded coin flip: both directions across nodes, fixed per node', () => {
    const flat = new Array(30).fill(3.3);
    const got = keys.map((k) => direction(flat, { key: k, stream: 's' }));
    expect(new Set(got)).toEqual(new Set([UP, DOWN]));
    keys.forEach((k, i) => expect(direction(flat, { key: k, stream: 's' })).toBe(got[i]));
  });
  test('flat 0.1 series (mean rounding) still counts as flat', () => {
    const flat = new Array(20).fill(0.1);
    const got = new Set(keys.map((k) => direction(flat, { key: k, stream: 's' })));
    expect(got).toEqual(new Set([UP, DOWN]));
  });
  test(`fewer than ${MIN_DIRECTION_POINTS} values → coin flip, both directions across nodes`, () => {
    const short = [1, 2, 3, 4];
    const got = new Set(keys.map((k) => direction(short, { key: k, stream: 's' })));
    expect(got).toEqual(new Set([UP, DOWN]));
    expect(new Set(keys.map((k) => direction([], { key: k, stream: 's' })))).toEqual(new Set([UP, DOWN]));
  });
  test(`${MIN_DIRECTION_POINTS} rising values → UP`, () => {
    for (const k of keys) expect(direction([1, 2, 3, 4, 5], { key: k, stream: 's' })).toBe(UP);
  });
  test('window k is per node and stream, in [5, 20]', () => {
    // 30 high points, then a rising tail of 10: k <= 10 sees only the rise (UP),
    // k >= 11 sees the drop (DOWN). So nodes must differ.
    const s = [...new Array(30).fill(1000), ...Array.from({ length: 10 }, (_, i) => i)];
    const got = new Set(keys.map((k) => direction(s, { key: k, stream: 's' })));
    expect(got).toEqual(new Set([UP, DOWN]));
    // a fall older than 20 points is never seen
    const t = [...Array.from({ length: 30 }, (_, i) => 1000 - i * 30), ...Array.from({ length: 20 }, (_, i) => i)];
    for (const k of keys) expect(direction(t, { key: k, stream: 's' })).toBe(UP);
  });
  test('huge values keep their sign', () => {
    const s = Array.from({ length: 20 }, (_, i) => 1e308 - i * 1e306);
    for (const k of keys.slice(0, 10)) expect(direction(s, { key: k, stream: 's' })).toBe(DOWN);
    const t = Array.from({ length: 20 }, (_, i) => -1.7e308 + i * 1e306);
    for (const k of keys.slice(0, 10)) expect(direction(t, { key: k, stream: 's' })).toBe(UP);
  });
  test('junk is dropped before the window', () => {
    expect(direction(['1', 'x', 2, NaN, '3', 4, null, 5, 6], { key: keyA, stream: 's' })).toBe(UP);
  });
  test('deterministic', () => {
    const s = walk(80, 7);
    expect(direction(s, { key: keyB, stream: 'q' })).toBe(direction(s, { key: keyB, stream: 'q' }));
  });
});
