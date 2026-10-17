// Settings → Appearance: System (the default), Light or Dark, kept on this device (localStorage, read before the first
// paint by public/theme.js) and set as <html data-theme> (style.css: light on :root, dark under the system's
// prefers-color-scheme unless data-theme="light", and under data-theme="dark").

export const THEMES = ['system', 'light', 'dark'];
export const THEME_KEY = 'satori-theme';

const local = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked
  }
};

/** This device's theme: 'system' unless Light or Dark was chosen. */
export function themeOf(storage = local()) {
  try {
    const t = storage?.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'system';
  } catch {
    return 'system';
  }
}

/** <html data-theme>, and the browser's bar (theme-color) to match: a forced theme's meta for all, the other for none. */
export function applyTheme(theme, doc = globalThis.document) {
  const root = doc.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  for (const m of doc.querySelectorAll('meta[name=theme-color]')) {
    m.dataset.media ??= m.media; // its own prefers-color-scheme query
    m.media = theme === 'system' ? m.dataset.media : m.dataset.media.includes(theme) ? 'all' : 'not all';
  }
}

/** Choose 'system', 'light' or 'dark': kept on this device (when storage allows) and applied. → the theme */
export function setTheme(theme, { storage = local(), doc = globalThis.document } = {}) {
  if (!THEMES.includes(theme)) throw new Error("The theme is 'system', 'light' or 'dark'.");
  try {
    if (theme === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, theme);
  } catch { /* not kept: storage blocked; applied for this page */ }
  applyTheme(theme, doc);
  return theme;
}
