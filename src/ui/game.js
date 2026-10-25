// The Game tab (docs/design/base.md#played-by-hand): the Satori contract played by hand. While the app plays it on its
// own (automatic), the game is greyed out under the switch to play by hand; by hand, the game, and the way back.
import { html } from '@arrow-js/core';
import { state } from './state.js';

const manual = () => state.base.play === 'manual';

export function gameTab(a) {
  return html`
  <section class="tab-page game" data-test="game-tab" data-play="${() => state.base.play ?? false}" hidden="${() => state.tab !== 'game'}">
    <div class="play-bar" data-test="play-bar" hidden="${() => !manual()}">
      <span>You play by hand: the app doesn't send its daily predictions to the Satori contract.</span>
      <button class="small-btn" data-test="play-auto" @click="${() => a.setPlay('auto')}">Switch to automatic</button>
    </div>
    <div class="game-stage">
      <div class="card game-board" data-test="game-board" inert="${() => !manual()}"></div>
      <div class="card play-switch" data-test="play-switch" hidden="${manual}">
        <h2>The app plays for you</h2>
        <p class="muted">Each day it sends predictions to the Satori contract. Would you like to turn off automatic predictions
          and play the game yourself?</p>
        <button class="primary" data-test="play-manual" disabled="${() => !state.base.play}" @click="${() => a.setPlay('manual')}">Play by hand</button>
      </div>
    </div>
  </section>`;
}
