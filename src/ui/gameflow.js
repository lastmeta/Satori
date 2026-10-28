// The Game tab's flow (docs/design/base.md#the-game), pure: which streams it shows and in what order, when Submit
// shows early, the chart's line and the latest value's words. src/ui/game.js draws it; main.js keeps its state.
import { fmtNum } from './format.js';

const WAIT = { DuplicatePrediction: 'already predicted in the last 24 hours', AlreadyPredicted: 'already predicted this round' };

/**
 * Already predicted (this round, or in the last 24 hours: the app's own batch, say): played as if nothing were wrong,
 * and on Submit not sent, just done (owner, 2026-10-25: it doesn't matter, and must not confuse).
 */
export const played = (s) => s.blocked in WAIT;

const byWeight = (a, b) => (BigInt(b.weight) > BigInt(a.weight) ? 1 : BigInt(b.weight) < BigInt(a.weight) ? -1 : a.streamId - b.streamId);
const favFirst = (list, favorites) => [...favorites.map((id) => list.find((s) => s.streamId === id)).filter(Boolean),
  ...list.filter((s) => !favorites.includes(s.streamId)).sort(byWeight)];

/**
 * The streams to play, in order: the playable ones (not `blocked`, or only already played). The reward-eligible ones
 * (voting weight > 0) first: favorites as starred, then by weight, the most rewarding first; then the ineligible ones,
 * favorites first. → { queue, split } (split: how many are eligible; the submit screen comes between the two)
 */
export function queueOf(streams, favorites = []) {
  const playable = streams.filter((s) => !s.blocked || played(s));
  const eligible = favFirst(playable.filter((s) => BigInt(s.weight) > 0n), favorites);
  return { queue: [...eligible, ...favFirst(playable.filter((s) => BigInt(s.weight) === 0n), favorites)], split: eligible.length };
}

/**
 * One move (dir 1: on, -1: back) from where the player is: { screen: 'play' | 'submit', index } (index: the stream
 * shown, or on the submit screen the one that comes next), or null (nothing there). The submit screen sits after the
 * eligible streams and again after the last; from it the player goes on to the rest.
 */
export function stepOf({ screen, index, length, split }, dir) {
  const gate = split > 0 && split < length; // the eligible streams, then a submit screen, then the ineligible ones
  if (dir > 0) {
    if (screen === 'submit') return index < length ? { screen: 'play', index } : null;
    const i = index + 1;
    return i >= length || (gate && i === split) ? { screen: 'submit', index: i } : { screen: 'play', index: i };
  }
  if (screen === 'submit') return index > 0 ? { screen: 'play', index: index - 1 } : null;
  if (gate && index === split) return { screen: 'submit', index };
  return index > 0 ? { screen: 'play', index: index - 1 } : null;
}

/** How many of the queue's first streams are favorites. */
export const favoritesIn = (queue, favorites = []) => queue.filter((s) => favorites.includes(s.streamId)).length;

/**
 * Submit shows under the buttons once something was predicted and either every favorite (more than one) has been
 * shown, or the player went on past the submit screen (the ineligible streams).
 */
export const submitEarly = ({ index, favorites, picks, split = 0 }) => picks > 0 && ((favorites > 1 && index >= favorites) || (split > 0 && index >= split));

/**
 * The latest value as the game shows it, above the chart: the number, Sentiment streams too (the owner, 2026-10-26), in
 * the stream's own units: the chain keeps an integer with the adapter's `decimals` after the point (`display`; a
 * Sentiment stream's 18: 999999228392505300 is 0.999999).
 */
export function latestText(stream) {
  const h = stream?.history ?? [];
  return h.length ? fmtNum(Number(h.at(-1).value) / 10 ** (stream.display?.decimals ?? 0)) : '';
}

/** The chart's line: SVG points in a w × h box, oldest on the left; flat when every value is the same. */
export function linePoints(history, w = 100, h = 100) {
  const v = history.map((x) => Number(x.value));
  if (!v.length) return '';
  if (v.length === 1) return `0,${h / 2} ${w},${h / 2}`;
  const lo = Math.min(...v);
  const span = Math.max(...v) - lo;
  const pad = h * 0.08;
  return v.map((x, i) => `${+(i * w / (v.length - 1)).toFixed(2)},${+(span ? pad + (h - 2 * pad) * (1 - (x - lo) / span) : h / 2).toFixed(2)}`).join(' ');
}

/** Nothing to play: why, calmly, with what to do (CLAUDE.md, waits aren't problems). */
export function nothingText(streams) {
  if (!streams.length) return 'No games on the Satori contract yet.';
  const why = streams.map((s) => s.blocked);
  if (why.every((w) => w === 'Delegated')) return "Your wallet is staked with another address, so it can't play here. Unstake on the Wallet tab to play.";
  return 'Unable to predict right now. Come back later.';
}

/**
 * When the player can predict again after a play (unix seconds): the earliest of its calls' streams to open. Each game
 * is once a round (from the next 00:00 UTC); a Sentiment (named) game also waits 24 clock hours from the hour it was
 * predicted in (the deployed engine's DuplicatePrediction: `hour < last + 24`, test/fake-satori.js). No calls: the next round.
 */
export function opensAgain(sent, streams = []) {
  const next = (sent.round + 1) * 86_400;
  const named = (id) => streams.find((s) => s.streamId === id)?.named;
  const day = (Math.floor(sent.at / 3600) + 24) * 3600;
  const each = (sent.calls ?? []).map((c) => (named(c.streamId) ? Math.max(next, day) : next));
  return each.length ? Math.min(...each) : next;
}

/** The countdown to `at` from `now` (unix seconds): 'You can predict again in 7 h 12 min.' */
export function againText(at, now) {
  const m = Math.ceil((at - now) / 60);
  if (m <= 0) return 'You can predict again now.';
  return `You can predict again in ${m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`}.`;
}
