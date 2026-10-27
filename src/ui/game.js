// The Game tab (docs/design/base.md#the-game): the Satori contract played by hand, a much simplified dapp. One stream
// at a time, filling the screen: its name (with a star) and its latest value, its line, and two big buttons, down
// (red) and up (green). A swipe left skips, a swipe right goes back; every move slides (the screen follows the finger). After the last stream, the submit screen; after
// more than one favorite, Submit shows under the buttons. While the app plays on its own (automatic) the game is
// greyed out under the switch to play by hand (and back: Settings › Satori contract predictions). Its flow: src/ui/gameflow.js.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { unlockPrompt } from './parts.js';
import { figure } from './format.js';
import { latestText, linePoints, nothingText, submitEarly, stepOf } from './gameflow.js';
import { UP, DOWN } from '../chain/index.js';
import { SATORI_DAILY_URL } from '../chain/config.js';

const manual = () => state.base.play === 'manual';
const g = () => state.game;
const current = () => g().queue[g().index] ?? null;
const pickCount = () => Object.keys(g().picks).length;
/** Played today, its Sent screen dismissed: the streams to look at, no buttons. */
const resting = () => !!(g().rest && g().sent?.again);
const showing = (what) => () => {
  const x = g();
  const view = x.error ? 'error' : !x.loaded ? 'loading' : x.sent && !(x.sent.again && x.rest) ? 'sent' : !x.queue.length ? 'nothing'
    : x.screen === 'submit' ? 'submit' : 'play';
  return view !== what;
};

// the arrows point right, up at 45° and down at -45°; the star; each drawn as a raised (bevelled) mark
// engraved: the arrow a darker shade of the button, lit along its lower edge and shaded along its upper one
const engraved = (d) => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path class="lit" d="${d}"></path><path class="shade" d="${d}"></path><path class="cut" d="${d}"></path></svg>`;
const ARROW_UP = () => engraved('M6 18L18 6M9 6h9v9');
const ARROW_DOWN = () => engraved('M6 6l12 12M18 9v9H9');
const STAR = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"></path></svg>`;

// ── moving between screens: the stream on screen slides off and the next slides on (the buttons stay, but for the
// last stream, when they go with it and the submit screen comes on); a swipe drags it first. The one leaving is a copy
// (ArrowJS has already drawn the next), laid over the board while it slides off.
const SLIDE_MS = 300;
const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const boardEl = () => document.querySelector('[data-test=game-board]');
/** What moves: the whole screen when it changes (play ↔ submit), else the stream alone. */
const movingEl = (whole) => {
  const b = boardEl();
  if (!b) return null;
  if (g().screen === 'submit') return b.querySelector('.gsubmit-screen');
  return b.querySelector(whole ? '.gplay' : '.gview');
};
let sliding = false;

/**
 * Change what is shown (`change`, the state's step) with a slide: dir 1 forward (off to the left, the next in from
 * the right), -1 back; `whole`: the screen changes; `from`: where a drag left it (px).
 */
async function slide(dir, whole, change, from = 0) {
  const out = movingEl(whole);
  const b = boardEl();
  if (sliding || !out || !b || reduced()) return void change();
  sliding = true;
  try {
    await slideOff(dir, whole, change, from, out, b);
  } finally {
    sliding = false; // whatever happens, the next move is never blocked
  }
}

async function slideOff(dir, whole, change, from, out, b) {
  const [br, r] = [b.getBoundingClientRect(), out.getBoundingClientRect()];
  const copy = out.cloneNode(true);
  for (const el of [copy, ...copy.querySelectorAll('[data-test]')]) el.removeAttribute('data-test');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  Object.assign(copy.style, { position: 'absolute', left: `${r.left - br.left}px`, top: `${r.top - br.top}px`, width: `${r.width}px`,
    height: `${r.height}px`, margin: '0', pointerEvents: 'none', transform: `translateX(${from}px)` });
  out.style.transform = '';
  b.append(copy);
  change();
  await Promise.resolve(); // ArrowJS draws the next in a microtask
  await Promise.resolve();
  const w = b.clientWidth;
  const inc = movingEl(whole);
  const opts = { duration: SLIDE_MS, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' };
  const gone = copy.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${-dir * w}px)` }], opts).finished;
  inc?.animate([{ transform: `translateX(${dir * w + from}px)` }, { transform: 'translateX(0)' }], opts);
  await Promise.race([gone.catch(() => {}), new Promise((done) => setTimeout(done, SLIDE_MS + 200))]);
  copy.remove();
}

/** The game's moves, each with its slide (the whole screen when it changes: gameflow.js stepOf). */
function moves(a) {
  const to = (dir) => {
    const t = stepOf({ screen: g().screen, index: g().index, length: g().queue.length, split: g().split }, dir);
    return resting() && t?.screen === 'submit' ? null : t; // played today: the streams to look at, no submit screen
  };
  const go = (dir, fn, from) => {
    const t = to(dir);
    return t ? slide(dir, t.screen !== g().screen, fn, from) : undefined;
  };
  return {
    can: (dir) => !!to(dir),
    /** What a drag that way moves: the whole screen when it leads to the other screen, else the stream. */
    dragged: (dir) => {
      const t = to(dir);
      return movingEl(!!t && t.screen !== g().screen);
    },
    next: (from) => go(1, a.gameNext, from),
    back: (from) => go(-1, a.gameBack, from),
    pick: (d) => go(1, () => a.gamePick(d)),
    submitNow: () => slide(1, true, a.gameSubmitNow),
  };
}

/**
 * A swipe: the stream (or the whole screen, toward the submit screen) follows the finger sideways; let go past 60 px,
 * or flicked fast past 25 px, and it goes on (left: the next, skipping this one) or back (right); else it springs
 * back. The distance is where the finger lifts, not its last move (a fast flick moves in few, long steps). Nothing to
 * go back to: it gives a little and returns.
 */
const SWIPE_PX = 60;
const FLICK_PX = 25;
const FLICK_PX_PER_MS = 0.3;
const FLICK_MS = 100;
function swipe(m) {
  let start = null;
  let dx = 0;
  let dragging = false;
  let trail = []; // the finger's recent { x, t }: its speed over the last FLICK_MS when it lifts
  let held = null; // what the finger moves now
  const target = () => held ?? movingEl(false);
  const canBack = () => m.can(-1);
  const canNext = () => m.can(1);
  const settle = (el) => {
    if (!el || !dx) return;
    el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], { duration: 200, easing: 'ease-out' });
    el.style.transform = '';
  };
  /** The finger at x, y (from where it went down): drag what it moves, once the move is sideways. */
  const follow = (e, x, y) => {
    if (!dragging && Math.abs(x) > 8 && Math.abs(x) > Math.abs(y) * 1.2) {
      dragging = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* gone */ } // the finger may leave the area
    }
    if (!dragging) return;
    const now = performance.now();
    trail = [...trail.filter((p) => now - p.t <= FLICK_MS), { x, t: now }];
    dx = (x < 0 ? canNext() : canBack()) ? x : x * 0.25;
    const el = m.dragged(x < 0 ? 1 : -1);
    if (held && held !== el) held.style.transform = ''; // turned back the other way: the other thing moves
    held = el;
    if (el) el.style.transform = `translateX(${dx}px)`;
  };
  return {
    down: (e) => {
      if (sliding) return;
      start = { x: e.clientX, y: e.clientY };
      dx = 0;
      trail = [{ x: 0, t: performance.now() }];
      dragging = false;
    },
    move: (e) => { if (start) follow(e, e.clientX - start.x, e.clientY - start.y); },
    up: (e) => {
      if (!start) return;
      if (e.clientX || e.clientY) follow(e, e.clientX - start.x, e.clientY - start.y); // where it lifted (an emulated lift says 0, 0)
      start = null;
      if (!dragging) return;
      dragging = false;
      justDragged = true;
      setTimeout(() => { justDragged = false; }); // the click that ends this drag comes first
      const el = target();
      held = null;
      const [a, b] = [trail[0], trail.at(-1)];
      const speed = a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0; // px/ms over the last moments
      const flick = Math.abs(dx) >= FLICK_PX && Math.abs(speed) >= FLICK_PX_PER_MS && Math.sign(speed) === Math.sign(dx);
      const far = Math.abs(dx) >= SWIPE_PX || flick;
      const dir = far && dx < 0 && canNext() ? 1 : far && dx > 0 && canBack() ? -1 : 0;
      if (!dir) return void settle(el);
      if (el) el.style.transform = ''; // the slide carries on from dx, with a copy
      if (dir > 0) m.next(dx);
      else m.back(dx);
    },
    cancel: () => { start = null; dragging = false; settle(target()); held = null; },
  };
}
let justDragged = false;
/** The click that ends a drag is not a press. */
const tap = (fn) => () => { if (!justDragged) fn(); };

const callWord = (d) => (d === UP ? 'up' : 'down');

// ── the wallet on top: its SATORI, always; what can be claimed, with CLAIM (Home's Claim), while there is some ──
const claimable = () => Number(state.base.claimable?.total ?? 0);
const claimed = () => state.baseDid === 'claim' && !!state.baseResult && !state.baseError;
const claimShown = () => claimable() > 0 || (claimed() && g().claimAmount > 0);

function wallet(a) {
  return html`
  <div class="gwallet">
    <div class="gclaim" data-test="game-claim-row" hidden="${() => !claimShown()}">
      <b class="gclaimable" data-test="game-claimable">${() => figure(claimed() ? g().claimAmount : claimable())}</b>
      <button class="gbtn claim" data-test="game-claim" aria-label="${() => (claimed() ? 'Claimed' : 'Claim')}" disabled="${() => claimed() || !!state.baseBusy}" @click="${a.gameClaim}"><span class="engraved">${() => (claimed() ? 'CLAIMED' : state.baseBusy === 'claim' ? 'CLAIMING…' : 'CLAIM')}</span></button>
    </div>
    ${unlockPrompt(a, 'game-claim', 'claim')}
    <p class="error small" role="alert" data-test="game-claim-error" hidden="${() => !(state.baseDid === 'claim' && state.baseError)}">${() => state.baseError}</p>
  </div>`;
}

function play(a) {
  const m = moves(a);
  const sw = swipe(m);
  const starred = () => !!current() && g().favorites.includes(current().streamId);
  const picked = (d) => () => String(!!current() && g().picks[current().streamId] === d);
  const early = () => submitEarly({ index: g().index, favorites: g().favs, picks: pickCount(), split: g().split });
  return html`
  <div class="gplay" data-test="game-play" hidden="${showing('play')}" @pointerdown="${sw.down}" @pointermove="${sw.move}" @pointerup="${sw.up}" @pointercancel="${sw.cancel}">
    ${wallet(a)}
    <div class="gstream" data-move="${() => g().move || false}">${() => {
      const s = current();
      const k = s?.streak; // { streak, bar }: at or above the bar, the streak earns on the S-curve's top
      return s ? html`<div class="gview">
        <div class="gtop">
          <p class="gbalance" data-test="game-balance">${() => figure(state.base.wallet.satori)}</p>
          <div class="gstreak" data-test="game-streak" hidden="${!k}" data-above="${String(!!k && k.streak >= k.bar)}" title="${k ? `Streak ${k.streak} on this stream: ${k.streak >= k.bar ? 'past' : 'short of'} this game's turning point (${k.bar}), where a streak starts earning at the top of the curve` : ''}" aria-label="${k ? `Streak ${k.streak}` : ''}"><b>${k ? String(k.streak) : ''}</b><i aria-hidden="true"></i></div>
        </div>
        <div class="ghead">
          <button class="gstar" data-test="game-star" aria-pressed="${String(starred())}" aria-label="${starred() ? 'Unstar' : 'Star'}" title="Favorite: shown first" @click="${() => a.gameStar(s.streamId)}">${STAR()}</button>
          <b class="gname" data-test="game-name">${s.name}</b>
          <span class="glatest" data-test="game-latest">${latestText(s)}</span>
        </div>
        <svg class="gchart" data-test="game-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${linePoints(s.history)}"></polyline></svg>
      </div>`.key(`${s.streamId}:${g().index}:${starred()}`) : ''; // plain values inside: drawn again when one changes (home.js cell)
    }}</div>
    <div class="gbtns-area">
      <div class="gbtns" data-rest="${() => String(resting())}" inert="${resting}">
        <button class="gbtn down" data-test="game-down" aria-label="Down" aria-pressed="${picked(DOWN)}" @click="${tap(() => m.pick(DOWN))}">${ARROW_DOWN()}</button>
        <button class="gbtn up" data-test="game-up" aria-label="Up" aria-pressed="${picked(UP)}" @click="${tap(() => m.pick(UP))}">${ARROW_UP()}</button>
      </div>
      <p class="grest" data-test="game-rest" hidden="${() => !resting()}">Come back tomorrow to see how your predictions were scored.</p>
    </div>
    <div class="gsubmit" data-test="game-submit-early" hidden="${resting}" data-open="${() => String(early())}" inert="${() => !early()}"><div>
      <button class="gbtn submit" data-test="game-submit" aria-label="Submit" @click="${tap(m.submitNow)}"><span class="engraved">SUBMIT</span></button>
    </div></div>
  </div>`;
}

// a call in the list: its arrow, as on the buttons (up at 45°, down at -45°), green or red; opening a new tab
const callArrow = (d) => html`<svg class="${d === UP ? 'garrow up' : 'garrow down'}" viewBox="0 0 24 24" role="img" aria-label="${d === UP ? 'up' : 'down'}"><path d="${d === UP ? 'M6 18L18 6M9 6h9v9' : 'M6 6l12 12M18 9v9H9'}"></path></svg>`;
const NEW_TAB = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>`;

/**
 * The submit screen: Satori Daily on top, the calls about to be sent (centred, scrolling when long), SUBMIT at the
 * bottom. A swipe right goes back; left goes on to more streams when there are any.
 */
function submit(a) {
  const m = moves(a);
  const sw = swipe(m);
  const calls = () => g().queue.filter((s) => g().picks[s.streamId]);
  return html`
  <div class="gsubmit-screen" data-test="game-submit-screen" hidden="${showing('submit')}" @pointerdown="${sw.down}" @pointermove="${sw.move}" @pointerup="${sw.up}" @pointercancel="${sw.cancel}">
    <div class="gdaily">
      <p>For a more detailed experience of the Satori daily prediction game, use the full-featured game:</p>
      <a class="gbtn daily" data-test="game-daily" href="${SATORI_DAILY_URL}" target="_blank" rel="noopener">Satori Daily ${NEW_TAB()}</a>
    </div>
    <div class="gcalls-wrap">
      <ul class="gcalls" data-test="game-calls">${() => calls().map((s) => html`<li><span>${s.name}</span>${callArrow(g().picks[s.streamId])}</li>`.key(`${s.streamId}:${g().picks[s.streamId]}`))}</ul>
      <p class="muted center" hidden="${() => !!pickCount()}">No predictions yet. Swipe back to make some.</p>
    </div>
    ${unlockPrompt(a, 'game', 'send your predictions')}
    <p class="error small" role="alert" data-test="game-send-error" hidden="${() => !g().sendError}">${() => g().sendError}</p>
    <button class="gbtn submit" data-test="game-send" aria-label="Submit" hidden="${() => !pickCount()}" disabled="${() => g().sending}" @click="${a.gameSend}"><span class="plain">${() => (g().sending ? 'SENDING…' : 'SUBMIT')}</span></button>
  </div>`;
}

export function gameTab(a) {
  return html`
  <section class="tab-page game" data-test="game-tab" data-play="${() => state.base.play ?? false}" hidden="${() => state.tab !== 'game'}">
    <div class="game-stage">
      <div class="game-board" data-test="game-board" inert="${() => !manual()}">
        <p class="muted center gmsg" hidden="${showing('loading')}">Reading the games…</p>
        <div class="gmsg" hidden="${showing('error')}"><p class="error">${() => `The chain did not answer: ${g().error}`}</p><button @click="${a.loadGame}">Try again</button></div>
        <div class="gmsg" data-test="game-nothing" hidden="${showing('nothing')}"><p>${() => nothingText(g().streams)}</p><button data-test="game-again" @click="${a.loadGame}">Check again</button></div>
        <div class="gmsg" data-test="game-sent" hidden="${showing('sent')}">
          <h2>${() => `${g().sent?.count ?? 0} Prediction${g().sent?.count === 1 ? '' : 's'} submitted`}</h2>
          <p class="muted small">${() => (g().sent?.count === 1 ? 'It will be scored in 24 hours.' : 'They will be scored in 24 hours.')}</p>
          <p class="muted small" data-test="game-tomorrow">Played today. The next game opens tomorrow.</p>
          <button data-test="game-dismiss" @click="${a.gameRest}">Dismiss</button>
        </div>
        ${play(a)}
        ${submit(a)}
      </div>
      <div class="card play-switch" data-test="play-switch" hidden="${() => state.base.play !== 'auto'}">
        <h2>The app plays for you</h2>
        <p class="muted">Each day it sends predictions to the Satori contract. Would you like to turn off automatic predictions
          and play the game yourself?</p>
        <button class="primary" data-test="play-manual" disabled="${() => !state.base.play}" @click="${() => a.setPlay('manual')}">Play by hand</button>
      </div>
    </div>
  </section>`;
}
