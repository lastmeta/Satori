// The Game tab's flow (docs/design/base.md#the-game), pure: which streams it shows and in what order, when Submit
// shows early, the chart's line and the latest value's words. src/ui/game.js draws it; main.js keeps its state.
import { fmtNum } from './format.js';

const WAIT = { DuplicatePrediction: 'already predicted in the last 24 hours', AlreadyPredicted: 'already predicted this round' };

/**
 * Already predicted (this round, or in the last 24 hours: the app's own batch, say): played as if nothing were wrong,
 * and on Submit not sent, just done (owner, 2026-10-25: it doesn't matter, and must not confuse).
 */
export const played = (s) => s.blocked in WAIT;

/**
 * The streams to play, in order: the playable ones (not `blocked`, or only already played), favorites first in the
 * order they were starred, then the rest by the game's voting weight, the most rewarding first.
 */
export function queueOf(streams, favorites = []) {
  const playable = streams.filter((s) => !s.blocked || played(s));
  const fav = favorites.map((id) => playable.find((s) => s.streamId === id)).filter(Boolean);
  const rest = playable.filter((s) => !favorites.includes(s.streamId))
    .sort((a, b) => (BigInt(b.weight) > BigInt(a.weight) ? 1 : BigInt(b.weight) < BigInt(a.weight) ? -1 : a.streamId - b.streamId));
  return [...fav, ...rest];
}

/** How many of the queue's first streams are favorites. */
export const favoritesIn = (queue, favorites = []) => queue.filter((s) => favorites.includes(s.streamId)).length;

/** Submit shows under the buttons once every favorite (more than one) has been shown and something was predicted. */
export const submitEarly = ({ index, favorites, picks }) => favorites > 1 && index >= favorites && picks > 0;

/**
 * A Sentiment stream's reading: its direction and change against the reading before, never the counter itself
 * (the dapp's leanLabel, satori-ui/src/lib/leanFormat.ts: the series is signed, so it divides by |prev|).
 */
export function leanLabel(value, prev) {
  const base = prev ?? 0;
  if (base === 0) return value > 0 ? '▲ up' : value < 0 ? '▼ down' : '— flat';
  const pct = ((value - base) / Math.abs(base)) * 100;
  if (pct === 0) return '— unchanged';
  return pct > 0 ? `▲ +${pct.toFixed(1)}%` : `▼ −${Math.abs(pct).toFixed(1)}%`;
}

/** The latest value as the game shows it, above the chart: a Sentiment stream's lean, else the number. */
export function latestText(stream) {
  const h = stream?.history ?? [];
  if (!h.length) return '';
  const last = Number(h.at(-1).value);
  return stream.named ? leanLabel(last, h.length > 1 ? Number(h.at(-2).value) : undefined) : fmtNum(last);
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
