// Retrain's search (docs/design/models.md#retrain): a hill-climb over one target's spec, scored on the older backtest
// origins only, looked at once on the tab's own 28: it finds a planted leader, is rarely fooled by a random walk,
// is reproducible, resumes where it was, and stops.
import { describe, expect, test, vi } from 'vitest';
import { STEP_S, HOLDOUT, explainForecast } from './index.js';
import { backtestOf, prepare } from './bvar.js';
import { fitter, isAlone, seriesOf, errorsOf, LAMBDA1_GRID, LAMBDA2_GRID, MAX_COMPANIONS } from './evolve.js';
import {
  retrainer, canRetrain, neighbours, splitOf, ratioOn, keyOf, spaceSize, GOAL, BAR, MIN_SEARCH, PATIENCE,
} from './retrain.js';

vi.setConfig({ testTimeout: 60_000 }); // 50 random walks searched in full: ~6 s

const T0 = Date.UTC(2026, 8, 1) / 1000;
const ID = '02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a';

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
const points = (values) => values.map((value, k) => ({ ts: T0 + (k + 1) * STEP_S - 1, value }));

/**
 * `n` 12 h buckets of `others` random walks and 'gold': a random walk too, or (lead) trailing 'lead' by one step (its
 * return is lead's last one, plus a little noise), so its first 12 h step is known from lead's.
 */
function market(seed, { n = 83, others = 5, lead = false } = {}) {
  const normal = normals(seed);
  const names = ['gold', ...(lead ? ['lead'] : []), ...Array.from({ length: others }, (_, i) => `n${i}`)];
  const out = Object.fromEntries(names.map((k) => [k, [100]]));
  let last = 0;
  for (let k = 1; k < n; k++) {
    const r = Object.fromEntries(names.map((x) => [x, 0.015 * normal()]));
    if (lead) {
      r.gold = last + 0.003 * normal();
      last = r.lead;
    }
    for (const x of names) out[x].push(out[x].at(-1) * (1 + r[x]));
  }
  return new Map(names.map((x) => [x, points(out[x])]));
}

const run = (r) => {
  let res = null;
  while (!(res = r.step()));
  return res;
};
const TIGHT = { companions: ['n0'], lambda1: 0.05, lambda2: 0.25 }; // close to no change
/** A spec's errors at every backtest origin of the split (the search's and the held-out). */
const fitterErrors = (h, spec) => {
  const series = seriesOf(h, STEP_S);
  return errorsOf(series('gold'), spec, series, splitOf(series('gold')).bt).errors;
};

describe('the neighbours: every spec one change away', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'];
  test('swap, add, drop, a λ step, the single-stream AR; each valid, none the spec itself', () => {
    const spec = { companions: ['a', 'b'], lambda1: 0.2, lambda2: 0.5 };
    const list = neighbours(spec, pool);
    // 2 × 3 swaps + 3 adds + 2 drops + 2 λ1 steps + 2 λ2 steps + bar1
    expect(list).toHaveLength(6 + 3 + 2 + 2 + 2 + 1);
    for (const s of list) {
      expect(keyOf(s)).not.toBe(keyOf(spec));
      if (isAlone(s)) continue;
      expect(s.companions.length).toBeGreaterThanOrEqual(1);
      expect(s.companions.length).toBeLessThanOrEqual(MAX_COMPANIONS);
      expect(new Set(s.companions).size).toBe(s.companions.length);
      expect(LAMBDA1_GRID).toContain(s.lambda1);
      expect(LAMBDA2_GRID).toContain(s.lambda2);
    }
    expect(list.filter(isAlone)).toEqual([{ companions: [], lambda1: 0.2, lambda2: 0.5, algorithm: 'bar1' }]);
    expect(new Set(list.map(keyOf)).size).toBe(list.length);
    // no add at 3, no drop at 1, a λ at a grid end steps inward only
    expect(neighbours({ companions: ['a', 'b', 'c'], lambda1: 0.05, lambda2: 1 }, pool)).toHaveLength(3 * 2 + 3 + 1 + 1 + 1);
    expect(neighbours({ companions: ['a'], lambda1: 0.5, lambda2: 0.25 }, pool)).toHaveLength(4 + 4 + 1 + 1 + 1);
  });

  test('from the single-stream AR: add any one companion back, its λ\'s kept', () => {
    const list = neighbours({ companions: [], lambda1: 0.1, lambda2: 1, algorithm: 'bar1' }, pool);
    expect(list).toEqual(pool.map((u) => ({ companions: [u], lambda1: 0.1, lambda2: 1 })));
  });

  test('the space: 1–3 companions × the λ grids, and bar1', () => {
    expect(spaceSize(5)).toBe((5 + 10 + 10) * 12 + 1);
    expect(spaceSize(2)).toBe((2 + 1) * 12 + 1);
    expect(spaceSize(0)).toBe(1);
  });
});

describe('the split', () => {
  const h = market(3);
  const T = prepare(h.get('gold'));
  test('held out: exactly the tab\'s origins; searched: older ones whose actual came before the first held-out origin', () => {
    const { bt, held, search, heldEnd } = splitOf(T);
    const tab = backtestOf(T, HOLDOUT);
    expect(held.map((i) => bt.origins[i].k)).toEqual(tab.origins.map((o) => o.k));
    expect(held.map((i) => bt.persist[i])).toEqual(tab.persist);
    expect(held).toHaveLength(HOLDOUT);
    const first = bt.origins[held[0]].k;
    expect(search.length).toBeGreaterThanOrEqual(MIN_SEARCH);
    for (const i of search) expect(bt.origins[i].k + 2).toBeLessThanOrEqual(first);
    expect(heldEnd).toBe(tab.origins.at(-1).k);
  });

  test('a spec\'s held-out ratio is the tab\'s: the poll\'s score over no change\'s (fitter)', () => {
    for (const spec of [{ companions: ['n1', 'n2'], lambda1: 0.5, lambda2: 1 }, { companions: [], lambda1: 0.2, lambda2: 0.5, algorithm: 'bar1' }]) {
      const r = retrainer({ target: 'gold', histories: h, champion: spec, seed: ID });
      const f = fitter({ histories: h })('gold', spec);
      expect(r.end().ratio).toBeCloseTo(f.score / f.persist, 12);
      expect(r.end().was).toBe(r.end().ratio); // stopped at once: the champion kept
    }
    // the single-stream AR scores as bar1 itself
    const x = explainForecast(h.get('gold'));
    expect(fitter({ histories: h })('gold', { companions: [], lambda1: 0.2, lambda2: 0.5, algorithm: 'bar1' }))
      .toMatchObject({ model: 'bar1', score: x.score, persist: x.persist, influence: null });
  });

  test('canRetrain: 52 back-to-back buckets are enough (14 older origins besides the 28), 51 are not', () => {
    expect(canRetrain({ target: 'gold', histories: market(3, { n: 52 }) })).toMatchObject({ ok: true, search: 14, held: 28 });
    expect(canRetrain({ target: 'gold', histories: market(3, { n: 51 }) })).toMatchObject({ ok: false, search: 13 });
    expect(canRetrain({ target: 'none', histories: h })).toMatchObject({ ok: false });
    expect(retrainer({ target: 'gold', histories: market(3, { n: 40 }), champion: TIGHT, seed: ID }).ok).toBe(false);
  });

  test('ratioOn: the median error over no change\'s; no change perfect: 1 if the model is too, else Infinity', () => {
    expect(ratioOn([1, 2, 3], [2, 2, 2], [0, 1, 2])).toBe(1);
    expect(ratioOn([1, 1, 9], [2, 2, 2], [0, 1])).toBe(0.5);
    expect(ratioOn([0, 0], [0, 0], [0, 1])).toBe(1);
    expect(ratioOn([1, 0], [0, 0], [0, 1])).toBe(Infinity);
  });
});

describe('the search', () => {
  test('a planted leader the champion lacks: found, checked once on the held-out weeks, stopped', () => {
    for (const seed of [3, 6, 8]) {
      const h = market(seed, { lead: true });
      const r = retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID });
      const res = run(r);
      expect(res, `seed ${seed}`).toMatchObject({ outcome: 'found', kept: 'new', checks: 1, looked: true });
      expect(res.spec.companions).toContain('lead');
      expect(res.ratio).toBeLessThan(GOAL);
      expect(res.was).toBeGreaterThan(0.95); // the champion: no better than no change
      // the held-out ratio is the tab's: the poll's score over no change's for the new spec
      const f = fitter({ histories: h })('gold', res.spec);
      expect(f.score / f.persist).toBeCloseTo(res.ratio, 12);
      // and it beats no change by 20 % on the last two weeks, which the search never scored
      const { bt, held } = splitOf(prepare(h.get('gold')));
      expect(ratioOn(fitterErrors(h, res.spec), bt.persist, held)).toBeLessThan(BAR);
      expect(res.tried).toBeLessThan(PATIENCE);
      expect(r.step()).toBe(res); // stopped: the same result from then on
    }
  });

  test('its power on that leader: a 30 % edge at 24 h is confirmed on 28 recent origins most of the time', () => {
    const found = Array.from({ length: 12 }, (_, i) => i + 1).filter((seed) =>
      run(retrainer({ target: 'gold', histories: market(seed, { lead: true }), champion: TIGHT, seed: ID })).outcome === 'found');
    expect(found).toEqual([3, 4, 5, 6, 8, 10, 11, 12]); // 8 of 12; the rest kept the current one
  });

  test('a pure random walk: no lucky acceptance (50 seeds); it stops by its budget and keeps the champion', () => {
    const outcomes = { found: 0, kept: 0 };
    for (let seed = 100; seed < 150; seed++) {
      const res = run(retrainer({ target: 'gold', histories: market(seed, { n: 60, others: 4 }), champion: TIGHT, seed: `${ID}${seed}` }));
      expect(['found', 'checked', 'budget', 'exhausted']).toContain(res.outcome);
      if (res.outcome === 'found') outcomes.found++;
      else if (res.kept === 'new') {
        outcomes.kept++;
        expect(res.ratio).toBeLessThan(res.was * 0.95); // (b) keeps a spec only when it beats the champion where unseen
      }
    }
    expect(outcomes.found).toBeLessThanOrEqual(1); // measured 1–2 in 100 (docs/design/models.md#retrain)
    expect(outcomes.kept).toBeLessThanOrEqual(1); // the same test against the champion
  });

  test('reproducible from alias + target + the retrain counter; another counter, another path', () => {
    const h = market(7);
    const a = run(retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID, n: 1 }));
    expect(run(retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID, n: 1 }))).toEqual(a);
    const paths = [1, 2, 3, 4].map((n) => {
      const r = retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID, n });
      for (let i = 0; i < 30; i++) r.step();
      return JSON.stringify(r.state());
    });
    expect(new Set(paths).size).toBeGreaterThan(1);
  });

  test('resumes where it was: a persisted state continues to the same result', () => {
    const h = market(1, { lead: true });
    const whole = run(retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID }));
    const first = retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID });
    for (let i = 0; i < 20; i++) expect(first.step()).toBeNull();
    const saved = JSON.parse(JSON.stringify(first.state())); // as stored
    expect(saved.tried).toBe(20);
    const again = retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID, from: saved });
    expect(again.progress().tried).toBe(20);
    expect(run(again)).toEqual(whole);
  });

  test('Stop: it ends at once and keeps the champion, without a look at the held-out origins', () => {
    const h = market(3, { lead: true });
    const r = retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID });
    const stopped = r.end('stopped');
    expect(stopped).toMatchObject({ outcome: 'stopped', kept: 'current', spec: TIGHT, tried: 0, looked: false });
    expect(r.step()).toBe(stopped);
    // stopped once it holds what a full run finds: still the champion (Stop changes nothing)
    const found = run(retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID })).spec;
    const later = retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID });
    while (keyOf(later.state().best) !== keyOf(found)) later.step();
    expect(later.end('stopped')).toMatchObject({ outcome: 'stopped', kept: 'current', spec: TIGHT, looked: false, checks: 0 });
  });

  test('the progress: tries so far and the best on the search origins, never worse than where it started', () => {
    const r = retrainer({ target: 'gold', histories: market(1, { lead: true }), champion: TIGHT, seed: ID });
    const start = r.progress();
    expect(start).toMatchObject({ tried: 0, checks: 0 });
    let last = start.best;
    for (let i = 0; i < 25 && !r.result; i++) {
      r.step();
      expect(r.progress().best).toBeLessThanOrEqual(last);
      last = r.progress().best;
    }
    expect(r.progress().tried).toBeGreaterThan(0);
  });

  test('a champion already better than no change: replaced only by one that beats it by the same test', () => {
    const h = market(2, { lead: true });
    const good = run(retrainer({ target: 'gold', histories: h, champion: TIGHT, seed: ID })).spec;
    for (const n of [2, 3, 4]) {
      const res = run(retrainer({ target: 'gold', histories: h, champion: good, seed: ID, n }));
      if (res.kept === 'new') expect(res.ratio).toBeLessThan(res.was * 0.95);
      else expect(res).toMatchObject({ spec: good, ratio: res.was });
    }
  });
});
