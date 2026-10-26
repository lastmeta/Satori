// Two layouts of Streams and Market, side by side for the owner to compare (2026-10-26): 'current' (by where a stream
// comes from) and 'new' (by what a person does: Streams finds, follows, predicts and sells; Market is the money).
// The one not chosen is deleted afterwards. Read once at load (?layout=new|current, then the browser's choice);
// the switch reloads, so no view swaps under live expressions (ArrowJS 1.0.6, see src/ui/home.js cell).
import { html } from '@arrow-js/core';

const KEY = 'satori_layout';
const read = () => {
  try {
    const q = new URLSearchParams(location.search).get('layout');
    if (q === 'new' || q === 'current') localStorage.setItem(KEY, q);
    return localStorage.getItem(KEY) === 'new' ? 'new' : 'current';
  } catch { return 'current'; }
};
export const LAYOUT = typeof location === 'undefined' ? 'current' : read();

function choose(v) {
  try { localStorage.setItem(KEY, v); } catch { /* the choice lasts this load only */ }
  const u = new URL(location.href);
  if (!u.searchParams.has('layout')) return location.reload(); // the same address again would only move to its #tab
  u.searchParams.delete('layout');
  return location.replace(u.href);
}

/** The switch, at the top of both pages. */
export const layoutSwitch = () => html`<div class="layoutpick" data-test="layout-switch"><span class="muted small">Layout to compare</span><div class="segmented" role="group" aria-label="Layout to compare">${[['current', 'Current'], ['new', 'New']].map(([v, word]) => html`<button class="small-btn" data-test="${`layout-${v}`}" aria-pressed="${String(LAYOUT === v)}" @click="${() => LAYOUT !== v && choose(v)}">${word}</button>`)}</div></div>`;
