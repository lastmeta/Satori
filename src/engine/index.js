// The engine. Its interface, which step 4 keeps while replacing the model:
//   forecast(points) → { model, t1, t2 } | null
// points: [{ ts, value }] oldest first (ts in unix seconds). t1 is the next
// step; t2 the step after, forecast again with t1 appended, as Satori Lite's
// engine does (engine.py:1153-1186). Pure functions.
//
// Step 3's model: a least-squares line over the last WINDOW values, by step.

export const WINDOW = 20;
export const MODEL = `ols-${WINDOW}`;

/** @param {{ts: number, value: number}[]} points */
export function forecast(points) {
  const ys = Array.from(points, (p) => p.value).filter(Number.isFinite).slice(-WINDOW);
  const next = (v) => predict(v.map((y, i) => [i, y]), v.length);
  const t1 = next(ys);
  if (t1 === null) return null;
  return { model: MODEL, t1, t2: next([...ys, t1]) ?? t1 };
}

/**
 * The least-squares line through [x, y] points, evaluated at x = `at`. Points
 * with a non-finite x or y are dropped. No points or a non-finite result →
 * null; one point (or one distinct x) → the mean.
 * @param {Iterable<[number, number]>} points @param {number} at
 */
export function predict(points, at) {
  const p = Array.from(points).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = p.length;
  if (n === 0) return null;
  // Centre on the last point: keeps precision for large x and y.
  const [x0, y0] = p[n - 1];
  let mx = 0;
  let my = 0;
  for (const [x, y] of p) {
    mx += (x - x0) / n;
    my += (y - y0) / n;
  }
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of p) {
    sxy += (x - x0 - mx) * (y - y0 - my);
    sxx += (x - x0 - mx) ** 2;
  }
  const r = y0 + my + (sxx ? (sxy / sxx) * (at - x0 - mx) : 0);
  return Number.isFinite(r) ? r : null;
}
