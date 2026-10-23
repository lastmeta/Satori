// Per-device UI choices, kept as the theme is (src/ui/theme.js): localStorage, read and written in try/catch, since
// storage may be blocked (then the default, for this page only). The Models tab's sort is one (docs/design/models.md),
// with its menu's keys; the last visit's Home is another (a snapshot painted at once on the next visit).

export const SORT_KEY = 'satori-models-sort';
export const INSTALL_KEY = 'satori-install-advice'; // 'dismissed': Home's Install card was put away (docs/design/pwa.md#install)

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

// ── the last visit's Home (docs/design/health.md#the-last-visit) ──

export const SNAPSHOT_KEY = 'satori-home';
const chipOf = ({ state, tone, text }) => ({ state, tone, text });

/**
 * What Home draws, small, to paint at once on the next visit until live data arrives: the health without its card (its
 * buttons need the running neuron), its work or the chips' traffic; the claimable rewards, the wallet and the gas.
 */
export function snapshotOf({ health, base, at }) {
  const { status, tone, title, line, days, feed, channels } = health;
  return { v: 1, at, health: { status, tone, title, line, days, feed,
    channels: { network: chipOf(channels.network), contract: chipOf(channels.contract), relays: chipOf(channels.relays) } },
  base: base ? { claimable: base.claimable, wallet: { satori: base.wallet.satori, staked: base.wallet.staked },
    alias: { batchesLeft: base.alias.batchesLeft } } : null };
}

/** The last visit's Home, or null (none, storage blocked, or not one this version wrote). */
export function readSnapshot(storage = local()) {
  try {
    const s = JSON.parse(storage?.getItem(SNAPSHOT_KEY) ?? 'null');
    const h = s?.health;
    return s?.v === 1 && Number.isFinite(s.at) && typeof h?.title === 'string' && Array.isArray(h.days) && h.channels ? s : null;
  } catch {
    return null;
  }
}

/** → whether it was kept */
export const writeSnapshot = (snap, storage = local()) => writePref(SNAPSHOT_KEY, JSON.stringify(snap), storage);

/** The last visit's Home dropped: another wallet opens next (docs/design/wallets.md#several-wallets). */
export function dropSnapshot(storage = local()) {
  try { storage?.removeItem(SNAPSHOT_KEY); } catch { /* storage blocked */ }
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
