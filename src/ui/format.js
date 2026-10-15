// Small display helpers.

export function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumFractionDigits: a >= 1 ? 4 : 6 });
}

export function fmtTime(ms) {
  if (ms == null) return '–';
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** SVG polyline points for values in a w×h box (y grows down). */
export function sparkPoints(values, w = 100, h = 24) {
  if (values.length < 2) return '';
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const pad = 2;
  return values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = values.every((u) => u === lo) ? h / 2 : pad + (1 - (v - lo) / span) * (h - 2 * pad);
    return `${+x.toFixed(2)},${+y.toFixed(2)}`;
  }).join(' ');
}

/** n distinct sorted random indexes in [0, max). */
export function pickIndexes(n, max, rand = Math.random) {
  const s = new Set();
  while (s.size < n) s.add(Math.floor(rand() * max));
  return [...s].sort((a, b) => a - b);
}
