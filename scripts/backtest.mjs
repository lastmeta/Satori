// Backtest the engine against persistence at central's 24 h horizon, on real
// history, read only (docs/design/engine.md#measured):
//
//   node scripts/backtest.mjs [days = 400] [SYMBOL,SYMBOL,...]
//
// History:
// - the Base registry's hourly history (getHistoryPage, an eth_call on Base
//   Sepolia; the ring keeps 768 hours);
// - Binance's public 1 h closes (data-api.binance.vision) for the symbols
//   namaste_club trains on (NC/regrid_history.py:49-58).
// Central serves only each stream's latest observation, so it has no history
// to test on.
//
// The neuron runs as it does in the app: every 11 h a poll stores the latest
// value, and the engine forecasts from all the history stored so far, starting
// from none. Each t2 is scored against the first observation ≥ 24 h later
// (central/src/scripts/score.py:249-253), as is persistence (the last value).
// Errors are |forecast − actual| / actual; medians are pooled over forecasts,
// as namaste_club reports them (NC/calibration.py:4-10).
import { keccak_256 } from '@noble/hashes/sha3';
import { forecast, STEP_S } from '../src/engine/index.js';

const RPC = 'https://sepolia.base.org';
const REGISTRY = '0x1ED75AB0a66Ba7d23C3E5c84798e90205E76743a';
const KLINES = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT',
  'LINKUSDT', 'LTCUSDT', 'ATOMUSDT', 'AVAXUSDT', 'UNIUSDT', 'VETUSDT', 'NEOUSDT', 'FILUSDT', 'ALGOUSDT',
  'XTZUSDT', 'XLMUSDT', 'TRXUSDT', 'AAVEUSDT', 'MKRUSDT', 'EOSUSDT', 'XMRUSDT'];
const POLL_S = 11 * 3600; // Lite's poll (start.py:4785-4876)
const HORIZON_S = 24 * 3600;
const YOUNG_S = 30 * 86400;

const days = Number(process.argv[2] ?? 400);
const symbols = process.argv[3] ? process.argv[3].split(',') : SYMBOLS;
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const selector = (sig) => hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));

async function ethCall(data) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: REGISTRY, data: `0x${data}` }, 'latest'] }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result.slice(2).match(/.{64}/g).map((w) => BigInt(`0x${w}`));
}

/** Each Base stream's hourly history: [[ts, value]], oldest first. */
async function registrySeries() {
  const ids = await ethCall(selector('getAllDataStreams()'));
  const out = [];
  for (const id of ids.slice(2, 2 + Number(ids[1])).map(Number)) {
    const w = await ethCall(selector('getHistoryPage(uint32,uint256,uint256)') + word(id) + word(0) + word(768));
    const at = (offset) => Number(w[offset]) / 32;
    const values = w.slice(at(0) + 1, at(0) + 1 + Number(w[at(0)])).map((x) => Number(BigInt.asIntN(256, x)));
    const hours = w.slice(at(1) + 1, at(1) + 1 + Number(w[at(1)])).map(Number);
    out.push({ name: `base stream ${id}`, series: hours.map((h, i) => [h * 3600, values[i]]) });
  }
  return out;
}

/** A symbol's 1 h closes over the last `days`: [[ts at the hour's end, close]]. */
async function binanceSeries(symbol) {
  const series = [];
  let start = Date.now() - days * 86400e3;
  for (;;) {
    const res = await fetch(`${KLINES}?symbol=${symbol}&interval=1h&limit=1000&startTime=${start}`);
    const k = await res.json();
    if (!Array.isArray(k) || !k.length) break;
    for (const c of k) if (c[6] < Date.now()) series.push([(c[6] + 1) / 1000, Number(c[4])]);
    if (k.length < 1000) break;
    start = k.at(-1)[6] + 1;
  }
  return series;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
};

/** The neuron on one series: polls every 11 h from the start, scored 24 h on. */
function simulate(series) {
  const rows = [];
  const history = [];
  let i = 0;
  let j = 0;
  const t0 = series[0][0];
  for (let t = t0; t + HORIZON_S <= series.at(-1)[0]; t += POLL_S) {
    while (i < series.length && series[i][0] <= t) i++;
    const [ts, value] = series[i - 1];
    if (history.at(-1)?.ts === ts) continue; // no new row, no prediction (engine.py:695-712)
    history.push({ ts, value });
    while (j < series.length && series[j][0] < t + HORIZON_S) j++;
    const actual = series[j][1];
    if (!(actual > 0)) continue;
    const f = forecast(history);
    const raw = forecast(history, { weight: 1 });
    const err = (x) => Math.abs(x - actual) / actual;
    rows.push({ young: t - t0 < YOUNG_S, model: f.model, weight: f.weight, engine: err(f.t2), raw: err(raw.t2), persist: err(value) });
  }
  return rows;
}

const pct = (x) => `${(x * 100).toFixed(3)}%`;
function summary(name, rows) {
  const bar1 = rows.filter((r) => r.model === 'bar1');
  const s = {
    name, n: rows.length,
    engine: median(rows.map((r) => r.engine)), raw: median(rows.map((r) => r.raw)), persist: median(rows.map((r) => r.persist)),
    bar1: bar1.length / rows.length, weight: bar1.reduce((a, r) => a + r.weight, 0) / (bar1.length || 1),
    closer: rows.filter((r) => r.engine < r.persist).length / rows.length,
    farther: rows.filter((r) => r.engine > r.persist).length / rows.length,
  };
  console.log([name.padEnd(22), String(s.n).padStart(6), pct(s.engine).padStart(9), pct(s.raw).padStart(9), pct(s.persist).padStart(9),
    (s.engine / s.persist).toFixed(4).padStart(7), `${(s.bar1 * 100).toFixed(0)}%`.padStart(5), s.weight.toFixed(2).padStart(5),
    `${(s.closer * 100).toFixed(1)}/${(s.farther * 100).toFixed(1)}%`.padStart(12)].join(' '));
  return s;
}

console.log(`engine vs persistence, t2 scored 24 h on; polls every 11 h; last ${days} days`);
console.log(['series'.padEnd(22), 'n'.padStart(6), 'engine'.padStart(9), 'unfaded'.padStart(9), 'persist'.padStart(9),
  'ratio'.padStart(7), 'bar1'.padStart(5), 'w'.padStart(5), 'closer/farther'.padStart(12)].join(' '));
const all = [];
for (const { name, series } of await registrySeries().catch((err) => (console.log(`base registry: ${err.message}`), []))) {
  const buckets = new Set(series.map(([ts]) => Math.floor(ts / STEP_S))).size;
  if (series.length < 2 || series.at(-1)[0] - series[0][0] < 7 * 86400) {
    console.log(`${name}: ${series.length} entries over ${buckets} 12 h buckets; too little history to score`);
    continue;
  }
  const rows = simulate(series);
  summary(name, rows);
  all.push(...rows);
}
for (const symbol of symbols) {
  const series = await binanceSeries(symbol).catch(() => []);
  if (series.length < 24 * 30) {
    console.log(`${symbol}: ${series.length} hours; skipped`);
    continue;
  }
  const rows = simulate(series);
  summary(symbol, rows);
  all.push(...rows);
}
console.log('');
summary('all', all);
summary('first 30 days', all.filter((r) => r.young));
summary('after 30 days', all.filter((r) => !r.young));
