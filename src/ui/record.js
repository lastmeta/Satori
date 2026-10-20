// The Streams tab's Prediction streams card (docs/design/track-record.md#ui-streams): the status line, the groups by
// source, a row and a stream's detail, from records() / record() data (src/neuron/records.js). Pure, so they are tested without a page;
// streams.js places them. The pill is the Models tab's (its colours and words).
import { fmtNum, fmtWhen, fmtCadence, shortKey, sparkPath } from './format.js';
import { MIN_SCORED, compareRecords } from '../neuron/records.js';

export const SHOWN = 25; // rows before "Show all"
const COUNTS = 'It counts only predictions this neuron received before the outcome.';
const OWN = 'predicts its own stream';
const NOT_ANNOUNCED = 'not announced';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sourceName = (r) => r.source?.name || r.source?.stream || r.stream;
const byText = (r) => (r.mine ? 'you' : shortKey(r.pubkey));

/** The record against no change in words: '12% less error than no change', 'about the same as no change', … */
function againstText(r) {
  if (r.mark === 'better') return `${Math.round((1 - r.ratio) * 100)}% less error than no change`;
  if (r.mark === 'worse') return r.ratio == null ? 'More error than no change (no change was exact)' : `${Math.round((r.ratio - 1) * 100)}% more error than no change`;
  return 'About the same error as no change';
}

/**
 * The card's status line (nostr().watching, records()): before the first scan, then how many are watched (the list's
 * count once it is read, so the status, the rows and "Show all N" agree) and recorded; past the cap, how many the relays
 * have that are not watched.
 */
export function watchText(w, list) {
  if (!w || (!w.streams && w.at == null)) return w?.error ? `Not watching yet: ${w.error}` : 'Finding prediction streams…';
  const watched = list.length || w.streams;
  if (!watched) return 'No prediction streams on the relays yet.';
  const recorded = list.filter((r) => r.mark != null).length;
  const more = w.left > 0 ? ` (${w.left} more on the relays not watched)` : '';
  return `Watching ${plural(watched, 'prediction stream')}${more} · ${recorded ? `${recorded} with a record` : 'none with a record yet'}`;
}

/** The source in words: its name, its author's short key, "not announced" when it has no announcement of its own. */
const sourceText = (r) => `${sourceName(r)} by ${shortKey(r.source?.pubkey)}${r.source?.announced ? '' : ` (${NOT_ANNOUNCED})`}`;

/**
 * A row, under its source's header (recordGroups): the predictor ("you" or a short key; "predicts its own stream" when
 * its key is the source's author), the pill, from N (or how far: 3 of 5), the cadence; its title names the source and
 * its author.
 */
export function recordRow(r) {
  const scoredYet = r.mark != null;
  return {
    key: `${r.pubkey}:${r.stream}`, title: `Predictions for ${sourceText(r)}`, by: byText(r), byTitle: r.pubkey, mine: !!r.mine,
    own: r.sameAuthor ? OWN : '',
    mark: r.mark ?? 'none', markText: r.markText, markShort: r.mark === 'tie' ? 'Same' : r.markText,
    from: scoredYet ? `from ${r.scored}` : r.scored ? `${r.scored} of ${MIN_SCORED}` : '',
    cadence: fmtCadence(r.cadence_seconds),
    markTitle: scoredYet ? `${againstText(r)}, over the last ${plural(r.scored, 'prediction')} this neuron received before the outcome`
      : `Not scored yet: ${r.scored} of the ${MIN_SCORED} predictions it needs, received before their outcomes`,
  };
}

/**
 * The card's groups, one per source (a buyer picks the source first): its name (its own announcement's, else its stream
 * id), its author's short key, "not announced" when so; its prediction streams under it as rows, best first. Announced
 * sources first, then by each one's best record, then by name: a perfect record against a source nobody announced comes
 * after the announced ones, its author in view.
 * @param {object[]} list records()
 */
export function recordGroups(list) {
  const by = new Map();
  for (const r of list) {
    const key = `${r.source?.pubkey}:${r.source?.stream}`;
    (by.get(key) ?? by.set(key, { key, first: r, list: [] }).get(key)).list.push(r);
  }
  const groups = [...by.values()].map(({ key, list: rs }) => {
    const sorted = [...rs].sort(compareRecords);
    const r = sorted[0];
    return { key, best: r, name: sourceName(r), stream: r.source?.stream ?? '', by: shortKey(r.source?.pubkey), byTitle: r.source?.pubkey ?? '',
      announced: !!r.source?.announced, note: r.source?.announced ? '' : NOT_ANNOUNCED, rows: sorted.map(recordRow) };
  });
  groups.sort((a, b) => (b.announced - a.announced) || compareRecords(a.best, b.best) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return groups.map(({ best, ...g }) => g);
}

/** The first `n` rows across the groups, in order (a group cut where the limit falls). */
export function firstRows(groups, n) {
  const out = [];
  let left = n;
  for (const g of groups) {
    if (left <= 0) break;
    out.push(g.rows.length <= left ? g : { ...g, rows: g.rows.slice(0, left) });
    left -= g.rows.length;
  }
  return out;
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

/**
 * A stream's detail: who and how often, its source (its name and stream id, its author, "not announced", or that the
 * predictor is its author: "predicts its own stream"), the record in plain words, the direction, since when and what it
 * counts, the chart.
 */
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
    source: `Source: ${sourceName(r)}${r.source?.stream && sourceName(r) !== r.source.stream ? ` (${r.source.stream})` : ''} by `
      + `${shortKey(r.source?.pubkey)}${r.source?.announced ? '' : `, ${NOT_ANNOUNCED}`}${r.sameAuthor ? `: it ${OWN}` : ''}`,
    mark: r.mark ?? 'none', markText: r.markText, lines,
    note: r.since != null ? `Seen by this neuron since ${fmtWhen(r.since)}. ${COUNTS}` : COUNTS,
    chart: recordChart(r.pairs),
  };
}
