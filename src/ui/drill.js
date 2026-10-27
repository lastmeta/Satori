// The Models tab's views (docs/design/models.md): what a list row, the engine's status and a model's drill-in show,
// from models() and model(id) data (src/neuron/models.js). Pure, so they are tested without a page; models.js (the
// templates) only places them. A model's outputs are a list: the drill-in draws each one with its own chart and
// destinations, and In shows the inputs of the output chosen (the only one, today).
import { fmtNum, fmtWhen, shortHash } from './format.js';
import { recordChart } from './record.js';
import { fmtAgo } from '../neuron/health.js';
import { spanText, markWords, kindLabelOf, descriptionOf, DESTS } from '../neuron/models.js';

export { spanText, DESTS };

const ARROW = { up: '↑', down: '↓', flat: '→' };
// by the words people see (docs/intent/ui.md): the Satori Network (free), the Satori contract (uses gas), the Satori relays
const LABEL = { network: 'Network', contract: 'Contract', relays: 'Relays' };
const SOURCE = { central: 'Satori Network stream', base: 'Satori contract stream', nostr: 'Stream on the Satori relays' };
const KINDS = ['bvar', 'bar1', 'bar1d', 'naive', 'echo'];

const minus = (s) => s.replace(/-/g, '−');
/** A value as the app prints it; a huge one (a Base registry value, often a ratio × 1e18) in 4 digits and a power of 10. */
export const numText = (n) => (Number.isFinite(n) && n !== 0 && (Math.abs(n) >= 1e12 || Math.abs(n) < 1e-4)
  ? minus(n.toExponential(3).replace('e+', 'e')) : fmtNum(n));
const dec = (x, d = 3) => (x == null ? '–' : minus(String(Number(Number(x).toFixed(d)))));
const pct2 = (x) => `${Number((x * 100).toFixed(2))}%`;

/** A ratio to no change's error as a short signed number: '−3%', '+8%', '0%'. */
export function pctText(ratio) {
  const n = Math.round((ratio - 1) * 100);
  return n < 0 ? `−${-n}%` : n > 0 ? `+${n}%` : '0%';
}

const isNaive = (q) => q.mark === 'tie' && q.ratio === 1 && q.error == null;

/** A model's quality in words (qualityOf's). */
export function qualityText(q) {
  if (!q || q.mark == null) return 'not scored yet (it needs 5 backtests)';
  if (isNaive(q)) return 'the same as no change: it is the last value';
  if (q.ratio == null) return 'more error than no change';
  if (q.mark === 'better') return `${Math.round((1 - q.ratio) * 100)}% less error than no change`;
  if (q.mark === 'worse') return `${Math.round((q.ratio - 1) * 100)}% more error than no change`;
  const n = Math.round((q.ratio - 1) * 100);
  return `about the same as no change (${n < 0 ? `${-n}% less error` : n > 0 ? `${n}% more error` : 'the same error'})`;
}

/** The mark in words ('10% better', 'Same as no change', 'Not scored yet'); `short`: the phone's ('Same'). */
const markText = (q) => q.text ?? markWords(q);
const markShort = (q) => (q.mark === 'tie' ? 'Same' : markText(q));

const TIE_RULE = { 'last-move': ' (a tie: its last move)', flat: ' (a tie, flat)' };

/** Where an output went, in words: central accepted or pending, Base's round and direction (and its tx), Nostr's `_pred`. */
export function destinationView(d, { explorer = null } = {}) {
  const r = d.ref ?? {};
  const view = { to: d.to, label: LABEL[d.to] ?? d.to, text: '', href: null };
  if (d.to === 'network') view.text = d.status === 'accepted' ? `Accepted ${fmtWhen(d.when)}` : `Pending since ${fmtWhen(d.when)}`;
  if (d.to === 'contract') {
    const dir = String(r.direction ?? '').toUpperCase() + (TIE_RULE[r.rule] ?? ''); // a tie: the rule that decided
    view.text = d.status === 'sent' ? `Round ${r.round} · ${dir} · tx ${shortHash(r.tx)}` : `Round ${r.round} · ${dir} · left out: ${r.error}`;
    if (d.status === 'sent' && explorer && r.tx) view.href = `${explorer}/tx/${r.tx}`;
  }
  if (d.to === 'relays') view.text = `${r.stream} #${r.seq} · ${r.relays > 0 ? `${r.relays} relay${r.relays === 1 ? '' : 's'}` : 'no relay yet'}`;
  return view;
}

/** The forecast in words: one step and the horizon ('In 12 h 2,610.00 · in 24 h 2,620.00'), or the one value. */
function forecastText(f) {
  if (f.value == null) return 'No forecast: the value is not a number';
  if (f.t1 != null && f.step && f.step < f.horizon) return `In ${spanText(f.step)} ${numText(f.t1)} · in ${spanText(f.horizon)} ${numText(f.value)}`;
  return `In ${spanText(f.horizon)} ${numText(f.value)}`;
}

/** The forecast's points in time: one step and the horizon (t1 and the value sent), or the value alone. */
function forecastPoints(f, at) {
  if (f.value == null || at == null) return [];
  if (f.t1 != null && f.step && f.step < f.horizon) return [[at + f.step, f.t1], [at + f.horizon, f.value]];
  return [[at + f.horizon, f.value]];
}

/**
 * The output's chart, in a w × h box drawn px for px: the recent history as a line (broken where the observations
 * stop for over four of their usual intervals), the forecast to scale in time and value, dashed from the last point,
 * its endpoint (the value sent) emphasized; `now`: when it was made; the range's top and bottom as hairlines with
 * their values just outside the plot, the first time and the horizon under it. `hover`: every point, for the readout.
 */
export function chartOf(o, { w = 600, h = 160 } = {}) {
  const pad = { l: 6, r: 10, t: 18, b: 34 }; // above: the top value; below: the bottom value, then the times
  const hist = o.history ?? [];
  const at = o.forecast.at ?? hist.at(-1)?.ts ?? null;
  const fc = forecastPoints(o.forecast, at);
  const empty = { w, h, pad, line: '', ahead: '', points: [], last: null, now: null, grid: [], yLabels: [], xLabels: [], hover: [], endLabel: null,
    timeLabels: [] };
  if (!hist.length) return empty;
  const all = [...hist.map((p) => [p.ts, p.value]), ...fc];
  const ts = all.map(([t]) => t);
  const vs = all.map(([, v]) => v);
  const [x0, x1] = [Math.min(...ts), Math.max(...ts)];
  let [y0, y1] = [Math.min(...vs), Math.max(...vs)];
  if (y0 === y1) [y0, y1] = [y0 - (Math.abs(y0) || 1) * 0.01, y1 + (Math.abs(y1) || 1) * 0.01];
  const X = (t) => pad.l + (x1 === x0 ? 0.5 : (t - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + ((y1 - v) / (y1 - y0)) * (h - pad.t - pad.b);
  const xy = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  const lastP = hist.at(-1);
  const dts = hist.slice(1).map((p, i) => p.ts - hist[i].ts).sort((a, b) => a - b);
  const gap = dts.length ? 4 * dts[dts.length >> 1] : Infinity;
  const last = { x: X(lastP.ts), y: Y(lastP.value) };
  const points = fc.map(([t, v], i) => ({ x: X(t), y: Y(v), ts: t, value: v, end: i === fc.length - 1 }));
  const end = points.at(-1);
  const endBelow = end && end.y < pad.t + 16;
  return {
    w, h, pad, last, points,
    // the endpoint's value, right-aligned with it: above it, or below when it is near the top
    endLabel: end ? { x: end.x + 5, y: endBelow ? end.y + 20 : end.y - 11, text: numText(end.value) } : null,
    timeLabels: timeLabelsOf(points, at, { h, pad, endBelow }),
    line: hist.map((p, i) => `${i && p.ts - hist[i - 1].ts <= gap ? 'L' : 'M'}${xy(X(p.ts), Y(p.value))}`).join(' '),
    ahead: points.length ? `M${xy(last.x, last.y)} ${points.map((p) => `L${xy(p.x, p.y)}`).join(' ')}` : '',
    now: at == null ? null : X(at),
    grid: [pad.t, h - pad.b],
    yLabels: [{ y: pad.t - 5, text: numText(Math.max(...vs)) }, { y: h - pad.b + 13, text: numText(Math.min(...vs)) }],
    xLabels: [{ x: X(x0), text: fmtWhen(x0) }, { x: X(x1), text: `+${spanText(o.forecast.horizon)}` }],
    hover: [...hist.map((p) => ({ x: X(p.ts), y: Y(p.value), ts: p.ts, value: p.value, ahead: false })),
      ...points.map((p) => ({ ...p, ahead: true }))],
  };
}

/**
 * How far ahead each forecast point is ("12 h", "24 h"), so the open and the filled circle need no legend: under each
 * point (over the endpoint when its value label is under it). Two points too close for both (a week of history on a
 * phone puts them ~10 px apart): staggered a line apart, each right-aligned at its point.
 */
function timeLabelsOf(points, at, { h, pad, endBelow }) {
  const floor = h - pad.b + 13; // the bottom value's line: never lower
  const crowded = points.length === 2 && points[1].x - points[0].x < 40;
  const dir = endBelow ? -1 : 1; // under the points, or over them when the endpoint's value is under it
  const y0 = (p) => (dir > 0 ? Math.min(p.y + 17, floor) : Math.max(p.y - 10, 10));
  if (!crowded) {
    return points.map((p) => ({ x: p.end ? p.x + 5 : p.x, anchor: p.end ? 'end' : 'middle', text: spanText(p.ts - at),
      y: p.end ? y0(p) : Math.min(p.y + 17, floor) }));
  }
  const [m, e] = points;
  const near = dir > 0 ? Math.min(Math.max(m.y, e.y) + 17, floor - 12) : Math.max(Math.min(m.y, e.y) - 10, 22);
  return [{ x: m.x + 3, anchor: 'end', text: spanText(m.ts - at), y: near },
    { x: e.x + 5, anchor: 'end', text: spanText(e.ts - at), y: near + 12 * dir }];
}

/** One output's block in Out. */
export function outputView(o, { explorer = null } = {}) {
  return {
    key: o.stream, name: o.name, as: o.as ?? null, arrow: ARROW[o.direction] ?? '', direction: o.direction,
    forecast: forecastText(o.forecast), latest: numText(o.latest?.value), latestWhen: o.latest?.ts ? fmtWhen(o.latest.ts) : '',
    chart: chartOf(o), outcomes: outcomesView(o), destinations: o.destinations.map((d) => destinationView(d, { explorer })),
  };
}

/**
 * How it did: what it forecast for each of the last outcomes (dashed) and what came (solid), the Prediction Streams
 * card's chart (src/ui/record.js); below two outcomes, only when it will show; null when not read (Base's).
 */
export function outcomesView(o) {
  if (!o.outcomes) return null; // not read (Base's)
  const n = o.outcomes.length;
  const c = recordChart(o.outcomes ?? []);
  if (!c) return { n, note: `It shows once two of its forecasts have come due (${n} so far): each is for ${spanText(o.forecast.horizon)} after it was made.` };
  return { ...c, caption: `the last ${c.n} outcomes, from ${c.bottom} to ${c.top}; each forecast made ${spanText(o.forecast.horizon)} before` };
}

/** The Model, in plain lines (how it works first); the jargon (λ, mutations, coefficients, the weight, the errors) in details. */
function modelView(d, now, description) {
  const m = d.model;
  const q = m.quality ?? d.quality;
  const lines = description ? [description] : [];
  if (m.horizon) lines.push(`Predicts ${spanText(m.horizon)} ahead in ${m.step && m.step < m.horizon ? `${spanText(m.step)} steps` : 'one step'}`);
  if (m.kind !== 'naive' && m.kind !== 'echo' && m.rows != null) lines.push(`Learned from ${m.rows.toLocaleString('en-US')} steps of history${m.step ? ` (${spanText(m.step)} each)` : ''}`);
  if (m.kind === 'naive') lines.push('Backtest: none, it repeats the last value (no change)');
  else if (m.kind !== 'echo') lines.push(`Backtest${q?.mark != null && m.tests ? ` over ${m.tests} tests` : ''}: ${qualityText(q)}`);
  if (m.weight != null) {
    lines.push(m.weight >= 1 ? 'Fade: none, its forecast is sent as is' : m.weight <= 0 ? 'Fade: all the way, it sends no change'
      : `Fade: ${Math.round((1 - m.weight) * 100)}% of the way back to no change`);
  }
  if (m.trained != null) lines.push(`Trained ${fmtAgo(now - m.trained)}`);
  const details = [];
  if (m.lambda1 != null) details.push(['λ1, λ2', `${m.lambda1}, ${m.lambda2}`], ['Mutations tried, kept', `${m.generation}, ${m.accepted}`]);
  if (m.coef?.length) details.push(['Coefficients', m.coef.map((c, i) => `${d.inputs[i]?.name ?? '?'} ${dec(c)}`).join(' · ')]);
  else if (m.phi != null) details.push(['φ (own last step)', dec(m.phi)]);
  if (m.weight != null) details.push(['Fade weight', dec(m.weight, 2)]);
  if (q?.error != null && q?.noChange != null) details.push(["Median error, no change's", `${pct2(q.error)}, ${pct2(q.noChange)}`]);
  if (m.rows != null && m.tests != null && m.kind !== 'naive') details.push(['Rows, backtests', `${m.rows}, ${m.tests}`]);
  if (m.retrain?.at) details.push(['Last retrain', lastRetrain(m.retrain)]);
  return { lines, details };
}

/** A ratio to no change's error in words: '14% better', '3% worse', 'the same as no change'. */
export function ratioWords(r) {
  if (r == null || Number.isNaN(r)) return '–';
  if (!Number.isFinite(r)) return 'worse';
  const n = Math.round((r - 1) * 100);
  return n < 0 ? `${-n}% better` : n > 0 ? `${n}% worse` : 'the same as no change';
}
const tries = (n) => `${n} ${n === 1 ? 'try' : 'tries'}`;
const OUTCOME = { found: 'found one', stopped: 'stopped', error: 'failed', history: 'too little history' };
/** Details' line for the last retrain: 'Oct 18, 21:40 · found one, 14% better · 340 tried in 2.1 s'. */
function lastRetrain(r) {
  const what = r.kept === 'new' ? `${OUTCOME[r.outcome] ?? 'kept a closer one'}, ${ratioWords(r.ratio)}` : OUTCOME[r.outcome] ?? 'kept the current one';
  return `${fmtWhen(r.at)} · ${what} · ${r.tried} tried in ${(r.ms / 1000).toFixed(1)} s`;
}

const GOAL = 0.95; // better than no change: the tab's rule (src/engine/retrain.js GOAL)
/** The last retrain's result in plain words (docs/design/models.md#retrain). → { line, tone, note } */
function resultWords(r) {
  if (r.note === 'same-data') return { line: 'Already retrained on this data. Try again after its next observation.', tone: '', note: '' };
  if (r.outcome === 'error') return { line: `Retrain failed: ${r.error}`, tone: 'bad', note: '' };
  if (r.outcome === 'history') return { line: 'Retrain needs about four weeks of this stream\'s history.', tone: '', note: '' };
  const next = 'Used from the next prediction.';
  if (r.kept === 'new' && r.ratio < GOAL) return { line: `Found one: ${Math.round((1 - r.ratio) * 100)}% better. ${next}`, tone: 'ok', note: '' };
  if (r.outcome === 'stopped') return { line: `Stopped after ${tries(r.tried)}. Kept the current one.`, tone: '', note: '' };
  if (r.kept === 'new') {
    return { line: `Couldn't find a model that beats no change. Kept a closer one: ${ratioWords(r.ratio)}, was ${ratioWords(r.was)}. ${next}`,
      tone: '', note: '' };
  }
  if (r.was < GOAL) return { line: 'Couldn\'t find a better model. Kept the current one.', tone: '', note: '' };
  // a model worse than no change kept: its fade already pulls what it sends toward no change (engine.md)
  return { line: 'Couldn\'t find a model that beats no change. Kept the current one.', tone: '',
    note: r.was > 1 ? 'Its fade already pulls the forecast toward no change.' : '' };
}

/**
 * Retrain in the drill-in's header (docs/design/models.md#retrain): the button (Retrain, the accent one when the model
 * is worse than no change or the same; Stop while it runs), a line that changes while it runs, then the result until
 * the model next predicts, and a muted note (the fade; or why there is no button). `s`: the runner's status for it.
 * → { button: { label, primary, action } | null, line, tone: 'working' | 'ok' | 'bad' | '', note }
 */
export function retrainView(d, s = null) {
  const r = d?.retrain;
  if (!r?.available && !s?.running) {
    const note = !r || r.why === 'source' ? 'Retrain is for Satori Network models for now: this one reads only its own stream.'
      : 'Retrain needs about four weeks of this stream\'s history.';
    return { button: null, line: '', tone: '', note };
  }
  if (s?.running) {
    const line = s.waiting === 'queue' ? `Retraining · after ${s.after}`
      : s.waiting === 'poll' ? `Retraining · waits for the poll${s.tried ? ` · tried ${s.tried}` : ''}`
        : s.tried ? `Retraining · tried ${s.tried} · best so far ${ratioWords(s.best)}` : 'Retraining…';
    return { button: { label: 'Stop', primary: false, action: 'stop' }, line, tone: 'working', note: '' };
  }
  const button = { label: 'Retrain', primary: d.quality?.mark === 'worse' || d.quality?.mark === 'tie', action: 'retrain' };
  const res = s?.result;
  const made = Math.max(...d.outputs.map((o) => o.forecast?.at ?? -Infinity));
  if (!res || (res.note !== 'same-data' && !(res.at > made))) return { button, line: '', tone: '', note: '' };
  return { button, ...resultWords(res) };
}

const ALONE_NOTE = 'It reads only this stream.';

/** The drill-in: In (the chosen output's inputs, ranked), the Model, Out (every output). `output`: which one's inputs. */
export function drillView(d, { now = Date.now() / 1000, explorer = null, output = 0 } = {}) {
  const i = Math.max(0, Math.min(output, d.outputs.length - 1));
  const chosen = d.outputs[i];
  const inputs = (chosen?.influence ?? []).map((x) => ({ stream: x.stream, name: x.name ?? x.stream, share: x.share,
    pct: x.share == null ? '–' : x.share > 0 && x.share < 0.005 ? '<1%' : `${Math.round(x.share * 100)}%`, own: x.stream === chosen.stream }));
  const algorithms = d.algorithms ?? [d.kind];
  return {
    title: d.name, kind: d.kind, sub: SOURCE[d.source] ?? d.source,
    kindLabel: d.kindLabel ?? kindLabelOf({ algorithms, inputs: d.inputs }), // always shown under the name
    quality: { mark: d.quality.mark ?? 'none', short: markText(d.quality), text: qualityText(d.quality) },
    choose: d.outputs.length > 1 ? d.outputs.map((o) => o.name) : null, output: i,
    inputs, note: inputs.length > 1 ? '' : ALONE_NOTE,
    model: modelView(d, now, d.description ?? descriptionOf({ algorithms, inputs: d.inputs, outputs: d.outputs })),
    outputs: d.outputs.map((o) => outputView(o, { explorer })),
  };
}

/** A list row: the name, the kind, the other inputs as chips (by influence), the mark, latest → forecast, where it goes. */
export function rowView(m) {
  const outs = m.outputs;
  const one = outs.length === 1 ? outs[0] : null;
  const own = new Set(outs.map((o) => o.stream));
  const chips = (outs[0]?.influence ?? m.inputs).filter((x) => !own.has(x.stream)).map((x) => `+${x.name ?? x.stream}`);
  const to = new Set(outs.flatMap((o) => o.destinations.map((d) => d.to)));
  const horizon = one ? spanText(one.forecast.horizon) : '';
  const latest = one ? numText(one.latest?.value) : '';
  const forecast = one ? numText(one.forecast.value) : `${outs.length} forecasts`;
  return {
    id: m.id, name: m.name, as: one?.as ?? null, kind: m.kind ?? '–', chips,
    mark: m.quality.mark ?? 'none', markText: markText(m.quality), markShort: markShort(m.quality),
    markTitle: `vs no change: ${qualityText(m.quality)}`,
    latest, forecast, arrow: one ? ARROW[one.direction] ?? '' : '', horizon,
    // the values labelled: now, and the forecast at its horizon (the arrow after it: the way it goes from now)
    nowText: one ? `Now ${latest}` : '', nextText: one ? `in ${horizon} ${forecast}` : forecast,
    dests: DESTS.filter((x) => to.has(x)),
  };
}

const MARKS = ['better', 'tie', 'worse', 'unscored'];
const MARK_WORDS = { better: 'better', tie: 'same as no change', worse: 'worse', unscored: 'not scored yet' };
/** The engine's quality at a glance (summaryOf's): by kind, by mark (a bar of the four). */
export function statusView(s) {
  if (!s.total) return { kinds: 'No models yet', marks: '', bar: [], legend: [] };
  const kinds = Object.keys(s.kinds).sort((a, b) => (KINDS.indexOf(a) + 1 || 99) - (KINDS.indexOf(b) + 1 || 99));
  const m = s.marks;
  // the bar's legend in the rows' words, each in its colour; not scored only when there are some
  const legend = MARKS.filter((k) => k !== 'unscored' || m[k] > 0).map((k) => ({ mark: k, n: m[k], text: `${m[k]} ${MARK_WORDS[k]}` }));
  return {
    kinds: `${s.total} model${s.total === 1 ? '' : 's'} · ${kinds.map((k) => `${s.kinds[k]} ${k}`).join(' · ')}`,
    marks: legend.map((x) => x.text).join(' · '),
    legend,
    bar: MARKS.filter((k) => m[k] > 0).map((k) => ({ mark: k, n: m[k], pct: (m[k] / s.total) * 100 })),
  };
}
