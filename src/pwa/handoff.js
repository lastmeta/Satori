// What the app and the service worker share for the daily push's wake (docs/design/push.md, src/pwa/wake.js), in
// IndexedDB satori/app: the handoff the app leaves, the batch the worker sent, and the lock either holds while it works
// out and sends a batch.
export const HANDOFF = 'push-handoff';
export const SW_BATCH = 'push-batch'; // { base_pending_batch?, base_last_batch? }
export const BATCH_LOCK = 'satori-batch';

/** fn() under BATCH_LOCK (waiting for it), or at once where there are no Web Locks (tests). */
export const withBatchLock = (fn) => (globalThis.navigator?.locks ? navigator.locks.request(BATCH_LOCK, fn) : fn());

/** The app's db, as runBatch uses it, over the worker's batch record. */
export function batchDb(get, put) {
  return {
    get: async (k) => (await get(SW_BATCH))?.[k] ?? null,
    set: async (k, v) => put(SW_BATCH, { ...(await get(SW_BATCH)), [k]: v }),
    checkpoint: async () => {},
  };
}

/**
 * The app's side, before each check (under BATCH_LOCK): a batch the worker sent becomes the app's own pending or last
 * batch, and the worker's record is cleared.
 */
export async function adopt({ get, put, db }) {
  const r = await get(SW_BATCH);
  if (!r) return false;
  if (r.base_pending_batch && !(await db.get('base_pending_batch'))) await db.set('base_pending_batch', r.base_pending_batch);
  const last = await db.get('base_last_batch');
  if (r.base_last_batch && !(last?.round >= r.base_last_batch.round)) await db.set('base_last_batch', r.base_last_batch);
  await put(SW_BATCH, null);
  return true;
}
