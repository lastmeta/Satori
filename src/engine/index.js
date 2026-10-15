// The engine: fit a straight line (ordinary least squares) to equally spaced
// values and evaluate it `steps` points past the last one. Pure function.
// Non-finite values are dropped; no values → null; one value → that value.

/** @param {ArrayLike<number>} values oldest first @param {number} [steps] */
export function predict(values, steps = 1) {
  const y = Array.from(values).filter(Number.isFinite);
  const n = y.length;
  if (n === 0) return null;
  if (n === 1) return y[0];
  const mx = (n - 1) / 2;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (y[i] - my);
    sxx += (i - mx) ** 2;
  }
  return my + (sxy / sxx) * (n - 1 + steps - mx);
}
