// style.css's tokens: light on :root, dark under prefers-color-scheme (unless data-theme="light") and the same dark
// under data-theme="dark"; every colour readable in each theme (WCAG contrast), and the traffic glow faint, low in
// saturation and apart from --ok.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const tokens = (body) => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const LIGHT = tokens(css.match(/^:root \{([\s\S]*?)^\}/m)[1]);
const SYSTEM_DARK = tokens(css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\}/)[1]);
const FORCED_DARK = tokens(css.match(/^:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m)[1]);
const COLOUR = /^(#|rgb)/;

const rgb = (v) => (v.startsWith('#') ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : v.match(/[\d.]+/g).slice(0, 3).map(Number));
const lum = (v) => {
  const [r, g, b] = rgb(v).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const saturation = (v) => { const c = rgb(v).map((x) => x / 255); const [max, min] = [Math.max(...c), Math.min(...c)]; const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1)); };

test('every colour token has a dark value, the same under the system and under data-theme="dark"', () => {
  const colours = Object.keys(LIGHT).filter((k) => COLOUR.test(LIGHT[k]));
  expect(colours.length).toBeGreaterThan(15);
  expect(Object.keys(SYSTEM_DARK).sort()).toEqual(colours.sort());
  expect(FORCED_DARK).toEqual(SYSTEM_DARK);
  expect(css).toMatch(/:root \{[^}]*color-scheme: light;/);
  expect(SYSTEM_DARK).toBeDefined();
  expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;/);
});

describe.each([['light', LIGHT], ['dark', { ...LIGHT, ...FORCED_DARK }]])('%s: readable', (_, t) => {
  test('text (4.5:1): body and muted text on the page and on cards, links, buttons', () => {
    for (const [fg, bg] of [['text', 'bg'], ['text', 'card'], ['muted', 'bg'], ['muted', 'card'], ['accent', 'card'],
      ['accent', 'bg'], ['on-accent', 'accent'], ['accent', 'accent-soft'], ['bad', 'card'], ['idle', 'idle-soft']]) {
      expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  test("the status colours (3:1): the hero's large title on its soft fill, the icons on a card", () => {
    for (const s of ['ok', 'warn', 'bad', 'idle']) {
      expect(contrast(t[s], t[`${s}-soft`]), `${s} on ${s}-soft`).toBeGreaterThanOrEqual(3);
      expect(contrast(t[s], t.card), `${s} on card`).toBeGreaterThanOrEqual(3);
    }
  });
  test('the traffic glow: faint (under 3:1 on a card, yet seen), low in saturation, not --ok', () => {
    const c = contrast(t.live, t.card);
    expect(c).toBeGreaterThan(1.5);
    expect(c).toBeLessThan(3);
    expect(saturation(t.live)).toBeLessThan(0.2);
    expect(saturation(t.ok)).toBeGreaterThan(0.4);
    expect(t.live).not.toBe(t.ok);
  });
});
