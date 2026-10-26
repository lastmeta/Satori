// How a model's forecasts did (docs/design/models.md#how-its-forecasts-did): each forecast this app made, beside the
// value that came at the time it was for, as the Prediction Streams card draws a record (src/ui/record.js recordChart).
// Pure: the drill-in reads the forecasts and the history, this pairs them.

export const OUTCOMES_N = 50; // the last 50 outcomes drawn

/**
 * Pairs of { ts, predicted, actual }, oldest first, the last `n`: for each forecast ({ at, value }: made at `at` for
 * `at + horizon`), the first observation at or after that time, if it came within half a horizon of it; an outcome
 * forecast more than once keeps the latest forecast made for it. Forecasts whose time has not come are left out.
 * @param {{ at: number, value: number }[]} forecasts
 * @param {{ ts: number, value: number }[]} history
 */
export function outcomePairs(forecasts, history, horizon, n = OUTCOMES_N) {
  const points = history.filter((p) => Number.isFinite(p.value)).sort((a, b) => a.ts - b.ts);
  const byOutcome = new Map();
  for (const f of [...forecasts].filter((x) => Number.isFinite(x.value)).sort((a, b) => a.at - b.at)) {
    const due = f.at + horizon;
    const i = firstAtOrAfter(points, due);
    if (i < 0 || points[i].ts - due > horizon / 2) continue;
    byOutcome.set(points[i].ts, { ts: points[i].ts, predicted: f.value, actual: points[i].value });
  }
  return [...byOutcome.values()].sort((a, b) => a.ts - b.ts).slice(-n);
}

function firstAtOrAfter(points, ts) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo < points.length ? lo : -1;
}
