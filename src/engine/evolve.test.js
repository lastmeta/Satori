import { describe, expect, test } from 'vitest';
import { forecast, STEP_S, MIN_SAMPLES } from './index.js';
import {
  seeded, drawSpec, mutate, accepts, runModels, LAMBDA1_GRID, LAMBDA2_GRID, MAX_COMPANIONS, MARGIN,
} from './evolve.js';

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
    histories.set('short', grid(prices.n1.slice(0, 9))); // 9 buckets: bar1's 6 pairs at the end, too few rows with others
    const specs = new Map([['gold', { spec: { companions: ['lead'], lambda1: 0.5, lambda2: 1 }, generation: 0, accepted: 0 }],
      ['n1', { spec: { companions: ['short'], lambda1: 0.2, lambda2: 0.5 }, generation: 0, accepted: 0 }],
      ['n2', { spec: { companions: ['gone'], lambda1: 0.2, lambda2: 0.5 }, generation: 0, accepted: 0 }]]);
    histories.set('tiny', grid([3, 4]));
    const { forecasts } = runModels({ fresh: ['gold', 'n1', 'n2', 'tiny'], histories, specs, seed: ID });
    expect(forecasts.get('gold').model).toBe('bvar');
    const bar1 = forecast(histories.get('n2'));
    expect(forecasts.get('n2')).toMatchObject({ model: 'bar1', t1: bar1.t1, t2: bar1.t2 }); // a companion with no history
    expect(forecasts.get('tiny')).toMatchObject({ model: 'naive', t1: 4, t2: 4 });
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
