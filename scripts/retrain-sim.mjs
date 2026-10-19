// Retrain's held-out rule, measured (docs/design/models.md#retrain): synthetic 12 h series of 83 buckets (central's
// ~41 days), a target in a pool of random walks; `walks` targets are random walks too (any acceptance is luck),
// `leaders` targets trail one pool stream by one step (a ~30 % edge at 24 h). Each runs Retrain's search from a drawn
// champion; the spec it looks at once is scored on the held-out origins, and each rule is applied to those numbers.
//
//   node scripts/retrain-sim.mjs [walks=400] [leaders=100] [pool=30]      (read only; minutes)
import { retrainer, splitOf, ratioOn, GOAL } from '../src/engine/retrain.js';
import { drawSpec, seeded, seriesOf, errorsOf, MARGIN } from '../src/engine/evolve.js';
import { STEP_S } from '../src/engine/index.js';

const [WALKS = 400, LEADERS = 100, POOL = 30] = process.argv.slice(2).map(Number);
const T0 = Date.UTC(2026, 8, 1) / 1000;

function normals(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
}

function market(seed, leader) {
  const normal = normals(seed);
  const names = ['gold', 'lead', ...Array.from({ length: POOL - 1 }, (_, i) => `n${i}`)];
  const out = Object.fromEntries(names.map((k) => [k, [100]]));
  let last = 0;
  for (let k = 1; k < 83; k++) {
    const r = Object.fromEntries(names.map((x) => [x, 0.015 * normal()]));
    if (leader) r.gold = last + 0.003 * normal();
    last = r.lead;
    for (const x of names) out[x].push(out[x].at(-1) * (1 + r[x]));
  }
  return new Map(names.map((x) => [x, out[x].map((value, k) => ({ ts: T0 + (k + 1) * STEP_S - 1, value }))]));
}

/** One retrain: the looked-at spec's held-out ratio (h), each half's (w), the champion's (h0). */
function run(seed, leader) {
  const h = market(7000 + seed, leader);
  const champion = drawSpec(seeded('id', 'gold', seed, 'draw'), [...h.keys()].filter((x) => x !== 'gold' && x !== 'lead'));
  const r = retrainer({ target: 'gold', histories: h, champion, seed: `id-${seed}` });
  let res;
  while (!(res = r.step()));
  const series = seriesOf(h, STEP_S);
  const T = series('gold');
  const { bt, held } = splitOf(T);
  const ratio = (spec, idx) => ratioOn(errorsOf(T, spec, series, bt).errors, bt.persist, idx);
  const best = r.state().best;
  const halves = [held.slice(0, held.length >> 1), held.slice(held.length >> 1)];
  return { looked: res.checks > 0, h: ratio(best, held), w: halves.map((idx) => ratio(best, idx)), h0: ratio(champion, held) };
}

const RULES = {
  'the tab\'s rule, below 0.95': (x) => x.h < GOAL,
  'below 0.90': (x) => x.h < 0.9,
  'below 0.85': (x) => x.h < 0.85,
  'below 0.80 (shipped)': (x) => x.h < 0.8,
  'below 0.95 and each week below 1.0': (x) => x.h < GOAL && x.w.every((w) => w < 1),
  'each week below 0.95': (x) => x.h < GOAL && x.w.every((w) => w < 0.95),
  'each week below 0.90': (x) => x.h < GOAL && x.w.every((w) => w < 0.9),
};
const walks = Array.from({ length: WALKS }, (_, s) => run(s, false));
const leaders = Array.from({ length: LEADERS }, (_, s) => run(s, true));
// accepted: the look passes the rule and, when the champion already beats no change, beats it by the margin too
const accepted = (list, pass) => list.filter((x) => x.looked && pass(x) && (x.h0 >= GOAL || x.h < x.h0 * (1 - MARGIN))).length;
console.log(`pool ${POOL}: ${WALKS} random walks, ${LEADERS} leaders`);
for (const [name, pass] of Object.entries(RULES)) {
  const a = accepted(walks, pass);
  console.log(`${name.padEnd(40)} random walks ${String(a).padStart(4)} (${((100 * a) / WALKS).toFixed(1)} %)   leaders ${accepted(leaders, pass)}`);
}
