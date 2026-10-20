// Pieces the screens share.
import { html } from '@arrow-js/core';
import { state } from './state.js';

/** A submitted form's fields, the default prevented. */
export const form = (e) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.target));
};

/**
 * The 24 numbered words (a key's backup, Setup's new vault). Fixed slots, each a reactive text, never list items made
 * per word: ArrowJS keeps a list's unmounted <li>s, their text in them, to reuse (the security review, 2026-10-19), so
 * clearing the words here blanks every slot in place.
 */
export const wordList = (words, n = 24) => html`<ol class="words">${Array.from({ length: n }, (_, i) => html`<li>${() => words()[i] ?? ''}</li>`)}</ol>`;

export const fact = (label, test, text) => html`<div class="fact"><dt>${label}</dt><dd data-test="${test}">${text}</dd></div>`;

/** One of a key's identifiers (`value` a function), with Copy. */
export function idRow(kind, test, value, a, title = () => '') {
  return html`<div class="id"><span class="label">${kind}</span><code data-test="${test}" title="${title}">${value}</code><button class="small-btn" @click="${() => a.copy(test, value())}">${() => (state.copied === test ? 'Copied' : 'Copy')}</button></div>`;
}

/**
 * The inline Unlock prompt (docs/design/health.md): shown at `slot` when an action that needs the vault was asked
 * for while it is locked; Unlock, then the action.
 */
export function unlockPrompt(a, slot, verb) {
  return html`<form class="inline-unlock" data-test="unlock-prompt" data-unlock-for="${slot}" hidden="${() => state.unlockFor !== slot}" @submit="${(e) => a.unlockThen(form(e), e.target)}"><input name="pass" type="password" aria-label="${`Vault passphrase to ${verb}`}" placeholder="Vault passphrase" autocomplete="current-password" required><button class="primary" type="submit" disabled="${() => !!state.busy}">${() => (state.busy === 'unlock' ? 'Unlocking…' : 'Unlock')}</button><button type="button" @click="${a.cancelUnlock}">Cancel</button><p class="error small" role="alert" hidden="${() => !state.unlockError}">${() => state.unlockError}</p></form>`;
}

/** A health state's mark: a colored disc with its icon (the shape from the state, in CSS). */
export const mark = (s) => html`<span class="state" data-s="${s}"><i class="ico"></i></span>`;

export { sparkPath } from './format.js'; // a trend line (pure, so the views that draw one are tested without a page)
