// The Streams tab's Prediction streams card (docs/design/track-record.md#ui-streams): the status line, a row and a
// stream's detail, from records() / record() data (src/neuron/records.js). Pure, so they are tested without a page;
// streams.js places them. The pill is the Models tab's (its colours and words).
import { fmtNum, fmtWhen, fmtCadence, shortKey, sparkPath } from './format.js';
import { MIN_SCORED } from '../neuron/records.js';

export const SHOWN = 25; // rows before "Show all"
const COUNTS = 'It counts only predictions this neuron received before the outcome.';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sourceName = (r) => r.source?.name || r.source?.stream || r.stream;
const byText = (r) => (r.mine ? 'you' : shortKey(r.pubkey));

/** The record against no change in words: '12% less error than no change', 'about the same as no change', … */
function againstText(r) {
  if (r.mark === 'better') return `${Math.round((1 - r.ratio) * 100)}% less error than no change`;
  if (r.mark === 'worse') return r.ratio == null ? 'More error than no change (no change was exact)' : `${Math.round((r.ratio - 1) * 100)}% more error than no change`;
  return 'About the same error as no change';
}

/** The card's status line (nostr().watching, records()): before the first scan, then how many are watched and recorded. */
export function watchText(w, list) {
  if (!w || (!w.streams && w.at == null)) return w?.error ? `Not watching yet: ${w.error}` : 'Finding prediction streams…';
  if (!w.streams) return 'No prediction streams on the relays yet.';
  const recorded = list.filter((r) => r.mark != null).length;
  const more = w.left > 0 ? ` (the newest announced; ${w.left} more not watched)` : '';
  return `Watching ${plural(w.streams, 'prediction stream')}${more} · ${recorded ? `${recorded} with a record` : 'none with a record yet'}`;
}

/** A row: "Predictions for <the source>", the predictor, the pill, from N (or how far: 3 of 5), the cadence. */
export function recordRow(r) {
  const scoredYet = r.mark != null;
  return {
    key: `${r.pubkey}:${r.stream}`, title: `Predictions for ${sourceName(r)}`, by: byText(r), byTitle: r.pubkey, mine: !!r.mine,
    mark: r.mark ?? 'none', markText: r.markText, markShort: r.mark === 'tie' ? 'Same' : r.markText,
    from: scoredYet ? `from ${r.scored}` : r.scored ? `${r.scored} of ${MIN_SCORED}` : '',
    cadence: fmtCadence(r.cadence_seconds),
    markTitle: scoredYet ? `${againstText(r)}, over the last ${plural(r.scored, 'prediction')} this neuron received before the outcome`
      : `Not scored yet: ${r.scored} of the ${MIN_SCORED} predictions it needs, received before their outcomes`,
  };
}

/** The pairs (record()'s) as two lines on one scale: the outcomes, and the predictions (drawn dashed); null below two. */
export function recordChart(pairs, { w = 300, h = 80 } = {}) {
  if (!pairs || pairs.length < 2) return null;
  const actual = pairs.map((x) => x.actual);
  const predicted = pairs.map((x) => x.predicted);
  const range = [Math.min(...actual, ...predicted), Math.max(...actual, ...predicted)];
  return { w, h, n: pairs.length, actual: sparkPath(actual, w, h, range), predicted: sparkPath(predicted, w, h, range),
    top: fmtNum(range[1]), bottom: fmtNum(range[0]) };
}

/** A stream's detail: who and how often, the record in plain words, the direction, since when and what it counts, the chart. */
export function recordDetail(r) {
  const lines = [];
  if (r.mark != null) {
    lines.push(`${againstText(r)} over the last ${plural(r.scored, 'prediction')} (median error ${fmtNum(r.error)}; no change ${fmtNum(r.noChange)})`);
  } else {
    lines.push(r.scored ? `Not scored yet: ${r.scored} of the ${MIN_SCORED} predictions it needs` : 'Not scored yet: no prediction received before its outcome so far');
  }
  if (r.direction?.total) lines.push(`Right way ${r.direction.right} of ${r.direction.total}`);
  return {
    title: `Predictions for ${sourceName(r)}`, sub: `${r.stream} by ${byText(r)} · every ${fmtCadence(r.cadence_seconds)}`,
    mark: r.mark ?? 'none', markText: r.markText, lines,
    note: r.since != null ? `Seen by this neuron since ${fmtWhen(r.since)}. ${COUNTS}` : COUNTS,
    chart: recordChart(r.pairs),
  };
}
