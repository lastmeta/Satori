// Home's traffic glow (src/ui/glow.js): a burst is one style update in one frame, the glow holds while traffic
// goes on and ends GLOW_MS after the last of it, cards are apart, and prefers-reduced-motion holds a still tint.
import { describe, expect, test } from 'vitest';
import { createGlow, GLOW_MS, STILL_MS } from './glow.js';

function harness({ reduced = false } = {}) {
  let t = 0;
  const frames = [];
  const timers = [];
  const applied = [];
  const hit = createGlow({ apply: (ch, on) => applied.push([ch, on]), reduced: () => reduced, now: () => t,
    frame: (fn) => frames.push(fn), later: (fn, ms) => timers.push({ fn, at: t + ms }) });
  const flush = () => frames.splice(0).forEach((fn) => fn());
  /** Move the clock to `to`, running each timer due on the way at its own time. */
  function until(to) {
    for (let next; (next = timers.filter((x) => !x.ran && x.at <= to).sort((a, b) => a.at - b.at)[0]);) {
      t = next.at;
      next.ran = true;
      next.fn();
    }
    t = to;
  }
  return { hit, flush, until, frames, timers, applied, at: (x) => { t = x; } };
}

describe('glow', () => {
  test('a burst is one update: one frame and one apply, however many messages', () => {
    const g = harness();
    for (let i = 0; i < 50; i++) g.hit('network');
    expect(g.applied).toEqual([]); // nothing before the frame
    expect(g.frames).toHaveLength(1);
    g.flush();
    expect(g.applied).toEqual([['network', true]]);
    for (let i = 0; i < 50; i++) g.hit('network'); // already glowing: no frame, no update
    expect([g.frames.length, g.applied.length]).toEqual([0, 1]);
  });

  test('steady through traffic, then off GLOW_MS after the last of it; a few timers, not one per message', () => {
    expect(GLOW_MS).toBe(1500);
    const g = harness();
    g.hit('central');
    g.flush();
    for (let ms = 100; ms <= 1000; ms += 100) {
      g.until(ms);
      g.hit('central');
    }
    g.until(1000 + GLOW_MS - 1);
    expect(g.applied).toEqual([['central', true]]);
    g.until(1000 + GLOW_MS);
    expect(g.applied).toEqual([['central', true], ['central', false]]);
    expect(g.timers.length).toBeLessThanOrEqual(3);
    g.hit('central'); // traffic again: glows again
    g.flush();
    expect(g.applied.at(-1)).toEqual(['central', true]);
  });

  test('each card on its own', () => {
    const g = harness();
    g.hit('central');
    g.hit('base');
    expect(g.frames).toHaveLength(2);
    g.flush();
    g.until(1000);
    g.hit('base');
    g.until(GLOW_MS);
    expect(g.applied).toEqual([['central', true], ['base', true], ['central', false]]);
    g.until(1000 + GLOW_MS);
    expect(g.applied.at(-1)).toEqual(['base', false]);
  });

  test('prefers-reduced-motion: a still tint while traffic was within STILL_MS (the CSS drops the fades)', () => {
    expect(STILL_MS).toBe(3000);
    const g = harness({ reduced: true });
    g.hit('central');
    g.flush();
    g.until(STILL_MS - 1);
    expect(g.applied).toEqual([['central', true]]);
    g.until(STILL_MS);
    expect(g.applied).toEqual([['central', true], ['central', false]]);
  });
});
