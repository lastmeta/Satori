// Why a batch check (base.js runBatch) sent nothing: `skip` on its result is the one thing other code reads (activity,
// health, the push's wake); `skipped` is its words, for people only.
export const SKIP = Object.freeze({
  stuckCeiling: 'stuck-ceiling', stuckRetry: 'stuck-retry', pending: 'pending', unstaked: 'unstaked', predicted: 'predicted',
  noGames: 'no-games', noPass: 'no-pass', byHand: 'by-hand', gasCeiling: 'gas-ceiling',
});
/** Done, in flight, or by hand: not news (activity). */
export const QUIET_SKIPS = new Set([SKIP.predicted, SKIP.pending, SKIP.byHand]);
/** The person can fix it (health's base-skipped, a warn in activity). */
export const FIXABLE_SKIPS = new Set([SKIP.gasCeiling, SKIP.noPass]);
