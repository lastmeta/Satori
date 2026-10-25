// One day on Home's strip, opened (docs/design/health.md#a-day-opened): when the app predicted, on the Satori Network
// and on the Satori contract, and how those predictions turned out. Pure; main.js reads the rows and the histories.
import { classify } from './quality.js';

const DAY_S = 86400;

/** A strip day ('2026-10-24', local) → [start, end) in unix seconds, local midnight to midnight. */
export function dayRange(date) {
  const [y, m, d] = date.split('-').map(Number);
  return [new Date(y, m - 1, d).getTime() / 1000, new Date(y, m - 1, d + 1).getTime() / 1000];
}

/**
 * A network prediction against no change: its 24 h forecast (t2) and no change (the stream's last value when it was
 * made) against the stream's first value 24 h on (up to a day late: a stream that stopped scores nothing).
 * obs: the stream's observations, oldest first, [{ ts, value }]. → 'better' | 'tie' | 'worse' | null (not yet)
 */
export function networkMark(p, obs) {
  const at = p.made_at + DAY_S;
  const base = obs.findLast((o) => o.ts <= p.made_at);
  const actual = obs.find((o) => o.ts >= at && o.ts < at + DAY_S);
  if (!base || !actual) return null;
  const err = Math.abs(p.t2 - actual.value);
  const none = Math.abs(base.value - actual.value);
  if (!(none > 0)) return err > 0 ? 'worse' : 'tie';
  return classify(err / none);
}

/**
 * A contract call as the engine scores it (SatoriEngine.sol, scoring: correct = post > anchor for up, post < anchor
 * for down; no move is wrong either way). A stream updated at most daily: the first two values after the prediction's
 * hour (B and C); else moment-anchored: the last value at or before that hour, and the first 24 h on.
 * call: { hour, direction: 'up' | 'down', cadenceMinutes }; history: [{ hour, value }], oldest first (the chain's ring).
 * → 'right' | 'wrong' | null (not landed yet, or rolled out of the ring)
 */
export function callResult(call, history) {
  const after = history.filter((v) => v.hour > call.hour);
  let anchor;
  let post;
  if (call.cadenceMinutes >= 24 * 60) [anchor, post] = after;
  else {
    anchor = history.findLast((v) => v.hour <= call.hour);
    post = history.find((v) => v.hour >= call.hour + 24);
  }
  if (!anchor || !post) return null;
  const [a, b] = [BigInt(anchor.value), BigInt(post.value)];
  return (call.direction === 'up' ? b > a : b < a) ? 'right' : 'wrong';
}

/**
 * The day, from what main.js read: the activity rows that touch it, its network predictions (each with its mark) and
 * its contract calls (each with its result). → { date, network, contract, open }
 */
export function dayOf({ date, rows, predictions }) {
  const [a, b] = dayRange(date);
  const inDay = (r) => r.at >= a && r.at < b;
  const sent = predictions.filter((p) => p.made_at >= a && p.made_at < b);
  const marks = { better: 0, tie: 0, worse: 0, waiting: 0 };
  for (const p of sent) marks[p.mark ?? 'waiting'] += 1;
  const times = sent.map((p) => p.made_at);
  const batches = rows.filter((r) => r.kind === 'base' && inDay(r) && r.level === 'ok' && r.data?.games);
  const skip = rows.findLast((r) => r.kind === 'base' && (r.at < b && (r.until ?? r.at) >= a) && (r.data?.skipped || r.data?.error));
  return {
    date,
    network: { sent: sent.length, first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null, marks },
    contract: {
      batches: batches.map((r) => ({ at: r.at, games: r.data.games.length, calls: r.data.calls ?? null })),
      skipped: batches.length ? null : skip?.data?.unused ? 'not staked with this app' : skip?.data?.skipped ?? skip?.data?.error ?? null,
    },
    open: rows.some((r) => r.kind === 'open' && r.at < b && (r.until ?? r.at) >= a),
  };
}
