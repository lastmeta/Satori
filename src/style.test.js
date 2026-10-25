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
/** sRGB hex → OKLCH { L, C, H } (Björn Ottosson's OKLab). */
const oklch = (v) => {
  const [r, g, b] = rgb(v).map((c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  const [l, m, q] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt);
  const [L, A, B] = [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q];
  return { L, C: Math.hypot(A, B), H: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
};
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

describe.each([['light', LIGHT], ['dark', { ...LIGHT, ...FORCED_DARK }]])('%s: readable', (_, t) => { // _: the theme
  test('text (4.5:1): body and muted text on the page and on cards, links, buttons', () => {
    for (const [fg, bg] of [['text', 'bg'], ['text', 'card'], ['muted', 'bg'], ['muted', 'card'], ['accent', 'card'],
      ['accent', 'bg'], ['on-accent', 'accent'], ['accent', 'accent-soft'], ['bad', 'card'], ['idle', 'idle-soft']]) {
      expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  test("an outline button's edge, seen at a glance on a card and on the page (2:1; its words say it's a button)", () => {
    for (const bg of ['card', 'bg']) expect(contrast(t['btn-line'], t[bg]), `btn-line on ${bg}`).toBeGreaterThanOrEqual(2);
  });
  test("the status colours (3:1): the hero's large title on its soft fill, the icons on a card", () => {
    for (const s of ['ok', 'warn', 'bad', 'idle']) {
      expect(contrast(t[s], t[`${s}-soft`]), `${s} on ${s}-soft`).toBeGreaterThanOrEqual(3);
      expect(contrast(t[s], t.card), `${s} on card`).toBeGreaterThanOrEqual(3);
    }
  });
  test('the three greens (3:1): the title (ink) on its fill and on a card, the icon on its disc', () => {
    for (const g of ['sky', 'vivid']) {
      const ink = t[`${g}-ink`] ?? t[g];
      expect(contrast(ink, t[`${g}-soft`]), `${g} ink on ${g}-soft`).toBeGreaterThanOrEqual(3);
      expect(contrast(ink, t.card), `${g} ink on card`).toBeGreaterThanOrEqual(3);
      expect(contrast(t[`${g}-on`] ?? t.card, t[g]), `icon on ${g}`).toBeGreaterThanOrEqual(3);
    }
  });
  test('the three greens on one scale (OKLCH): sky is ok as sky blue is blue; vivid has more chroma at ok\'s lightness', () => {
    const [ok, sky, vivid] = [t.ok, t.sky, t.vivid].map(oklch);
    // blue oklch(0.55 0.20 260) → sky blue oklch(0.80 0.10 235): lightness × 0.80/0.55 (dark: the same step toward
    // white, 0.25/0.45 of the way), chroma × 0.5, the hue kept
    const L = _ === 'light' ? ok.L * (0.80 / 0.55) : ok.L + (0.25 / 0.45) * (1 - ok.L);
    expect(sky.L).toBeCloseTo(L, 2);
    expect(sky.C).toBeCloseTo(ok.C / 2, 2);
    expect(Math.abs(sky.H - ok.H)).toBeLessThan(1.5);
    expect(vivid.L).toBeCloseTo(ok.L, 2); // not lighter
    expect(vivid.C / ok.C).toBeGreaterThan(1.2); // brighter along chroma
    expect(Math.abs(vivid.H - ok.H)).toBeLessThan(8); // sRGB holds no more chroma at this lightness unless nudged toward green
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
