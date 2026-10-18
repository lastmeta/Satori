import { describe, expect, test } from 'vitest';
import { forecast, explainForecast, STEP_S, MIN_SAMPLES } from './index.js';
import {
  seeded, drawSpec, mutate, repair, accepts, runModels, runModelsAsync, explainModel, fitter, isAlone, LAMBDA1_GRID, LAMBDA2_GRID,
  MAX_COMPANIONS, MARGIN,
} from './evolve.js';
import { prepare, inPool, backtestOf, RECENT_BUCKETS } from './bvar.js';

const T0 = Date.UTC(2026, 8, 1) / 1000;
const grid = (values, start = 0) => values.map((value, k) => ({ ts: T0 + (start + k + 1) * STEP_S - 1, value }));
const POOL = Array.from({ length: 12 }, (_, i) => `u-${String(i).padStart(2, '0')}`);
const ID = '02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a';

function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { u, normal: () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()) };
}

/** Prices for `names`: 'lead' is noise, 'gold' follows 0.6 × lead's last 12 h return, the rest are noise. */
function market(n, names, seed) {
  const { normal } = rng(seed);
  const out = Object.fromEntries(names.map((k) => [k, [100]]));
  let lead = 0;
  for (let k = 1; k < n; k++) {
    const r = Object.fromEntries(names.map((name) => [name, 0.02 * normal()]));
    r.gold = 0.6 * lead + 0.01 * normal();
    lead = r.lead;
    for (const name of names) out[name].push(out[name].at(-1) * (1 + r[name]));
  }
  return out;
}
const historiesOf = (prices, upTo) => new Map(Object.entries(prices).map(([k, v]) => [k, grid(v.slice(0, upTo))]));

const validSpec = (s, pool, target) => {
  expect(s.companions.length).toBeGreaterThanOrEqual(1);
  expect(s.companions.length).toBeLessThanOrEqual(MAX_COMPANIONS);
  expect(new Set(s.companions).size).toBe(s.companions.length);
  for (const u of s.companions) expect(pool).toContain(u);
  expect(s.companions).not.toContain(target);
  expect(LAMBDA1_GRID).toContain(s.lambda1);
  expect(LAMBDA2_GRID).toContain(s.lambda2);
};

describe('the identity-seeded RNG', () => {
  test('the same parts give the same stream; other parts another', () => {
    const a = seeded(ID, 'u-1', 'draw');
    const b = seeded(ID, 'u-1', 'draw');
    const xs = Array.from({ length: 50 }, a);
    expect(Array.from({ length: 50 }, b)).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
    expect(seeded(ID, 'u-2', 'draw')()).not.toBe(xs[0]);
    expect(seeded(`${ID}0`, 'u-1', 'draw')()).not.toBe(xs[0]);
    expect(seeded(ID, 'u-1', 0)()).not.toBe(seeded(ID, 'u-1', 1)());
  });
});

describe('the first spec', () => {
  test('is reproducible per identity and target, and valid', () => {
    const s = drawSpec(seeded(ID, 'gold', 'draw'), POOL);
    expect(drawSpec(seeded(ID, 'gold', 'draw'), [...POOL].reverse())).toEqual(s); // the pool's order doesn't matter
    validSpec(s, POOL, 'gold');
  });

  test('neurons start differently: 40 identities, many specs, every count of companions', () => {
    const specs = Array.from({ length: 40 }, (_, i) => drawSpec(seeded(`identity-${i}`, 'gold', 'draw'), POOL));
    specs.forEach((s) => validSpec(s, POOL, 'gold'));
    expect(new Set(specs.map((s) => JSON.stringify(s))).size).toBeGreaterThan(35);
    expect(new Set(specs.map((s) => s.companions.length))).toEqual(new Set([1, 2, 3]));
    expect(new Set(specs.map((s) => s.lambda1)).size).toBe(LAMBDA1_GRID.length);
    expect(new Set(specs.map((s) => s.lambda2)).size).toBe(LAMBDA2_GRID.length);
  });

  test('a pool smaller than the count takes the whole pool; an empty one none', () => {
    expect(drawSpec(() => 0.99, ['a']).companions).toEqual(['a']);
    expect(drawSpec(() => 0.5, []).companions).toEqual([]);
  });
});

describe('mutations', () => {
  const base = { companions: ['u-01', 'u-02'], lambda1: 0.2, lambda2: 0.5 };
  test('each one changes one thing, and only to a valid spec', () => {
    const seen = new Set();
    for (let g = 0; g < 200; g++) {
      const { spec, op } = mutate(base, seeded(ID, 'gold', g), POOL);
      seen.add(op);
      validSpec(spec, POOL, 'gold');
      const kept = spec.companions.filter((u) => base.companions.includes(u)).length;
      if (op === 'swap') expect([spec.companions.length, kept]).toEqual([2, 1]);
      if (op === 'add') expect([spec.companions.length, kept]).toEqual([3, 2]);
      if (op === 'drop') expect([spec.companions.length, kept]).toEqual([1, 1]);
      if (op === 'lambda1') expect([0.1, 0.5]).toContain(spec.lambda1);
      if (op === 'lambda2') expect([0.25, 1.0]).toContain(spec.lambda2);
      if (op.startsWith('lambda')) expect(spec.companions).toEqual(base.companions);
      else expect([spec.lambda1, spec.lambda2]).toEqual([0.2, 0.5]);
    }
    expect(seen).toEqual(new Set(['swap', 'add', 'drop', 'lambda1', 'lambda2']));
    expect(base).toEqual({ companions: ['u-01', 'u-02'], lambda1: 0.2, lambda2: 0.5 }); // not modified
  });

  test('no add at 3 companions, no drop at 1, no swap without another stream; λ at a grid end moves inward', () => {
    const ops = (spec, pool) => new Set(Array.from({ length: 200 }, (_, g) => mutate(spec, seeded(ID, g), pool).op));
    expect(ops({ ...base, companions: ['u-01', 'u-02', 'u-03'] }, POOL).has('add')).toBe(false);
    expect(ops({ ...base, companions: ['u-01'] }, POOL).has('drop')).toBe(false);
    expect(ops({ ...base, companions: ['u-01'] }, ['u-01'])).toEqual(new Set(['lambda1', 'lambda2']));
    for (let g = 0; g < 50; g++) {
      const { spec, op } = mutate({ companions: ['u-01'], lambda1: 0.05, lambda2: 1.0 }, seeded(ID, g), ['u-01']);
      expect(op === 'lambda1' ? spec.lambda1 : spec.lambda2).toBe(op === 'lambda1' ? 0.1 : 0.5);
    }
  });

  test('reproducible from identity + target + generation', () => {
    expect(mutate(base, seeded(ID, 'gold', 3), POOL)).toEqual(mutate(base, seeded(ID, 'gold', 3), POOL));
  });
});

describe('a spec that chose the single-stream AR (a Retrain\'s choice: docs/design/engine.md#the-spec)', () => {
  const alone = { companions: [], lambda1: 0.2, lambda2: 0.5, algorithm: 'bar1' };
  test('repair leaves it; the poll\'s only proposal is to add a companion back (none without a pool)', () => {
    expect(repair(alone, () => 0, ['u-01', 'u-02'])).toBe(alone);
    const ops = new Set();
    for (let g = 0; g < 40; g++) {
      const { spec, op } = mutate(alone, seeded(ID, 'gold', g), POOL);
      ops.add(op);
      expect(isAlone(spec)).toBe(false);
      expect(spec).toMatchObject({ lambda1: 0.2, lambda2: 0.5 });
      expect(spec.companions).toHaveLength(1);
    }
    expect(ops).toEqual(new Set(['add']));
    expect(mutate(alone, seeded(ID, 'gold', 0), [])).toEqual({ spec: alone, op: 'none' });
  });

  test('the poll forecasts it as bar1 and keeps it, unless adding a companion back wins by the margin', () => {
    const prices = market(200, ['gold', 'lead', 'n1', 'n2'], 21);
    const histories = historiesOf(prices, 200);
    const specs = new Map(['gold', 'n2'].map((u) => [u, { spec: alone, generation: 0, accepted: 0 }]));
    const out = runModels({ fresh: ['gold', 'n2'], histories, seed: ID, specs });
    // n2 is noise: still the single-stream AR, forecast as bar1 itself
    const f = forecast(histories.get('n2'));
    expect(out.forecasts.get('n2')).toMatchObject({ model: 'bar1', t1: f.t1, t2: f.t2, repaired: false, proposal: { op: 'add', accepted: false } });
    expect(out.specs.get('n2')).toMatchObject({ spec: alone, generation: 1, accepted: 0 });
    expect(explainModel({ target: 'n2', spec: alone, histories })).toMatchObject({ model: 'bar1', inputs: ['n2'], influence: [1] });
    // gold follows lead: adding it back wins, and the spec is bvar again
    const gold = out.forecasts.get('gold');
    expect(gold.proposal).toMatchObject({ op: 'add', accepted: true });
    expect(gold.model).toBe('bvar');
    expect(isAlone(out.specs.get('gold').spec)).toBe(false);
    expect(out.specs.get('gold').spec.companions).toEqual(['lead']);
  });
});

describe('the acceptance rule', () => {
  test(`a challenger must beat the champion by ${MARGIN * 100} %`, () => {
    expect(MARGIN).toBe(0.05);
    expect(accepts(1, 0.94)).toBe(true);
    expect(accepts(1, 0.9501)).toBe(false);
    expect(accepts(1, 1)).toBe(false);
    expect(accepts(1, 1.2)).toBe(false);
    expect(accepts(0, 0)).toBe(false); // a target that never moves keeps its champion
    expect(accepts(1, 0.99, 0)).toBe(true);
  });
});

describe('runModels: one poll', () => {
  const names = ['gold', 'lead', 'n1', 'n2', 'n3', 'n4'];
  const prices = market(200, names, 5);

  test('a young neuron: specs exist (drawn from every other stream) and fall back to naive', () => {
    const histories = new Map(names.map((k) => [k, grid([prices[k][0]])]));
    const { forecasts, specs } = runModels({ fresh: names, histories, seed: ID });
    for (const k of names) {
      validSpec(specs.get(k).spec, names.filter((x) => x !== k), k);
      expect(specs.get(k)).toMatchObject({ score: null, generation: 0, accepted: 0 });
      expect(forecasts.get(k)).toMatchObject({ model: 'naive', t1: prices[k][0], proposal: null });
    }
  });

  test('the fallbacks: bvar, else bar1, else naive, and the model says which', () => {
    const histories = historiesOf(prices, 200);
    histories.set('tiny', grid([3, 4]));
    const specs = new Map([['gold', { spec: { companions: ['lead'], lambda1: 0.5, lambda2: 1 }, generation: 0, accepted: 0 }]]);
    const { forecasts } = runModels({ fresh: ['gold', 'tiny'], histories, specs, seed: ID });
    expect(forecasts.get('gold').model).toBe('bvar');
    expect(forecasts.get('tiny')).toMatchObject({ model: 'naive', t1: 4, t2: 4 });
    // no stream aligned with the target yet (nothing to repair from): a companion with no history leaves it on bar1
    const alone = new Map([['n2', grid(prices.n2)], ['gone', []]]);
    const bar1 = forecast(alone.get('n2'));
    expect(runModels({ fresh: ['n2'], histories: alone, seed: ID,
      specs: new Map([['n2', { spec: { companions: ['gone'], lambda1: 0.2, lambda2: 0.5 }, generation: 0, accepted: 0 }]]) })
      .forecasts.get('n2')).toMatchObject({ model: 'bar1', t1: bar1.t1, t2: bar1.t2, repaired: false });
  });

  test('only the fresh targets; one proposal each, recorded with its score and generation', () => {
    const histories = historiesOf(prices, 120);
    const first = runModels({ fresh: ['gold', 'n1'], histories, seed: ID });
    expect([...first.forecasts.keys()]).toEqual(['gold', 'n1']);
    for (const [k, row] of first.specs) {
      expect(row.generation).toBe(1);
      expect(row.score).toBeGreaterThan(0);
      const { proposal } = first.forecasts.get(k);
      expect(proposal).toMatchObject({ op: expect.any(String), score: expect.any(Number) });
      expect(row.accepted).toBe(proposal.accepted ? 1 : 0);
      expect(row.spec).toEqual(proposal.accepted ? proposal.spec : expect.anything());
    }
    expect(runModels({ fresh: ['gold', 'n1'], histories, seed: ID })).toEqual(first); // reproducible
    const again = runModels({ fresh: ['gold'], histories, specs: first.specs, seed: ID });
    expect(again.specs.get('gold').generation).toBe(2);
  });

  test('runModelsAsync: the same result; onProgress after each target; a turn for the page every slice', async () => {
    const histories = historiesOf(prices, 120);
    histories.set('none', []);
    const fresh = ['gold', 'none', 'n1', 'n2'];
    const seen = [];
    let pauses = 0;
    let t = 0;
    const out = await runModelsAsync({ fresh, histories, seed: ID, onProgress: (d, n) => seen.push([d, n]),
      clock: () => (t += 10), sliceMs: 15, pause: async () => { pauses++; } });
    expect(out).toEqual(runModels({ fresh, histories, seed: ID }));
    expect(seen).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]); // a target with no history counts too
    expect(pauses).toBeGreaterThan(0);
  });

  test(`no proposal before the backtest has ${MIN_SAMPLES} origins`, () => {
    const { specs, forecasts } = runModels({ fresh: ['gold'], histories: historiesOf(prices, 10), seed: ID });
    expect(specs.get('gold')).toMatchObject({ score: null, generation: 0 });
    expect(forecasts.get('gold').proposal).toBeNull();
  });

  test('evolution finds the companion that leads the target and keeps it', () => {
    let specs = new Map([['gold', { spec: { companions: ['n1'], lambda1: 0.05, lambda2: 0.25 }, generation: 0, accepted: 0 }]]);
    for (let k = 40; k <= 200; k += 2) {
      ({ specs } = runModels({ fresh: ['gold'], histories: historiesOf(prices, k), specs, seed: ID }));
    }
    const row = specs.get('gold');
    expect(row.spec.companions).toContain('lead');
    expect(row.accepted).toBeGreaterThan(0);
    expect(row.accepted).toBeLessThan(row.generation);
  });

  test('neurons diverge: other identities, other champions', () => {
    const histories = historiesOf(prices, 200);
    const champions = Array.from({ length: 6 }, (_, i) => {
      let specs = new Map();
      for (let g = 0; g < 20; g++) ({ specs } = runModels({ fresh: ['n2'], histories, specs, seed: `id-${i}` }));
      return JSON.stringify(specs.get('n2').spec);
    });
    expect(new Set(champions).size).toBeGreaterThan(3);
  });
});

describe('the pool needs recent alignment; companions that leave it are replaced', () => {
  const names = ['gold', 'lead', 'n1', 'n2', 'n3'];
  const prices = market(120, names, 9);
  const histories = () => {
    const h = historiesOf(prices, 120);
    h.set('dead', grid(prices.n1.slice(0, 80))); // stopped 40 buckets (20 days) ago, after 78 aligned rows
    h.set('daily', grid(prices.n2).filter((_, k) => k % 2 === 0)); // every other bucket: never three in a row
    return h;
  };

  test(`inPool: a row shared within the target's last ${RECENT_BUCKETS} row buckets and 7 in all`, () => {
    const h = histories();
    const T = prepare(h.get('gold'));
    expect(inPool(T, prepare(h.get('lead')), 7)).toBe(true);
    expect(inPool(T, prepare(h.get('dead')), 7)).toBe(false); // aligned only long ago
    expect(inPool(T, prepare(h.get('daily')), 7)).toBe(false);
    expect(inPool(T, prepare(grid(prices.n1.slice(0, 120 - RECENT_BUCKETS + 1))), 7)).toBe(true); // its last row just inside
    expect(inPool(T, prepare(grid(prices.n1.slice(0, 120 - RECENT_BUCKETS))), 7)).toBe(false); // just outside
    expect(inPool(T, prepare(grid(prices.n1.slice(110), 110)), 7)).toBe(true); // a new stream: 8 rows, all recent
    expect(inPool(T, prepare(grid(prices.n1.slice(113), 113)), 7)).toBe(false); // 5 rows: too few
    // a closed tab: the window is counted from the target's newest row, not from now
    const closed = historiesOf(prices, 100);
    expect(inPool(prepare(closed.get('gold')), prepare(closed.get('lead')), 7)).toBe(true);
  });

  test('a spec reading a stream that stopped long ago is repaired before it is scored: no frozen fit on old rows', () => {
    const specs = new Map([['gold', { spec: { companions: ['dead'], lambda1: 0.2, lambda2: 0.5 }, generation: 3, accepted: 0 }]]);
    const out = runModels({ fresh: ['gold'], histories: histories(), specs, seed: ID });
    const { spec } = out.specs.get('gold');
    expect(spec.companions).not.toContain('dead');
    for (const c of spec.companions) expect(['lead', 'n1', 'n2', 'n3']).toContain(c);
    expect(out.forecasts.get('gold')).toMatchObject({ model: 'bvar', repaired: true, rows: 118 }); // every row, up to now
    expect(runModels({ fresh: ['gold'], histories: histories(), specs, seed: ID })).toEqual(out); // reproducible
  });

  test('specs drawn blind (no history yet) are repaired once history arrives: every target on bvar', () => {
    const young = new Map([...histories()].map(([k, v]) => [k, v.slice(-1)]));
    const targets = ['gold', 'lead', 'n1', 'n2', 'n3'];
    for (const seed of ['idA', 'idB', 'idC', 'idD']) {
      const first = runModels({ fresh: targets, histories: young, seed });
      expect(targets.every((t) => first.forecasts.get(t).model === 'naive')).toBe(true);
      const blind = targets.filter((t) => first.specs.get(t).spec.companions.some((c) => c === 'dead' || c === 'daily'));
      const next = runModels({ fresh: targets, histories: histories(), specs: first.specs, seed });
      expect(targets.map((t) => next.forecasts.get(t).model)).toEqual(targets.map(() => 'bvar'));
      for (const t of targets) {
        expect(next.specs.get(t).spec.companions.some((c) => c === 'dead' || c === 'daily')).toBe(false);
        expect(next.forecasts.get(t).repaired).toBe(blind.includes(t));
      }
    }
  });

  test('repair: keeps companions in the pool and their places; draws replacements from the rest; none to draw from drops one', () => {
    const spec = { companions: ['a', 'x', 'b'], lambda1: 0.1, lambda2: 1 };
    const r = repair(spec, seeded(ID, 'gold', 4, 'repair'), ['a', 'b', 'c', 'd']);
    expect(r.companions[0]).toBe('a');
    expect(r.companions[2]).toBe('b');
    expect(['c', 'd']).toContain(r.companions[1]);
    expect([r.lambda1, r.lambda2]).toEqual([0.1, 1]);
    expect(repair(spec, seeded(ID, 'gold', 4, 'repair'), ['a', 'b', 'c', 'd'])).toEqual(r);
    expect(repair(spec, () => 0, ['a', 'b'])).toEqual({ ...spec, companions: ['a', 'b'] });
    expect(repair({ ...spec, companions: ['x', 'y'] }, () => 0, ['a'])).toEqual({ ...spec, companions: ['a'] });
    expect(repair(spec, () => 0, ['a', 'b', 'x'])).toBe(spec); // all in the pool: unchanged
    expect(repair(spec, () => 0, [])).toBe(spec); // no aligned stream yet (no history): the draw stays
    expect(repair({ ...spec, companions: [] }, () => 0, ['c'])).toEqual({ ...spec, companions: ['c'] });
  });
});

describe('what the Models tab reads: the stored quality and influence, and explainModel (docs/design/models.md)', () => {
  const names = ['gold', 'lead', 'n1', 'n2', 'n3', 'n4'];
  const prices = market(200, names, 5);
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  test('runModels stores no-change\'s median error on the same origins (persist) and, for bvar, each input\'s influence', () => {
    const histories = historiesOf(prices, 200);
    histories.set('tiny', grid([3, 4]));
    const specs = new Map([['gold', { spec: { companions: ['n1', 'lead'], lambda1: 0.5, lambda2: 1 }, generation: 0, accepted: 0 }]]);
    const out = runModels({ fresh: ['gold', 'tiny'], histories, specs, seed: ID });
    const gold = out.specs.get('gold');
    expect(out.forecasts.get('gold').model).toBe('bvar');
    const T = prepare(histories.get('gold'));
    expect(gold.persist).toBe(median(backtestOf(T).persist));
    expect(gold.influence).toHaveLength(1 + gold.spec.companions.length); // the target first, then each companion
    expect(gold.influence.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(gold.influence[1 + gold.spec.companions.indexOf('lead')]).toBe(Math.max(...gold.influence)); // the leader leads
    expect(out.specs.get('tiny')).toMatchObject({ score: null, persist: null, influence: null }); // naive
  });

  test('explainModel: the same forecast from the stored spec, with its fit\'s influence, rows and backtest', () => {
    const histories = historiesOf(prices, 200);
    let specs = new Map();
    let out;
    for (let k = 196; k <= 200; k++) ({ specs, forecasts: out } = runModels({ fresh: ['gold', 'n2'], histories: historiesOf(prices, k), specs, seed: ID }));
    for (const target of ['gold', 'n2']) {
      const row = specs.get(target);
      const f = out.get(target);
      const x = explainModel({ target, spec: row.spec, histories });
      expect(x).toMatchObject({ model: f.model, t1: f.t1, t2: f.t2, weight: f.weight, rows: f.rows, score: row.score, persist: row.persist,
        inputs: [target, ...row.spec.companions], influence: row.influence, tests: 28 });
      expect(x.coef).toHaveLength(x.inputs.length);
    }
  });

  test('fitter (the training pass): each stored champion scored on the stored history exactly as the poll scored it; the spec untouched', () => {
    let specs = new Map();
    let out;
    for (let k = 196; k <= 200; k++) ({ specs, forecasts: out } = runModels({ fresh: ['gold', 'n2', 'n3'], histories: historiesOf(prices, k), specs, seed: ID }));
    const fit = fitter({ histories: historiesOf(prices, 200) });
    for (const target of ['gold', 'n2', 'n3']) {
      const row = specs.get(target);
      expect(fit(target, row.spec)).toEqual({ model: out.get(target).model, score: row.score, persist: row.persist, influence: row.influence });
    }
    // a spec reading a stream with no history: bar1's errors stand in, as in the poll; the spec is not repaired
    const spec = { companions: ['gone'], lambda1: 0.2, lambda2: 0.5 };
    const histories = historiesOf(prices, 200);
    const x = explainForecast(histories.get('n2'));
    expect(fitter({ histories })('n2', spec)).toEqual({ model: 'bar1', score: x.score, persist: x.persist, influence: null });
    expect(fitter({ histories })('gone', spec)).toBeNull(); // no history: nothing to fit
  });

  test('explainModel falls back as the engine does: bar1 on the stream alone (all its own), or nothing without history', () => {
    const histories = new Map([['n2', grid(prices.n2)], ['gone', []]]);
    const x = explainModel({ target: 'n2', spec: { companions: ['gone'], lambda1: 0.2, lambda2: 0.5 }, histories });
    expect(x).toMatchObject({ ...explainForecast(histories.get('n2')), inputs: ['n2'], influence: [1] });
    expect(explainModel({ target: 'n2', spec: null, histories })).toMatchObject({ model: 'bar1', inputs: ['n2'], influence: [1] });
    expect(explainModel({ target: 'gone', spec: null, histories })).toBeNull();
  });
});
