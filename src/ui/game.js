// The Game tab (docs/design/base.md#the-game): the Satori contract played by hand, a much simplified dapp. One stream
// at a time, filling the screen: its name (with a star) and its latest value, its line, and two big buttons, down
// (red) and up (green). A swipe left skips, a swipe right goes back. After the last stream, the submit screen; after
// more than one favorite, Submit shows under the buttons. While the app plays on its own (automatic) the game is
// greyed out under the switch to play by hand (and back: Settings › Satori contract predictions). Its flow: src/ui/gameflow.js.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { unlockPrompt } from './parts.js';
import { shortHash } from './format.js';
import { latestText, linePoints, nothingText, submitEarly } from './gameflow.js';
import { UP, DOWN } from '../chain/index.js';

const manual = () => state.base.play === 'manual';
const g = () => state.game;
const current = () => g().queue[g().index] ?? null;
const pickCount = () => Object.keys(g().picks).length;
const showing = (what) => () => {
  const x = g();
  const view = x.error ? 'error' : !x.loaded ? 'loading' : x.sent ? 'sent' : !x.queue.length ? 'nothing'
    : x.screen === 'submit' ? 'submit' : 'play';
  return view !== what;
};

// the arrows point right, up at 45° and down at -45°; the star; each drawn as a raised (bevelled) mark
// engraved: the arrow a darker shade of the button, lit along its lower edge and shaded along its upper one
const engraved = (d) => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path class="lit" d="${d}"></path><path class="shade" d="${d}"></path><path class="cut" d="${d}"></path></svg>`;
const ARROW_UP = () => engraved('M6 18L18 6M9 6h9v9');
const ARROW_DOWN = () => engraved('M6 6l12 12M18 9v9H9');
const STAR = () => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"></path></svg>`;

/** A swipe on the stream: left skips it, right goes back (a mostly sideways move of 50 px or more). */
function swipe(a) {
  let start = null;
  return {
    down: (e) => { start = { x: e.clientX, y: e.clientY }; },
    up: (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) a.gameNext();
      else a.gameBack();
    },
    cancel: () => { start = null; },
  };
}

const callWord = (d) => (d === UP ? 'up' : 'down');

function play(a) {
  const sw = swipe(a);
  const starred = () => !!current() && g().favorites.includes(current().streamId);
  const picked = (d) => () => String(!!current() && g().picks[current().streamId] === d);
  const early = () => submitEarly({ index: g().index, favorites: g().favs, picks: pickCount() });
  return html`
  <div class="gplay" data-test="game-play" hidden="${showing('play')}" @pointerdown="${sw.down}" @pointerup="${sw.up}" @pointercancel="${sw.cancel}">
    <div class="gstream" data-move="${() => g().move || false}">${() => {
      const s = current();
      return s ? html`<div class="gview">
        <div class="ghead">
          <button class="gstar" data-test="game-star" aria-pressed="${() => String(starred())}" aria-label="${() => (starred() ? 'Unstar' : 'Star')}" title="Favorite: shown first" @click="${() => a.gameStar(s.streamId)}">${STAR()}</button>
          <b class="gname" data-test="game-name">${s.name}</b>
          <span class="glatest" data-test="game-latest">${latestText(s)}</span>
        </div>
        <svg class="gchart" data-test="game-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${linePoints(s.history)}"></polyline></svg>
      </div>`.key(`${s.streamId}:${g().index}`) : '';
    }}</div>
    <div class="gbtns">
      <button class="gbtn down" data-test="game-down" aria-label="Down" aria-pressed="${picked(DOWN)}" @click="${() => a.gamePick(DOWN)}">${ARROW_DOWN()}</button>
      <button class="gbtn up" data-test="game-up" aria-label="Up" aria-pressed="${picked(UP)}" @click="${() => a.gamePick(UP)}">${ARROW_UP()}</button>
    </div>
    <div class="gsubmit" data-test="game-submit-early" data-open="${() => String(early())}" inert="${() => !early()}"><div>
      <button class="primary" data-test="game-submit" @click="${a.gameSubmitNow}">Submit</button>
    </div></div>
  </div>`;
}

function submit(a) {
  const sw = swipe(a);
  const calls = () => g().queue.filter((s) => g().picks[s.streamId]);
  return html`
  <div class="gsubmit-screen" data-test="game-submit-screen" hidden="${showing('submit')}" @pointerdown="${sw.down}" @pointerup="${sw.up}" @pointercancel="${sw.cancel}">
    <h2>${() => (pickCount() ? `Submit ${pickCount()} prediction${pickCount() === 1 ? '' : 's'}?` : 'No predictions yet')}</h2>
    <ul class="gcalls" data-test="game-calls">${() => calls().map((s) => html`<li><span>${s.name}</span><b data-dir="${callWord(g().picks[s.streamId])}">${callWord(g().picks[s.streamId])}</b></li>`.key(`${s.streamId}:${g().picks[s.streamId]}`))}</ul>
    <p class="muted small">${() => (g().by === 'alias' ? 'Sent from this app, for your staked wallet; it uses a little Base ETH for gas.'
      : 'Sent from your wallet; it uses a little Base ETH for gas.')}</p>
    <div class="actions">
      <button class="primary" data-test="game-send" hidden="${() => !pickCount()}" disabled="${() => g().sending}" @click="${a.gameSend}">${() => (g().sending ? 'Sending…' : 'Submit predictions')}</button>
      <button data-test="game-back" @click="${a.gameBack}">Back</button>
    </div>
    ${unlockPrompt(a, 'game', 'send your predictions')}
    <p class="error small" role="alert" data-test="game-send-error" hidden="${() => !g().sendError}">${() => g().sendError}</p>
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
          <h2>${() => `Sent ${g().sent?.count ?? 0} prediction${g().sent?.count === 1 ? '' : 's'}`}</h2>
          <p class="muted small">${() => (g().sent ? `Scored about 24 hours after each was made.${g().sent.hash ? ` Transaction ${shortHash(g().sent.hash)}.` : ''}` : '')}</p>
          <p class="muted small" data-test="game-tomorrow" hidden="${() => !g().sent?.again}">Played today. The next game opens tomorrow.</p>
          <button data-test="game-done" hidden="${() => !!g().sent?.again}" @click="${a.loadGame}">Done</button>
        </div>
        ${play(a)}
        ${submit(a)}
      </div>
      <div class="card play-switch" data-test="play-switch" hidden="${manual}">
        <h2>The app plays for you</h2>
        <p class="muted">Each day it sends predictions to the Satori contract. Would you like to turn off automatic predictions
          and play the game yourself?</p>
        <button class="primary" data-test="play-manual" disabled="${() => !state.base.play}" @click="${() => a.setPlay('manual')}">Play by hand</button>
      </div>
    </div>
  </section>`;
}
