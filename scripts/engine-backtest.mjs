// Walk-forward backtest of src/engine against always-naive.
// Usage: node scripts/engine-backtest.mjs [fixture.json ...]
// Fixture shape: { streams: [{ name, values: [number|string, ...] }] } (oldest first),
// e.g. test/fixtures/engine-base-histories.json from scripts/engine-fetch-histories.mjs.
// Synthetic series always run too, since real registry histories are short today.
import { existsSync, readFileSync } from 'node:fs';
import { clean, direction, DOWN, forecast } from '../src/engine/index.js';

const NODES = 5; // node keys to average over (the pick and window depend on the key)
const keys = Array.from({ length: NODES }, (_, j) => Uint8Array.from({ length: 33 }, (_, i) => (i * 31 + j * 97 + 7) & 255));

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}
function synthetic() {
  const n = 768, r = lcg(12345), gen = (f) => { const a = [100]; for (let i = 1; i < n; i++) a.push(f(a[i - 1], i)); return a; };
  return [
    { name: 'syn: random walk', values: gen((p) => p + gauss(r)) },
    { name: 'syn: price, GBM 3%/step', values: gen((p) => p * Math.exp(0.03 * gauss(r))) },
    { name: 'syn: walk + drift', values: gen((p) => p + 0.3 + gauss(r)) },
    { name: 'syn: noise around 100', values: gen(() => 100 + 5 * gauss(r)) },
    { name: 'syn: AR(1) 0.8', values: gen((p) => 100 + 0.8 * (p - 100) + gauss(r)) },
    { name: 'syn: level + noise (local level)', values: (() => { let m = 100; return gen(() => (m += 0.3 * gauss(r)) + 2 * gauss(r)); })() },
  ];
}

function run({ name, values }) {
  const xs = clean(values);
  let n = 0, mae = 0, naiveMae = 0, ses = 0, dn = 0, hit = 0, downHit = 0;
  for (const key of keys) {
    for (let i = 1; i < xs.length; i++) {
      const hist = xs.slice(0, i), last = hist.at(-1), actual = xs[i];
      const f = forecast(hist, { key, stream: name });
      n++; mae += Math.abs(actual - f.t1); naiveMae += Math.abs(actual - last); ses += f.model === 'ses';
      if (actual === last) continue; // no direction to score
      const up = actual > last;
      dn++; hit += (direction(hist, { key, stream: name }) === DOWN) !== up; downHit += !up;
    }
  }
  return { name, points: xs.length, n, mae, naiveMae, ses, dn, hit, downHit };
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
function print(rows) {
  console.log('stream'.padEnd(34), 'pts'.padStart(4), 'MAE/naive'.padStart(10), 'ses%'.padStart(6), 'dir hit'.padStart(8), 'allDOWN'.padStart(8));
  for (const r of rows) {
    const ratio = r.naiveMae ? (r.mae / r.naiveMae).toFixed(4) : '-';
    console.log(r.name.slice(0, 34).padEnd(34), String(r.points).padStart(4), ratio.padStart(10), pct(r.ses, r.n).padStart(6), pct(r.hit, r.dn).padStart(8), pct(r.downHit, r.dn).padStart(8));
  }
}

const files = process.argv.slice(2);
if (!files.length) {
  const def = new URL('../test/fixtures/engine-base-histories.json', import.meta.url);
  if (existsSync(def)) files.push(def.pathname);
}
for (const f of files) {
  const { source, streams } = JSON.parse(readFileSync(f, 'utf8'));
  console.log(`\n# ${f}${source ? ` (${source})` : ''}`);
  print(streams.map(run));
}
console.log(`\n# synthetic (768 points each, ${NODES} node keys)`);
print(synthetic().map(run));
console.log('\nMAE/naive < 1 means the engine beat always-naive on t1 (one step ahead).');
console.log('dir hit = Base direction rule hit rate; allDOWN = Docker rule on naive (always DOWN).');
