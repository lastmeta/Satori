// Home's "How Does This Work?" card (owner, 2026-10-26): folded like Activity; open, "What is Satori?" first, then
// five pictures in the icons' line style, each with the owner's sentence: the app (streams in, a phone, predictions
// out: the Models icon, big), the network of apps listening to each other's predictions, the contract scoring them and
// paying, sharing the app, and last what to do each day (2026-10-27: a phone, the Game's pad). The pictures are static
// SVG, each one literal (no nested templates inside an <svg>).
import { html } from '@arrow-js/core';

/** Streams in on the left, the phone with its model, predictions out on the right (dashed, with arrowheads). */
const APP = () => html`<svg class="hw" viewBox="0 0 320 120" role="img" aria-label="Data streams flow into the phone; predictions flow out of it">
  <path class="hin" d="M8 26l9-6 9 9 9-8 9 8 9-5 9 2C100 23 112 44 138 44"></path>
  <path class="hin" d="M8 60l9 6 9-9 9 7 9-8 9 6 9-2C100 60 112 60 138 60"></path>
  <path class="hin" d="M8 94l9-7 9 8 9-9 9 7 9-4 9 3C100 97 112 76 138 76"></path>
  <path class="hout" d="M182 44C210 44 222 26 296 26"></path>
  <path class="hout" d="M182 60H296"></path>
  <path class="hout" d="M182 76C210 76 222 94 296 94"></path>
  <path class="hhead" d="M292 20l8 6-8 6M292 54l8 6-8 6M292 88l8 6-8 6"></path>
  <rect class="dev" x="138" y="14" width="44" height="92" rx="8"></rect>
  <path d="M155 97h10"></path>
  <path class="hnet" d="M150 42l20 10-14 16zM150 42l6 26"></path>
  <circle class="hdot" cx="150" cy="42" r="3.5"></circle><circle class="hdot" cx="170" cy="52" r="3.5"></circle><circle class="hdot" cx="156" cy="68" r="3.5"></circle>
</svg>`;

/** Six phones, each one's predictions reaching the others. */
const NETWORK = () => html`<svg class="hw" viewBox="0 0 320 130" role="img" aria-label="A network of phones running the app, each listening to the others' predictions">
  <path class="hout" d="M60 35L160 22L260 35L260 95L160 108L60 95ZM60 35L260 95M260 35L60 95M160 22L160 108M60 35L160 108M260 35L160 108M60 95L160 22M260 95L160 22"></path>
  <rect class="dev" x="49" y="17" width="22" height="36" rx="4"></rect><path d="M57 48h6"></path>
  <rect class="dev" x="149" y="4" width="22" height="36" rx="4"></rect><path d="M157 35h6"></path>
  <rect class="dev" x="249" y="17" width="22" height="36" rx="4"></rect><path d="M257 48h6"></path>
  <rect class="dev" x="49" y="77" width="22" height="36" rx="4"></rect><path d="M57 108h6"></path>
  <rect class="dev" x="149" y="90" width="22" height="36" rx="4"></rect><path d="M157 121h6"></path>
  <rect class="dev" x="249" y="77" width="22" height="36" rx="4"></rect><path d="M257 108h6"></path>
</svg>`;

/** Phones sending predictions to the contract (a block on the chain), each with its reward (a coin) on its screen. */
const CONTRACT = () => html`<svg class="hw" viewBox="0 0 320 130" role="img" aria-label="Phones send predictions to the Satori smart contract, which scores them and pays rewards back">
  <defs><marker id="how-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto"><path class="hhead" d="M2 1.5l6 3.5-6 3.5"></path></marker></defs>
  <path class="hout" marker-end="url(#how-arrow)" d="M68 36L116 53"></path>
  <path class="hout" marker-end="url(#how-arrow)" d="M68 94L116 77"></path>
  <path class="hout" marker-end="url(#how-arrow)" d="M252 36L204 53"></path>
  <path class="hout" marker-end="url(#how-arrow)" d="M252 94L204 77"></path>
  <path class="hblock" d="M160 22l36 20v42l-36 20-36-20V42z"></path>
  <path class="hblock" d="M124 42l36 20 36-20M160 62v42"></path>
  <rect class="dev" x="40" y="14" width="22" height="38" rx="4"></rect><path d="M48 47h6"></path>
  <rect class="dev" x="40" y="76" width="22" height="38" rx="4"></rect><path d="M48 109h6"></path>
  <rect class="dev" x="258" y="14" width="22" height="38" rx="4"></rect><path d="M266 47h6"></path>
  <rect class="dev" x="258" y="76" width="22" height="38" rx="4"></rect><path d="M266 109h6"></path>
  <circle class="hcoin" cx="51" cy="31" r="5.5"></circle><circle class="hcoin" cx="51" cy="93" r="5.5"></circle>
  <circle class="hcoin" cx="269" cy="31" r="5.5"></circle><circle class="hcoin" cx="269" cy="93" r="5.5"></circle>
</svg>`;

/** Two people, the share icon between them. */
const SHARING = () => html`<svg class="hw" viewBox="0 0 320 120" role="img" aria-label="One person shares the app with another">
  <circle cx="64" cy="40" r="16"></circle><path d="M34 104a30 30 0 0 1 60 0"></path>
  <circle cx="256" cy="40" r="16"></circle><path d="M226 104a30 30 0 0 1 60 0"></path>
  <path class="hout" d="M104 64H130M190 64H216"></path>
  <path class="hhead" d="M208 58l8 6-8 6"></path>
  <g class="hshare"><circle cx="146" cy="64" r="8"></circle><circle cx="178" cy="42" r="8"></circle><circle cx="178" cy="86" r="8"></circle><path d="M153 60l18-14M153 68l18 14"></path></g>
</svg>`;

/** The phone (the app opened) on the left, the Game's pad (the nav's icon, big) on the right. */
const DAILY = () => html`<svg class="hw" viewBox="0 0 320 120" role="img" aria-label="Open the app on your phone, or play the game">
  <rect class="dev" x="48" y="14" width="44" height="92" rx="8"></rect>
  <path d="M65 97h10"></path>
  <path class="hnet" d="M60 42l20 10-14 16zM60 42l6 26"></path>
  <circle class="hdot" cx="60" cy="42" r="3.5"></circle><circle class="hdot" cx="80" cy="52" r="3.5"></circle><circle class="hdot" cx="66" cy="68" r="3.5"></circle>
  <g transform="translate(197 4) scale(4.4)">
    <path class="dev" vector-effect="non-scaling-stroke" d="M7 7h10a5 5 0 0 1 4.9 6l-.6 3a2.5 2.5 0 0 1-4.3 1.2L15 15H9l-2 2.2A2.5 2.5 0 0 1 2.7 16l-.6-3A5 5 0 0 1 7 7z"></path>
    <path vector-effect="non-scaling-stroke" d="M7.5 9.5v4M5.5 11.5h4"></path>
    <circle class="hdot" cx="16" cy="10.6" r="0.85"></circle><circle class="hdot" cx="18" cy="12.6" r="0.85"></circle>
  </g>
</svg>`;

export function howCard() {
  return html`
    <details class="tile how-tile" data-test="how">
      <summary>How Does This Work?</summary>
      <div class="how">
        <h3 class="how-q">What is Satori?</h3>
        <p class="how-a">A network of AI agents incentivized to predict the future for all humanity.</p>
        ${APP()}
        <p>This app listens to real world datastreams, makes unique models and broadcasts predictions of them.</p>
        ${NETWORK()}
        <p>Other apps on the Satori network listen to those predictions which help better inform their own predictions, improving the accuracy of the entire network.</p>
        ${CONTRACT()}
        <p>The predictions get scored and you get rewarded based on how accurate those predictions are.</p>
        ${SHARING()}
        <p>Sharing this app with others grows the network and provides more rewards.</p>
        ${DAILY()}
        <p class="how-a">Just open the app every day to predict automatically, or play the game.</p>
      </div>
    </details>`;
}
