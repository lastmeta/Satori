// The activity log's writer (docs/design/health.md#the-activity-log): what the
// neuron did, for Home's health. Sessions (a page load, and a wake after the
// page did not run), with a heartbeat; one row per central cycle; Base checks,
// the same skip or error merged into one row; Nostr publishes merged per hour;
// history runs, wallet actions, errors. Kept 90 days. A write that fails is
// logged, never thrown: the neuron goes on.
import { serial } from '../util.js';
import { DAYS, FIXABLE_SKIPS, HEARTBEAT_S, KEEP_S, SLEEP_S, isGood, missedBy } from './health.js';

const LOAD_S = (DAYS + 1) * 86400; // what health reads: the day strip's 30 days and the feed
const QUIET_SKIPS = /^(already predicted|waiting for the batch)/; // a round already done, or in flight: not news

/**
 * @param {{db: object, now?: () => number, onChange?: () => void}} o
 * → { start, beat, rows, first, central, history, base, published, wallet, error }
 */
export function createActivity({ db, now = () => Date.now() / 1000, onChange = () => {} }) {
  let rows = []; // the last LOAD_S, oldest first, as db.activity() returns them
  let session = null; // the current `open` row
  let first = null; // when the log's first session began (the rows read hold only the last 31 days)
  let catchUp = null; // a session that missed work: its gap, until its first good cycle
  let lastTick = 0;
  let pruned = 0;
  const line = serial();
  const safely = (fn) => (...args) => line(() => fn(...args)).catch((err) => console.warn('[satori] activity', err));

  async function add(kind, level, data, { at = now(), until = null, mkey = null } = {}) {
    const r = { at, until, kind, level, data, count: 1, mkey };
    r.id = await db.addActivity(r);
    rows.push(r);
    onChange();
    return r;
  }

  async function update(r, fields) {
    await db.updateActivity(r.id, fields);
    Object.assign(r, fields);
    onChange();
  }

  /** Into the latest row of `kind` when it has the same key (count + 1, until now); else a new row. */
  async function merge(kind, level, data, mkey, combine = (_, d) => d) {
    const last = rows.findLast((r) => r.kind === kind);
    if (last && last.mkey === mkey) return update(last, { until: now(), count: last.count + 1, data: combine(last.data, data), level });
    return add(kind, level, data, { mkey, until: now() });
  }

  async function openSession() {
    const at = now();
    const { missed, gap } = missedBy(rows, at);
    session = await add('open', missed ? 'idle' : 'ok', { gap, missed }, { at, until: at });
    catchUp = missed ? gap : null;
    lastTick = at;
  }

  async function prune() {
    pruned = now();
    await db.pruneActivity(pruned - KEEP_S);
    rows = rows.filter((r) => (r.until ?? r.at) >= pruned - LOAD_S);
  }

  return {
    rows: () => rows,

    /** When the log's first session began (unix seconds; null before start): the neuron's first day. */
    first: () => first,

    /** At page load: the log's first session, the 90-day prune, the rows health reads, a session. */
    start: safely(async () => {
      first = await db.firstSession();
      await prune();
      rows = await db.activity(now() - LOAD_S);
      await openSession();
      first ??= session.at;
    }),

    /**
     * Every ~30 s: the session's heartbeat (written each 5 min); after a tick more than 15 min late, the page did not
     * run, so that session ends where it last ran and another starts; the daily prune.
     */
    beat: safely(async () => {
      if (!session) return;
      const t = now();
      if (now() - pruned > 86400) await prune();
      if (t - lastTick > SLEEP_S) {
        if (session.until !== lastTick) await update(session, { until: lastTick });
        await openSession();
        return;
      }
      lastTick = t;
      if (t - session.until >= HEARTBEAT_S) await update(session, { until: t });
    }),

    /** A central cycle ({ poll, submit }, as cycle() returns it) and the queue after it. */
    central: safely(async ({ poll, submit }, pending = 0) => {
      const data = { streams: poll.streams ?? 0, new: poll.new ?? 0, predicted: poll.predicted ?? 0,
        sent: submit?.total_submitted ?? 0, accepted: submit?.successful ?? 0, pending };
      const error = poll.error ?? submit?.error;
      if (error) data.error = error;
      if (submit?.login) data.login = true;
      if (poll.local) data.local = true;
      const good = isGood({ kind: 'central', data });
      if (good && catchUp != null) {
        data.caughtUp = catchUp;
        catchUp = null;
      }
      await add('central', good ? 'ok' : 'bad', data, { at: poll.at });
    }),

    /** A history run (backfillHistory's result): one that loaded streams, or failed (not a central without the route). */
    history: safely(async (r) => {
      if (r?.streams > 0 && !r.error) return void (await add('history', 'ok', { streams: r.streams, rows: r.rows }));
      if (r?.error && !r.retryAt) await add('history', 'warn', { streams: r.streams ?? 0, rows: r.rows ?? 0, error: r.error });
    }),

    /** A Base batch check's result (base.js check()). */
    base: safely(async (r) => {
      if (r?.sent) {
        const { round, hash, games, dropped = [] } = r.sent;
        return void (await add('base', 'ok', { round, hash, games: games.map((g) => g.gameId), dropped: dropped.map((g) => g.gameId) }));
      }
      if (r?.skipped) {
        if (QUIET_SKIPS.test(r.skipped)) return;
        const level = FIXABLE_SKIPS.test(r.skipped) ? 'warn' : 'idle';
        return void (await merge('base', level, { round: r.round ?? null, skipped: r.skipped }, `skip:${r.skipped.split(':')[0]}`));
      }
      if (r?.error) await merge('base', 'bad', { round: r.round ?? null, error: r.error }, `error:${r.error.slice(0, 120)}`);
    }),

    /** A `_pred` a relay took. */
    published: safely(async () => {
      await merge('nostr', 'ok', { published: 1 }, `h:${Math.floor(now() / 3600)}`, (old, d) => ({ published: old.published + d.published }));
    }),

    /** Delegate, Stop delegating, Claim, Send: what was done, in a few words. */
    wallet: safely(async (action, text) => { await add('wallet', 'ok', { action, text }); }),

    /** An engine or database failure outside central's cycle. */
    error: safely(async (where, err) => { await add('error', 'bad', { where, message: String(err?.message ?? err) }); }),
  };
}
