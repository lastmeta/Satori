// A stream's window, the one definition (docs/design/nostr.md#data-growth): the intake, the training pass, the Models
// tab and the prune (src/db, in SQL) all read and keep the same span, so the prune never deletes what another reads.
export const DEFAULT_CADENCE_S = 86_400; // a stream that announces none: a day, the owner's default (docs/intent/engine.md)
/**
 * The engine's window for a relay stream, in its cadences: read only this much back from the stream's newest
 * observation, and the daily prune keeps no more (a daily stream ~400 days; a 1-minute one ~7 h). The engine needs 6
 * lag pairs and 28 backtest origins.
 */
export const RELAY_WINDOW = 400;
/** A stream's cadence in seconds: its own when above 0, else the default. */
export const cadenceOf = (seconds) => (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_CADENCE_S);
