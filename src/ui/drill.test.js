// The Models tab's views (src/ui/drill.js): what each row, the status and the drill-in show, from models() and
// model(id) data. A fabricated model with two outputs proves the drill-in draws every output and its destinations.
import { describe, expect, test } from 'vitest';
import { drillView, rowView, statusView, chartOf, pctText, qualityText, destinationView, numText, retrainView, ratioWords } from './drill.js';
import { summaryOf, qualityOf } from '../neuron/models.js';

const H = 3600;
const q = (score, persist = 0.01, kind = 'bvar') => qualityOf({ kind, score, persist });
const hist = (n, v0, at) => Array.from({ length: n }, (_, k) => ({ ts: at - (n - 1 - k) * H, value: v0 + k }));
const AT = 1_760_000_000;

/** A future model of two streams (one VAR for both): the engine makes one per stream today; this is a fake. */
const TWO = {
  id: 'central:joint', source: 'central', name: 'bvar · 2 streams', kind: 'bvar', quality: q(0.009),
  inputs: [{ stream: 'u-gold', name: 'gold' }, { stream: 'u-silver', name: 'silver' }, { stream: 'u-oil', name: 'oil' }],
  model: { kind: 'bvar', rows: 980, tests: 28, step: 12 * H, horizon: 24 * H, weight: 0.6, phi: 0.1, coef: [0.1, 0.2, 0.3],
    lambda1: 0.2, lambda2: 0.5, generation: 7, accepted: 2, trained: AT, quality: q(0.009) },
  outputs: [
    { stream: 'u-gold', name: 'gold', latest: { value: 2600, ts: AT - 60 }, forecast: { t1: 2610, t2: 2620, value: 2620, step: 12 * H, horizon: 24 * H, at: AT },
      direction: 'up', quality: q(0.009),
      influence: [{ stream: 'u-oil', name: 'oil', share: 0.6 }, { stream: 'u-gold', name: 'gold', share: 0.3 }, { stream: 'u-silver', name: 'silver', share: 0.1 }],
      destinations: [{ to: 'network', status: 'accepted', when: AT + 30, ref: null },
        { to: 'contract', status: 'sent', when: AT + 40, ref: { round: 20743, game: 1, direction: 'up', tx: '0x' + 'ab'.repeat(32) } }],
      history: hist(48, 2550, AT - 60) },
    { stream: 'u-silver', name: 'silver', latest: { value: 31, ts: AT - 60 }, forecast: { t1: 30.9, t2: 30.5, value: 30.5, step: 12 * H, horizon: 24 * H, at: AT },
      direction: 'down', quality: q(0.012),
      influence: [{ stream: 'u-silver', name: 'silver', share: 0.9 }, { stream: 'u-gold', name: 'gold', share: 0.1 }, { stream: 'u-oil', name: 'oil', share: 0 }],
      destinations: [{ to: 'relays', status: 'published', when: AT + 50, ref: { stream: 'silver_pred', seq: 12, relays: 2 } }],
      history: hist(48, 0, AT - 60).map((p) => ({ ...p, value: 31 + Math.sin(p.ts) })) },
  ],
};

describe('the drill-in', () => {
  test('two outputs: Out draws both, each with its forecast, chart and destinations; In follows the chosen output', () => {
    const v = drillView(TWO, { now: AT + 2 * H, explorer: 'https://sepolia.basescan.org' });
    expect(v.title).toBe('bvar · 2 streams');
    expect(v.kindLabel).toBe('Bayesian VAR · reads 3 streams'); // its algorithm in plain words, under the name
    expect(v.quality).toMatchObject({ mark: 'better', short: '10% better' });
    expect(v.outputs).toHaveLength(2);
    const [gold, silver] = v.outputs;
    expect(gold).toMatchObject({ name: 'gold', arrow: '↑', forecast: 'In 12 h 2,610.00 · in 24 h 2,620.00', latest: '2,600.00' });
    expect(gold.destinations.map((d) => [d.to, d.text])).toEqual([
      ['network', expect.stringMatching(/^Accepted /)],
      ['contract', 'Round 20743 · UP · tx 0xabab…abab'],
    ]);
    expect(gold.destinations[1].href).toBe(`https://sepolia.basescan.org/tx/0x${'ab'.repeat(32)}`);
    expect(silver).toMatchObject({ name: 'silver', arrow: '↓', forecast: 'In 12 h 30.9 · in 24 h 30.5' });
    expect(silver.destinations).toEqual([{ to: 'relays', label: 'Relays', text: 'silver_pred #12 · 2 relays', href: null }]);
    for (const o of v.outputs) expect(o.chart.line).toMatch(/^M/);
    // In: the first output's inputs by default, ranked; the other output's on choosing it
    expect(v.inputs.map((i) => [i.name, i.pct, i.own])).toEqual([['oil', '60%', false], ['gold', '30%', true], ['silver', '10%', false]]);
    expect(v.choose).toEqual(['gold', 'silver']); // several outputs: a choice of whose inputs
    expect(drillView(TWO, { now: AT, output: 1 }).inputs.map((i) => [i.name, i.pct])).toEqual([['silver', '90%'], ['gold', '10%'], ['oil', '0%']]);
    const tiny = { ...TWO, outputs: [{ ...TWO.outputs[0], influence: [{ stream: 'u-oil', name: 'oil', share: 0.997 }, { stream: 'u-gold', name: 'gold', share: 0.003 }] }] };
    expect(drillView(tiny, { now: AT }).inputs.map((i) => i.pct)).toEqual(['100%', '<1%']); // a sliver is not nothing
  });

  test('one output: no choice; the Model in plain words, the jargon behind details', () => {
    const one = { ...TWO, name: 'gold', outputs: [TWO.outputs[0]] };
    const v = drillView(one, { now: AT + 2 * H });
    expect(v.choose).toBeNull();
    expect(v.model.lines).toEqual([
      'Learns how this stream moves together with silver and oil, then predicts 24 h ahead.',
      'Predicts 24 h ahead in 12 h steps',
      'Learned from 980 steps of history (12 h each)',
      'Backtest over 28 tests: 10% less error than no change',
      'Fade: 40% of the way back to no change',
      'Trained 2 h ago',
    ]);
    expect(v.model.details).toEqual(expect.arrayContaining([['λ1, λ2', '0.2, 0.5'], ['Mutations tried, kept', '7, 2'],
      ['Fade weight', '0.6'], ['Median error, no change\'s', '0.9%, 1%']]));
    const nq = q(null, null, 'naive');
    const naive = drillView({ ...one, kind: 'naive', quality: nq, model: { kind: 'naive', rows: 3, tests: 0, step: 12 * H, horizon: 24 * H, weight: null,
      trained: AT, quality: nq } }, { now: AT });
    expect(naive.kindLabel).toBe('No change · not enough history yet');
    expect(naive.quality).toMatchObject({ mark: 'tie', short: 'Same as no change' });
    // the true rule: 6 lag pairs need 8 back-to-back steps (4 days of 12 h)
    expect(naive.model.lines).toEqual(['Repeats the latest value until it has 4 days of back-to-back history.', 'Predicts 24 h ahead in 12 h steps',
      'Backtest: none, it repeats the last value (no change)', 'Trained just now']);
    expect(naive.model.details).toEqual([]);
    // every kind says what it is; a future ensemble too
    const kind = (k, o = {}) => drillView({ ...one, kind: k, ...o }, { now: AT });
    expect(kind('bar1').kindLabel).toBe('Single-stream AR (bar1)');
    expect(kind('bar1').model.lines[0]).toBe('Learns how each 12 h move of this stream follows the one before, then predicts 24 h ahead.');
    expect(kind('bar1d').kindLabel).toBe('Single-stream AR on changes (bar1d)');
    expect(kind('echo').kindLabel).toBe('Echo · the value is not a number');
    expect(kind('bvar', { algorithms: ['bvar', 'bar1', 'naive'] }).kindLabel).toBe('Ensemble · 3 algorithms');
    const hourly = { ...one, kind: 'naive', outputs: [{ ...one.outputs[0], forecast: { value: 5, step: H, horizon: H, at: AT } }] };
    expect(drillView(hourly, { now: AT }).model.lines[0]).toBe('Repeats the latest value until it has 8 h of back-to-back history.');
  });

  test('the mark in short words, the colour kept: "10% better", "Same as no change" (the phone: "Same"), "20% worse", "Not scored yet"', () => {
    expect(rowView({ ...TWO, quality: q(0.009) })).toMatchObject({ mark: 'better', markText: '10% better', markShort: '10% better' });
    expect(rowView({ ...TWO, quality: q(0.0101) })).toMatchObject({ mark: 'tie', markText: 'Same as no change', markShort: 'Same' });
    expect(rowView({ ...TWO, quality: q(null, null, 'naive') })).toMatchObject({ mark: 'tie', markText: 'Same as no change' });
    expect(rowView({ ...TWO, quality: q(0.012) })).toMatchObject({ mark: 'worse', markText: '20% worse' });
    expect(rowView({ ...TWO, quality: q(null) })).toMatchObject({ mark: 'none', markText: 'Not scored yet', markShort: 'Not scored yet' });
    expect(rowView({ ...TWO, quality: q(0.1, 0) })).toMatchObject({ mark: 'worse', markText: 'Worse' }); // no change was perfect
  });

  test('quality in words and as a short number', () => {
    expect(pctText(0.97)).toBe('−3%');
    expect(pctText(1.084)).toBe('+8%');
    expect(pctText(1)).toBe('0%');
    expect(qualityText(q(0.009))).toBe('10% less error than no change');
    expect(qualityText(q(0.012))).toBe('20% more error than no change');
    expect(qualityText(q(0.0101))).toBe('about the same as no change (1% more error)');
    expect(qualityText(q(0.0098))).toBe('about the same as no change (2% less error)');
    expect(numText(59058240589371160)).toBe('5.906e16'); // a Base registry value: a ratio × 1e18
    expect(numText(-2.5e13)).toBe('−2.500e13');
    expect(numText(2600)).toBe('2,600.00');
    expect(numText(0.0000012345)).toBe('1.234e−6'); // not "0"
    expect(numText(0)).toBe('0');
    expect(qualityText(q(null))).toBe('not scored yet (it needs 5 backtests)');
  });

  test('destinations in words: central accepted or pending; Base left out; a relay that has not taken it yet', () => {
    expect(destinationView({ to: 'network', status: 'pending', when: AT, ref: null })).toMatchObject({ label: 'Network', text: expect.stringMatching(/^Pending since /) });
    expect(destinationView({ to: 'contract', status: 'left out', when: AT, ref: { round: 5, direction: 'down', tx: null, error: 'DuplicatePrediction' } }))
      .toEqual({ to: 'contract', label: 'Contract', text: 'Round 5 · DOWN · left out: DuplicatePrediction', href: null });
    expect(destinationView({ to: 'relays', status: 'waiting', when: AT, ref: { stream: 'x_pred', seq: 1, relays: 0 } }).text).toBe('x_pred #1 · no relay yet');
    // a tie: the rule that decided (the forecast's own needs no words)
    const tie = (rule, direction) => destinationView({ to: 'contract', status: 'sent', when: AT, ref: { round: 5, direction, rule, tx: '0x' + 'ab'.repeat(32) } }).text;
    expect([tie('last-move', 'up'), tie('flat', 'down'), tie('forecast', 'up')]).toEqual(['Round 5 · UP (a tie: its last move) · tx 0xabab…abab',
      'Round 5 · DOWN (a tie, flat) · tx 0xabab…abab', 'Round 5 · UP · tx 0xabab…abab']);
  });
});

describe('the chart: recent history and the forecast to scale, the endpoint emphasized', () => {
  test('time and value scales; the forecast points after the history; the endpoint is the value sent', () => {
    const c = chartOf(TWO.outputs[0], { w: 600, h: 160 });
    expect(c.points.map((p) => p.end)).toEqual([false, true]);
    const end = c.points.at(-1);
    expect(end.x).toBeCloseTo(600 - c.pad.r, 6); // the latest time on the axis: the horizon
    expect(c.last.x).toBeLessThan(c.points[0].x);
    // one step = half the horizon, to scale
    expect(c.points[1].x - c.now).toBeCloseTo(2 * (c.points[0].x - c.now), 6);
    expect(end.y).toBeLessThan(c.last.y); // 2,620 above 2,600 (y grows down)
    expect(c.ahead.startsWith(`M${c.last.x.toFixed(1)}`)).toBe(true);
    expect(c.yLabels.map((l) => l.text)).toEqual(['2,620.00', '2,550.00']);
    // each forecast point says how far ahead it is, so the open and the filled circle need no legend
    expect(c.timeLabels.map((l) => l.text)).toEqual(['12 h', '24 h']);
    expect(c.timeLabels[0]).toMatchObject({ x: c.points[0].x, anchor: 'middle' });
    expect(c.timeLabels[1]).toMatchObject({ anchor: 'end' });
    for (const [i, l] of c.timeLabels.entries()) expect(Math.abs(l.y - c.points[i].y)).toBeGreaterThanOrEqual(8); // off the circle (r 5.5)
    const once = chartOf({ ...TWO.outputs[0], forecast: { value: 2620, step: 24 * H, horizon: 24 * H, at: AT } }, { w: 600, h: 160 });
    expect(once.timeLabels.map((l) => l.text)).toEqual(['24 h']);
    // a narrow chart (a week of history on a phone): the two points ~10 px apart; their labels are staggered, never overlapping
    const long = { ...TWO.outputs[0], history: hist(7 * 48, 2550, AT - 60) };
    const narrow = chartOf(long, { w: 300, h: 160 });
    expect(narrow.points[1].x - narrow.points[0].x).toBeLessThan(20);
    const [a, b] = narrow.timeLabels;
    const width = (l) => l.text.length * 6; // ~6 px a character at 10.5 px
    const span = (l) => (l.anchor === 'end' ? [l.x - width(l), l.x] : [l.x - width(l) / 2, l.x + width(l) / 2]);
    const apart = span(a)[1] <= span(b)[0] || span(b)[1] <= span(a)[0] || Math.abs(a.y - b.y) >= 11;
    expect(apart).toBe(true);
    for (const l of narrow.timeLabels) expect(l.y).toBeLessThanOrEqual(160 - narrow.pad.b + 13); // above the axis' labels
    expect(chartOf({ ...TWO.outputs[0], history: [] }, { w: 600, h: 160 }).line).toBe('');
    // a stretch with no observations is not drawn as if there were: the line breaks
    const gappy = TWO.outputs[0].history.filter((_, k) => k < 20 || k > 30);
    expect(chartOf({ ...TWO.outputs[0], history: gappy }, { w: 600, h: 160 }).line.match(/M/g)).toHaveLength(2);
    expect(c.line.match(/M/g)).toHaveLength(1);
  });
});

describe('the list and the status', () => {
  test('a row: the name, its kind, the inputs as chips by influence, quality, latest → forecast, where it goes', () => {
    const r = rowView(TWO);
    expect(r).toMatchObject({ name: 'bvar · 2 streams', kind: 'bvar', chips: ['+oil'], mark: 'better', markText: '10% better',
      dests: ['network', 'contract', 'relays'] });
    const one = rowView({ ...TWO, name: 'gold', outputs: [TWO.outputs[0]] });
    expect(one).toMatchObject({ name: 'gold', chips: ['+oil', '+silver'], latest: '2,600.00', forecast: '2,620.00', arrow: '↑', as: null });
    // the values labelled: now, and the forecast at its own horizon, the arrow after it
    expect(one).toMatchObject({ nowText: 'Now 2,600.00', nextText: 'in 24 h 2,620.00' });
    const hourly = rowView({ ...TWO, name: 'rain', outputs: [{ ...TWO.outputs[1], forecast: { value: 4, step: H, horizon: H, at: AT } }] });
    expect(hourly).toMatchObject({ nowText: 'Now 31', nextText: 'in 1 h 4', arrow: '↓' });
    expect(rowView({ ...TWO, name: 'btc', outputs: [{ ...TWO.outputs[1], as: 'btc_pred' }] }).as).toBe('btc_pred');
  });

  test('the status: by kind, by mark, the median against no change', () => {
    const models = [TWO, { ...TWO, kind: 'naive', quality: q(null, null, 'naive') }, { ...TWO, kind: 'bar1', quality: q(0.02) }, { ...TWO, kind: 'bar1', quality: q(null) }];
    const v = statusView(summaryOf(models));
    expect(v.kinds).toBe('4 models · 1 bvar · 2 bar1 · 1 naive');
    expect(v.marks).toBe('1 better · 1 same as no change · 1 worse · 1 not scored yet');
    // the bar's legend: the rows' words, each in its colour
    expect(v.legend).toEqual([{ mark: 'better', n: 1, text: '1 better' }, { mark: 'tie', n: 1, text: '1 same as no change' },
      { mark: 'worse', n: 1, text: '1 worse' }, { mark: 'unscored', n: 1, text: '1 not scored yet' }]);
    expect(statusView(summaryOf([TWO])).marks).toBe('1 better · 0 same as no change · 0 worse');
    expect(v.median).toBe('Median model: 45% more error than no change');
    expect(v.bar.map((s) => [s.mark, s.pct])).toEqual([['better', 25], ['tie', 25], ['worse', 25], ['unscored', 25]]);
    expect(statusView(summaryOf([])).kinds).toBe('No models yet');
  });

  test('what the quality is, in one plain line: the neuron\'s own backtest, made as it trains; not the network\'s score of what it sent', () => {
    const v = statusView(summaryOf([TWO]));
    expect(v.note).toBe("The app's own backtest, made as it trains: how each model would have done on past data against no change."
      + " Not the Satori Network's score of the predictions it sent.");
    expect(statusView(summaryOf([])).note).toBe('');
  });
});

describe('Retrain in the drill-in\'s header (docs/design/models.md#retrain)', () => {
  const model = (mark, o = {}) => ({ source: 'central', quality: { mark }, outputs: [{ forecast: { at: AT } }],
    retrain: { available: true, why: null, last: null }, ...o });
  const idle = { running: false, waiting: null, after: null, tried: 0, best: null, result: null };

  test('the button: Retrain, the accent one when the model is worse than no change or the same; Stop while it runs', () => {
    expect(retrainView(model('worse'), idle).button).toEqual({ label: 'Retrain', primary: true, action: 'retrain' });
    expect(retrainView(model('tie'), idle).button).toEqual({ label: 'Retrain', primary: true, action: 'retrain' });
    expect(retrainView(model('better'), idle).button).toEqual({ label: 'Retrain', primary: false, action: 'retrain' });
    expect(retrainView(model(null), idle).button).toEqual({ label: 'Retrain', primary: false, action: 'retrain' });
    expect(retrainView(model('worse'), { ...idle, running: true }).button).toEqual({ label: 'Stop', primary: false, action: 'stop' });
    expect(retrainView(model('worse'), undefined)).toMatchObject({ button: { label: 'Retrain' }, line: '', note: '' });
  });

  test('none for Relays and Contract models, or without the history: one muted line says why', () => {
    const v = retrainView(model('worse', { source: 'nostr', retrain: { available: false, why: 'source', last: null } }), idle);
    expect(v).toEqual({ button: null, line: '', tone: '', note: 'Retrain is for Satori Network models for now: this one reads only its own stream.' });
    expect(retrainView(model('worse', { retrain: { available: false, why: 'history', last: null } }), idle))
      .toMatchObject({ button: null, note: 'Retrain needs about four weeks of this stream\'s history.' });
  });

  test('while it runs, a line that changes: the count and the best so far; behind another; waiting for a poll', () => {
    const run = (o) => retrainView(model('worse'), { ...idle, running: true, ...o });
    expect(run({}).line).toBe('Retraining…');
    expect(run({ tried: 40, best: 1.034 })).toMatchObject({ line: 'Retraining · tried 40 · best so far 3% worse', tone: 'working' });
    expect(run({ tried: 41, best: 0.88 }).line).toBe('Retraining · tried 41 · best so far 12% better');
    expect(run({ tried: 1, best: 1.001 }).line).toBe('Retraining · tried 1 · best so far the same as no change');
    expect(run({ waiting: 'queue', after: 'eth' }).line).toBe('Retraining · after eth');
    expect(run({ waiting: 'poll', tried: 0 }).line).toBe('Retraining · waits for the poll');
    expect(run({ waiting: 'poll', tried: 40 }).line).toBe('Retraining · waits for the poll · tried 40');
  });

  test('the result in plain words, until the model next predicts; the fade line for a worse model kept', () => {
    const done = (result, mark = 'worse') => retrainView(model(mark), { ...idle, result: { at: AT + 60, tried: 340, ...result } });
    expect(done({ outcome: 'found', kept: 'new', ratio: 0.86, was: 1.12 })).toMatchObject({ line: 'Found one: 14% better. Used from the next prediction.',
      tone: 'ok', note: '' });
    expect(done({ outcome: 'checked', kept: 'current', ratio: 1.12, was: 1.12 })).toMatchObject({
      line: 'Couldn\'t find a model that beats no change. Kept the current one.', tone: '', note: 'Its fade already pulls the forecast toward no change.' });
    expect(done({ outcome: 'budget', kept: 'current', ratio: 0.99, was: 0.99 }, 'tie')).toMatchObject({
      line: 'Couldn\'t find a model that beats no change. Kept the current one.', note: '' });
    expect(done({ outcome: 'budget', kept: 'new', ratio: 1.03, was: 1.2 }).line)
      .toBe('Couldn\'t find a model that beats no change. Kept a closer one: 3% worse, was 20% worse. Used from the next prediction.');
    expect(done({ outcome: 'checked', kept: 'current', ratio: 0.8, was: 0.8 }, 'better').line).toBe('Couldn\'t find a better model. Kept the current one.');
    expect(done({ outcome: 'stopped', kept: 'current', ratio: 1.1, was: 1.1, tried: 1 }).line).toBe('Stopped after 1 try. Kept the current one.');
    expect(done({ outcome: 'stopped', kept: 'current', ratio: 1.1, was: 1.1 }).line).toBe('Stopped after 340 tries. Kept the current one.');
    expect(done({ outcome: 'error', kept: 'current', error: 'the database failed' })).toMatchObject({ line: 'Retrain failed: the database failed', tone: 'bad' });
    expect(done({ outcome: 'found', kept: 'new', ratio: 0.86, was: 1.1, note: 'same-data' }).line)
      .toBe('Already retrained on this data. Try again after its next observation.');
    // once the model predicts again (with the new champion or the old), the line goes
    expect(retrainView(model('better', { outputs: [{ forecast: { at: AT + 120 } }] }),
      { ...idle, result: { at: AT + 60, outcome: 'found', kept: 'new', ratio: 0.86 } })).toMatchObject({ line: '', note: '' });
  });

  test('ratioWords: a ratio to no change\'s error in words', () => {
    expect(ratioWords(0.86)).toBe('14% better');
    expect(ratioWords(1.2)).toBe('20% worse');
    expect(ratioWords(1.004)).toBe('the same as no change');
    expect(ratioWords(Infinity)).toBe('worse');
    expect(ratioWords(null)).toBe('–');
  });

  test('Details: the last retrain, in a line', () => {
    const d = { ...TWO, model: { ...TWO.model, retrain: { at: AT, outcome: 'found', kept: 'new', tried: 340, ms: 2140, ratio: 0.86 } } };
    const facts = Object.fromEntries(drillView(d, { now: AT + H }).model.details);
    expect(facts['Last retrain']).toMatch(/^.+ · found one, 14% better · 340 tried in 2.1 s$/);
  });
});
