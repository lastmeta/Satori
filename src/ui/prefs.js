// Per-device UI choices, kept as the theme is (src/ui/theme.js): localStorage, read and written in try/catch, since
// storage may be blocked (then the default, for this page only). The Models tab's sort is one (docs/design/models.md),
// with its menu's keys.

export const SORT_KEY = 'satori-models-sort';

const local = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked
  }
};

/** This device's choice for `key`, if it is one of `allowed`; else `fallback`. */
export function readPref(key, allowed, fallback, storage = local()) {
  try {
    const v = storage?.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Keep `value` for `key` on this device. → whether it was kept */
export function writePref(key, value, storage = local()) {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A menu button's keys (WAI-ARIA's menu pattern), on item `i` of `n`: → { focus } (the arrows, wrapping; Home, End),
 * { close, restore } (Escape: closed, focus back on the button; Tab: closed, focus moves on), or null (the key's own).
 */
export function menuKey(key, i, n) {
  if (key === 'ArrowDown') return { focus: (i + 1) % n };
  if (key === 'ArrowUp') return { focus: (i - 1 + n) % n };
  if (key === 'Home') return { focus: 0 };
  if (key === 'End') return { focus: n - 1 };
  if (key === 'Escape') return { close: true, restore: true };
  if (key === 'Tab') return { close: true, restore: false };
  return null;
}
