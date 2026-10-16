// Backtest the engine against persistence at central's 24 h horizon, on real
// history, read only (docs/design/engine.md#measured):
//
//   node scripts/backtest.mjs [days = 400] [SYMBOL,SYMBOL,...] [--neurons 5] [--margin 0.05] [--window 28] [--backfill]
//
// BACKTEST_CACHE=dir keeps the downloaded closes there (and reads them back).
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
//
// Then the neurons: each (an identity seed) runs bvar with evolution on all the
// symbols at once, as the app runs central's streams (src/engine/evolve.js:
// each symbol a target, the others its pool), on the same polls; they are
// scored like bar1 and persistence. --backfill starts each neuron with 1,000
// hourly closes, as central's history gives a new neuron.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { forecast, STEP_S, HOLDOUT } from '../src/engine/index.js';
import { runModels, MARGIN } from '../src/engine/evolve.js';

const RPC = 'https://sepolia.base.org';
const REGISTRY = '0x1ED75AB0a66Ba7d23C3E5c84798e90205E76743a';
const KLINES = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT',
  'LINKUSDT', 'LTCUSDT', 'ATOMUSDT', 'AVAXUSDT', 'UNIUSDT', 'VETUSDT', 'NEOUSDT', 'FILUSDT', 'ALGOUSDT',
  'XTZUSDT', 'XLMUSDT', 'TRXUSDT', 'AAVEUSDT', 'MKRUSDT', 'EOSUSDT', 'XMRUSDT'];
const POLL_S = 11 * 3600; // Lite's poll (start.py:4785-4876)
const HORIZON_S = 24 * 3600;
const YOUNG_S = 30 * 86400;

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.match(/^--(neurons|margin|window)$/));
const days = Number(args[0] ?? 400);
const symbols = args[1] ? args[1].split(',') : SYMBOLS;
const NEURONS = Number(flag('neurons', 5));
const margin = Number(flag('margin', MARGIN));
const window = Number(flag('window', HOLDOUT));
const BACKFILL = flag('backfill', false) ? 1000 * 3600 : 0; // central's history: up to 1,000 hourly rows
const CACHE = process.env.BACKTEST_CACHE;
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

/** A symbol's 1 h closes over the last `days`: [[ts at the hour's end, close]] (kept in BACKTEST_CACHE). */
async function binanceSeries(symbol) {
  const file = CACHE && `${CACHE}/${symbol}-${days}.json`;
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const series = await fetchBinance(symbol);
  if (file && series.length) {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, JSON.stringify(series));
  }
  return series;
}

async function fetchBinance(symbol) {
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
const market = [];
for (const symbol of symbols) {
  const series = await binanceSeries(symbol).catch(() => []);
  if (series.length < 24 * 30) {
    console.log(`${symbol}: ${series.length} hours; skipped`);
    continue;
  }
  market.push({ symbol, series });
  if (BACKFILL) continue;
  const rows = simulate(series);
  summary(symbol, rows);
  all.push(...rows);
}
if (!BACKFILL) {
  console.log('');
  summary('all', all);
  summary('first 30 days', all.filter((r) => r.young));
  summary('after 30 days', all.filter((r) => !r.young));
}
neurons(market);

/**
 * The neurons: every symbol a target with the others as its pool, polled together
 * every 11 h (each poll stores each symbol's latest close if it is new), each
 * target forecast by runModels (bvar + evolution) and, for comparison, bar1.
 */
function neurons(symbolsData) {
  const names = symbolsData.map((d) => d.symbol);
  const start = Math.max(...symbolsData.map((d) => d.series[0][0])) + BACKFILL;
  const end = Math.min(...symbolsData.map((d) => d.series.at(-1)[0]));
  const polls = [];
  for (let t = start; t + HORIZON_S <= end; t += POLL_S) polls.push(t);
  const at = (series, t) => { // the last close at or before t, and the first ≥ t + 24 h
    let lo = 0;
    let hi = series.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (series[mid][0] <= t) lo = mid; else hi = mid - 1;
    }
    let j = lo;
    while (j < series.length && series[j][0] < t + HORIZON_S) j++;
    return { now: series[lo], later: series[j] };
  };
  console.log(`\nneurons: bvar with evolution on ${names.length} symbols at once, ${polls.length} polls every 11 h` +
    `${BACKFILL ? ', each starting with 1,000 hourly closes' : ', from no history'}; margin ${margin}, scored on ${window} origins`);
  const bar1Rows = [];
  const results = [];
  for (let n = 0; n < NEURONS; n++) {
    const seed = `backtest-neuron-${n}`;
    const histories = new Map(symbolsData.map((d) => [d.symbol,
      BACKFILL ? d.series.filter(([ts]) => ts <= start && ts > start - BACKFILL).map(([ts, value]) => ({ ts, value })) : []]));
    let specs = new Map();
    const rows = [];
    let proposals = 0;
    let accepted = 0;
    const ms = [];
    const ops = {};
    for (const [p, t] of polls.entries()) {
      const fresh = [];
      const truth = new Map();
      for (const d of symbolsData) {
        const { now, later } = at(d.series, t);
        const h = histories.get(d.symbol);
        if (h.at(-1)?.ts === now[0]) continue;
        h.push({ ts: now[0], value: now[1] });
        fresh.push(d.symbol);
        truth.set(d.symbol, { value: now[1], actual: later?.[1] });
      }
      const t0 = performance.now();
      const out = runModels({ fresh, histories, specs, seed, margin, window });
      ms.push(performance.now() - t0);
      for (const [k, row] of out.specs) specs.set(k, row);
      for (const k of fresh) {
        const f = out.forecasts.get(k);
        const { value, actual } = truth.get(k);
        if (f.proposal) {
          proposals++;
          ops[f.proposal.op] = (ops[f.proposal.op] ?? [0, 0]).map((x, i) => x + (i === 0 ? 1 : f.proposal.accepted ? 1 : 0));
          if (f.proposal.accepted) accepted++;
        }
        if (!(actual > 0)) continue;
        const err = (x) => Math.abs(x - actual) / actual;
        const row = { symbol: k, poll: p, young: t - start < YOUNG_S, model: f.model, bvar: err(f.t2), persist: err(value) };
        if (n === 0) {
          const b = forecast(histories.get(k));
          bar1Rows.push({ symbol: k, poll: p, bar1: err(b.t2) });
        }
        rows.push(row);
      }
    }
    const b1 = new Map(bar1Rows.map((r) => [`${r.symbol}:${r.poll}`, r.bar1]));
    for (const r of rows) r.bar1 = b1.get(`${r.symbol}:${r.poll}`);
    results.push({ seed, rows, specs, proposals, accepted, ms, ops });
  }
  const med = (rows, key) => median(rows.map((r) => r[key]));
  const line = (label, rows) => {
    const m = med(rows, 'bvar');
    const p = med(rows, 'persist');
    const b = med(rows, 'bar1');
    return [label.padEnd(26), String(rows.length).padStart(6), pct(m).padStart(9), pct(b).padStart(9), pct(p).padStart(9),
      (m / p).toFixed(4).padStart(9), (m / b).toFixed(4).padStart(9), (b / p).toFixed(4).padStart(9),
      `${((rows.filter((r) => r.model === 'bvar').length / rows.length) * 100).toFixed(0)}%`.padStart(6)].join(' ');
  };
  console.log(['neuron'.padEnd(26), 'n'.padStart(6), 'bvar'.padStart(9), 'bar1'.padStart(9), 'persist'.padStart(9),
    'bvar/pers'.padStart(9), 'bvar/bar1'.padStart(9), 'bar1/pers'.padStart(9), 'bvar%'.padStart(6)].join(' '));
  for (const r of results) {
    console.log(`${line(r.seed, r.rows)}  accepted ${r.accepted}/${r.proposals} (${((r.accepted / r.proposals) * 100).toFixed(1)}%)`);
  }
  const pooled = results.flatMap((r) => r.rows);
  console.log(line('all neurons', pooled));
  console.log(line('  first 30 days', pooled.filter((r) => r.young)));
  console.log(line('  after 30 days', pooled.filter((r) => !r.young)));
  // per-forecast: how often bvar is closer than bar1
  const closer = pooled.filter((r) => r.bvar < r.bar1).length / pooled.length;
  const farther = pooled.filter((r) => r.bvar > r.bar1).length / pooled.length;
  console.log(`bvar closer than bar1 on ${(closer * 100).toFixed(1)}% of forecasts, farther on ${(farther * 100).toFixed(1)}%`);
  // per symbol, all neurons pooled
  const perSymbol = names.map((s) => {
    const rs = pooled.filter((r) => r.symbol === s);
    return `${s.replace('USDT', '')} ${(med(rs, 'bvar') / med(rs, 'bar1')).toFixed(3)}`;
  });
  console.log(`bvar/bar1 per symbol: ${perSymbol.join(', ')}`);
  const ops = {};
  for (const r of results) for (const [op, [n, a]] of Object.entries(r.ops)) ops[op] = [(ops[op]?.[0] ?? 0) + n, (ops[op]?.[1] ?? 0) + a];
  console.log(`accepted by mutation: ${Object.entries(ops).map(([op, [n, a]]) => `${op} ${a}/${n}`).join(', ')}`);
  // divergence: each target's final champion across the neurons
  const short = (u) => u.replace('USDT', '');
  let distinct = 0;
  let jac = 0;
  let pairs = 0;
  const sizes = [0, 0, 0, 0];
  const l1 = {};
  const l2 = {};
  for (const s of names) {
    const champs = results.map((r) => r.specs.get(s).spec);
    distinct += new Set(champs.map((c) => JSON.stringify({ ...c, companions: [...c.companions].sort() }))).size;
    for (const c of champs) {
      sizes[c.companions.length]++;
      l1[c.lambda1] = (l1[c.lambda1] ?? 0) + 1;
      l2[c.lambda2] = (l2[c.lambda2] ?? 0) + 1;
    }
    for (let i = 0; i < champs.length; i++) {
      for (let j = i + 1; j < champs.length; j++) {
        const a = new Set(champs[i].companions);
        const b = new Set(champs[j].companions);
        const inter = [...a].filter((x) => b.has(x)).length;
        jac += inter / new Set([...a, ...b]).size;
        pairs++;
      }
    }
  }
  console.log(`final champions: ${distinct} distinct specs of ${names.length * results.length} (${names.length} targets × ${results.length} neurons);` +
    ` mean companion overlap (Jaccard) between two neurons on a target ${(jac / pairs).toFixed(3)};` +
    ` companions 1/2/3: ${sizes.slice(1).join('/')}; λ1 ${JSON.stringify(l1)}; λ2 ${JSON.stringify(l2)}`);
  for (const s of names.slice(0, 4)) {
    console.log(`  ${short(s)}: ${results.map((r) => {
      const c = r.specs.get(s);
      return `${c.spec.companions.map(short).join('+')} λ${c.spec.lambda1}/${c.spec.lambda2} g${c.generation} a${c.accepted}`;
    }).join(' | ')}`);
  }
  const allMs = results.flatMap((r) => r.ms);
  console.log(`runModels per poll (${names.length} targets): median ${median(allMs).toFixed(1)} ms, max ${Math.max(...allMs).toFixed(1)} ms`);
}
