// The engine: fit a straight line (ordinary least squares) to [x, y] points and
// evaluate it at x = `at`. x is time, so gaps in the series are gaps on the
// line. Pure function. Points with a non-finite x or y are dropped. No points
// or a non-finite result → null; one point (or one distinct x) → the mean.

/** @param {Iterable<[number, number]>} points @param {number} at */
export function predict(points, at) {
  const p = Array.from(points).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = p.length;
  if (n === 0) return null;
  // Centre on the last point: keeps precision for epoch-ms x and large y.
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
