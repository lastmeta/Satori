// Settings → Appearance (src/ui/theme.js): System, Light or Dark, kept on this device and set as <html data-theme>;
// public/theme.js reads the same choice before the first paint.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { THEMES, THEME_KEY, themeOf, setTheme, applyTheme } from './theme.js';

const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } };
const fakeDoc = () => {
  const metas = [{ media: '(prefers-color-scheme: light)', dataset: {} }, { media: '(prefers-color-scheme: dark)', dataset: {} }];
  return { documentElement: { dataset: {} }, querySelectorAll: (q) => (q === 'meta[name=theme-color]' ? metas : []), metas };
};

test('Dark and Light are kept on this device and set as data-theme; System clears both', () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  expect(THEMES).toEqual(['system', 'light', 'dark']);
  expect(themeOf(storage)).toBe('system');
  expect(setTheme('dark', { storage, doc })).toBe('dark');
  expect([storage.m.get(THEME_KEY), doc.documentElement.dataset.theme, themeOf(storage)]).toEqual(['dark', 'dark', 'dark']);
  setTheme('light', { storage, doc });
  expect([storage.m.get(THEME_KEY), doc.documentElement.dataset.theme]).toEqual(['light', 'light']);
  setTheme('system', { storage, doc });
  expect([storage.m.has(THEME_KEY), 'theme' in doc.documentElement.dataset, themeOf(storage)]).toEqual([false, false, 'system']);
});

test("the browser's bar follows the forced theme (theme-color), and the system's again on System", () => {
  const doc = fakeDoc();
  applyTheme('dark', doc);
  expect(doc.metas.map((m) => m.media)).toEqual(['not all', 'all']);
  applyTheme('light', doc);
  expect(doc.metas.map((m) => m.media)).toEqual(['all', 'not all']);
  applyTheme('system', doc);
  expect(doc.metas.map((m) => m.media)).toEqual(['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']);
});

test('anything else is refused; a stored value that is not a theme is System', () => {
  const storage = fakeStorage();
  for (const t of ['blue', '', null, 'Dark']) expect(() => setTheme(t, { storage, doc: fakeDoc() })).toThrow("'system', 'light' or 'dark'");
  storage.setItem(THEME_KEY, 'blue');
  expect(themeOf(storage)).toBe('system');
});

test('storage blocked (a private window): applied all the same, not kept; System when read', () => {
  const doc = fakeDoc();
  expect(setTheme('dark', { storage: blocked, doc })).toBe('dark');
  expect(doc.documentElement.dataset.theme).toBe('dark');
  expect(themeOf(blocked)).toBe('system');
  expect(themeOf(null)).toBe('system');
});

test("public/theme.js, before the first paint, reads the same key and sets the same attribute", () => {
  const src = readFileSync(new URL('../../public/theme.js', import.meta.url), 'utf8');
  const run = (storage) => { const doc = fakeDoc(); new Function('localStorage', 'document', src)(storage, doc); return doc.documentElement.dataset.theme; };
  const storage = fakeStorage();
  expect(run(storage)).toBeUndefined();
  setTheme('dark', { storage, doc: fakeDoc() });
  expect(run(storage)).toBe('dark');
  storage.setItem(THEME_KEY, 'light');
  expect(run(storage)).toBe('light');
  storage.setItem(THEME_KEY, 'blue');
  expect(run(storage)).toBeUndefined();
  expect(run(blocked)).toBeUndefined(); // no throw
});
