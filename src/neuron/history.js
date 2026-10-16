// Central's history (docs/design/central.md#history-an-addition-beyond-lite):
// each central stream's past, fetched once, so `bvar` has aligned history from
// the first poll instead of after days of polls. Backfilled rows are stored
// older than the stream's newest polled row only, so they never trigger a
// prediction: only a poll's new row does, as in Lite.
import { normalizeObservation } from '../central/index.js';

export const HISTORY_LIMIT = 1000; // the route's maximum
export const HISTORY_SPAN_S = HISTORY_LIMIT * 3600; // since = 1,000 h ago: central observes hourly, so the last ~41 days
export const HISTORY_CONCURRENCY = 4;
export const HISTORY_RETRY_S = 86_400; // a 404 (this central has no such route): try again a day later

const nowS = () => Date.now() / 1000;
const errorText = (err) => String(err?.message ?? err);

/**
 * Fetch the history of every central stream that has none yet (a stream first
 * seen, or every stream after an update), at most 4 calls at a time. The first
 * failure stops the run, and the rest wait for the next one; a 404 means the
 * route is missing, remembered for a day per central. Never throws.
 * @returns {Promise<{at, url, streams, rows, left, error, retryAt} | null>} also kept in meta.central_history
 */
export async function backfillHistory({ db, central, now = nowS }) {
  try {
    const at = now();
    const last = await db.get('central_history');
    if (last?.url === central.url && last.retryAt > at) return last;
    const todo = await db.needHistory();
    if (!todo.length) return last ?? null;
    const queue = [...todo];
    let streams = 0;
    let rows = 0;
    let failure = null;
    const worker = async () => {
      while (queue.length && !failure) {
        const uuid = queue.shift();
        try {
          const list = await central.history(uuid, { limit: HISTORY_LIMIT, since: Math.floor(at) - HISTORY_SPAN_S });
          if (!Array.isArray(list)) throw new Error('central sent no list of observations');
          const clean = list.map((o) => normalizeObservation({ ...o, stream_uuid: o?.stream_uuid || uuid }))
            .filter((o) => o?.stream_uuid === uuid);
          const added = await db.addHistory(uuid, clean, Math.floor(now())); // not `rows += await`: the calls overlap
          rows += added;
          streams++;
        } catch (err) {
          failure ??= err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(HISTORY_CONCURRENCY, todo.length) }, worker));
    const result = { at, url: central.url, streams, rows, left: todo.length - streams, error: failure ? errorText(failure) : null,
      retryAt: failure?.status === 404 ? at + HISTORY_RETRY_S : null };
    await db.set('central_history', result);
    await db.checkpoint();
    return result;
  } catch (err) {
    console.error('[satori] history', err);
    return { error: errorText(err) };
  }
}
