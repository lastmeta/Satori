// The Nostr outbox (meta.nostr_outbox, docs/design/nostr.md): unsubscribes, tombstones and vouchers for relays we write
// to that were not open or did not answer, kept across reloads and sent when each opens.
//   const box = createOutbox({ db, writes })   // writes(e): we write to relay entry e
//   await box.keep(events, targets)             // kept for each target relay entry; then flush(e) for each
//   await box.flush(e)                          // what waits for e sent, if it is open; what it answered dropped
import { serial } from '../util.js';

export const OUTBOX_MAX = 100; // events waiting for each relay

/** The newest OUTBOX_MAX for each relay: one that never opens can't push out what waits for another. */
export function capEach(box, max = OUTBOX_MAX) {
  const left = new Map();
  return box.toReversed().filter((x) => {
    const n = left.get(x.url) ?? 0;
    left.set(x.url, n + 1);
    return n < max;
  }).reverse();
}

/**
 * The relay is done with it: OK, or a refusal that sending again won't change (NIP-01: duplicate, invalid, blocked,
 * pow, restricted). No answer, a lost connection, `rate-limited:` and `error:` are tried again.
 */
export const answered = (r) => r.ok || !(['not connected', 'timeout', 'disconnected'].includes(r.message) || /^(rate-limited|error):/.test(r.message ?? ''));

export function createOutbox({ db, writes }) {
  const line = serial();
  const edit = (fn) => line(async () => {
    await db.set('nostr_outbox', capEach(fn((await db.get('nostr_outbox')) ?? [])));
    await db.checkpoint();
  });
  return {
    async flush(e) {
      await line.idle();
      const mine = ((await db.get('nostr_outbox')) ?? []).filter((x) => x.url === e.url);
      if (!mine.length || e.relay?.state !== 'open' || !writes(e)) return;
      const results = await Promise.all(mine.map((x) => e.relay.publish(x.event)));
      const done = new Set(mine.filter((x, i) => answered(results[i])).map((x) => x.event.id));
      await edit((box) => box.filter((x) => !(x.url === e.url && done.has(x.event.id))));
    },
    keep: (events, targets) => edit((box) => [...box, ...targets.flatMap((e) => events.map((event) => ({ url: e.url, event })))]),
  };
}
