// Against no change: one rule and one set of words for the Models tab's backtests (src/neuron/models.js) and the
// prediction streams' track records (src/neuron/records.js; docs/design/models.md#quality-against-no-change,
// docs/design/track-record.md). Pure, and kept apart so the Nostr flow can use it without the Models tab's imports.
import { MARGIN } from '../engine/evolve.js';

/** Within ±5 % of no change's error is a tie: the margin evolution keeps a challenger by (src/engine/evolve.js). */
export const TIE = MARGIN;

export const classify = (ratio) => (ratio < 1 - TIE ? 'better' : ratio > 1 + TIE ? 'worse' : 'tie');

/**
 * The mark in short words (the owner, 2026-10-18: a symbol beside an icon was not read): '7% better', 'Same as no
 * change', '12% worse' ('Worse' when no change was perfect), 'Not scored yet'. The list row, the drill-in's header and
 * the status's legend say the same.
 */
export function markWords({ mark, ratio }) {
  if (mark == null) return 'Not scored yet';
  if (mark === 'tie') return 'Same as no change';
  if (ratio == null) return mark === 'worse' ? 'Worse' : 'Better';
  return mark === 'better' ? `${Math.round((1 - ratio) * 100)}% better` : `${Math.round((ratio - 1) * 100)}% worse`;
}
export const worded = (q) => ({ ...q, text: markWords(q) });

/**
 * A model against no change, from its backtest: score (its median error) and persist (no change's, on the same
 * origins). ratio = score / persist; better below 0.95, worse above 1.05, else a tie. naive is no change itself: a
 * tie. No backtest yet (fewer than 5 origins), or no model (an echoed value): mark null.
 * @returns {{mark: 'better'|'tie'|'worse'|null, ratio: number|null, error: number|null, noChange: number|null, text: string}}
 */
export function qualityOf({ kind, score = null, persist = null }) {
  if (kind === 'naive') return worded({ mark: 'tie', ratio: 1, error: null, noChange: null });
  if (score == null || persist == null || kind === 'echo') return worded({ mark: null, ratio: null, error: score ?? null, noChange: persist ?? null });
  if (!(persist > 0)) {
    return worded(score > 0 ? { mark: 'worse', ratio: null, error: score, noChange: persist } : { mark: 'tie', ratio: 1, error: score, noChange: persist });
  }
  const ratio = score / persist;
  return worded({ mark: classify(ratio), ratio, error: score, noChange: persist });
}
