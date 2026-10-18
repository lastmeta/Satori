// The Models tab's views (docs/design/models.md): what a list row, the engine's status and a model's drill-in show,
// from models() and model(id) data (src/neuron/models.js). Pure, so they are tested without a page; models.js (the
// templates) only places them. A model's outputs are a list: the drill-in draws each one with its own chart and
// destinations, and In shows the inputs of the output chosen (the only one, today).
import { fmtNum, fmtWhen, shortHash } from './format.js';
import { fmtAgo } from '../neuron/health.js';

const ARROW = { up: '↑', down: '↓', flat: '→' };
const LABEL = { central: 'Central', base: 'Base', network: 'Network' };
export const DESTS = ['central', 'base', 'network'];
const SOURCE = { central: 'Central stream', base: 'Base registry stream', nostr: 'Nostr stream' };
const KINDS = ['bvar', 'bar1', 'bar1d', 'naive', 'echo'];

const minus = (s) => s.replace(/-/g, '−');
/** A value as the app prints it; a huge one (a Base registry value, often a ratio × 1e18) in 4 digits and a power of 10. */
export const numText = (n) => (Number.isFinite(n) && n !== 0 && (Math.abs(n) >= 1e12 || Math.abs(n) < 1e-4)
  ? minus(n.toExponential(3).replace('e+', 'e')) : fmtNum(n));
const dec = (x, d = 3) => (x == null ? '–' : minus(String(Number(Number(x).toFixed(d)))));
const pct2 = (x) => `${Number((x * 100).toFixed(2))}%`;

/** A span of time in a word or two: '45 min', '12 h', '24 h', '3 days'. */
export function spanText(s) {
  if (!(s > 0)) return '–';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s <= 48 * 3600 && s % 3600 === 0) return `${s / 3600} h`;
  const n = Math.round(s / 86400);
  return n === 1 ? '1 day' : `${n} days`;
}

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

/** The row's mark: its short number, '=' for naive (no change itself), 'new' before 5 backtests. */
function markText(q) {
  if (q.mark == null) return 'new';
  if (isNaive(q)) return '=';
  return q.ratio == null ? 'worse' : pctText(q.ratio);
}

/** Where an output went, in words: central accepted or pending, Base's round and direction (and its tx), Nostr's `_pred`. */
export function destinationView(d, { explorer = null } = {}) {
  const r = d.ref ?? {};
  const view = { to: d.to, label: LABEL[d.to] ?? d.to, text: '', href: null };
  if (d.to === 'central') view.text = d.status === 'accepted' ? `Accepted ${fmtWhen(d.when)}` : `Pending since ${fmtWhen(d.when)}`;
  if (d.to === 'base') {
    const dir = String(r.direction ?? '').toUpperCase();
    view.text = d.status === 'sent' ? `Round ${r.round} · ${dir} · tx ${shortHash(r.tx)}` : `Round ${r.round} · ${dir} · left out: ${r.error}`;
    if (d.status === 'sent' && explorer && r.tx) view.href = `${explorer}/tx/${r.tx}`;
  }
  if (d.to === 'network') view.text = `${r.stream} #${r.seq} · ${r.relays > 0 ? `${r.relays} relay${r.relays === 1 ? '' : 's'}` : 'no relay yet'}`;
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
  const empty = { w, h, pad, line: '', ahead: '', points: [], last: null, now: null, grid: [], yLabels: [], xLabels: [], hover: [], endLabel: null };
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
  return {
    w, h, pad, last, points,
    // the endpoint's value, right-aligned with it: above it, or below when it is near the top
    endLabel: end ? { x: end.x + 5, y: end.y < pad.t + 16 ? end.y + 20 : end.y - 11, text: numText(end.value) } : null,
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

/** One output's block in Out. */
export function outputView(o, { explorer = null } = {}) {
  return {
    key: o.stream, name: o.name, as: o.as ?? null, arrow: ARROW[o.direction] ?? '', direction: o.direction,
    forecast: forecastText(o.forecast), latest: numText(o.latest?.value), latestWhen: o.latest?.ts ? fmtWhen(o.latest.ts) : '',
    chart: chartOf(o), destinations: o.destinations.map((d) => destinationView(d, { explorer })),
  };
}

/** The Model, in plain lines; the jargon (λ, mutations, coefficients, the weight and the errors) in details. */
function modelView(d, now) {
  const m = d.model;
  const q = m.quality ?? d.quality;
  const lines = [];
  if (m.horizon) lines.push(`Predicts ${spanText(m.horizon)} ahead in ${m.step && m.step < m.horizon ? `${spanText(m.step)} steps` : 'one step'}`);
  if (m.kind === 'naive') lines.push(`Repeats the last value until it has 6 rows of back-to-back steps${m.rows == null ? '' : ` (it has ${m.rows})`}`);
  else if (m.kind === 'echo') lines.push('Echoes the value: it is not a number');
  else if (m.rows != null) lines.push(`Learned from ${m.rows.toLocaleString('en-US')} steps of history${m.step ? ` (${spanText(m.step)} each)` : ''}`);
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
  return { lines, details };
}

const IN_NOTE = 'Each bar: how far a typical move of that stream shifts this forecast, as a share of all of them.';
const ALONE_NOTE = 'It reads only this stream.';

/** The drill-in: In (the chosen output's inputs, ranked), the Model, Out (every output). `output`: which one's inputs. */
export function drillView(d, { now = Date.now() / 1000, explorer = null, output = 0 } = {}) {
  const i = Math.max(0, Math.min(output, d.outputs.length - 1));
  const chosen = d.outputs[i];
  const inputs = (chosen?.influence ?? []).map((x) => ({ stream: x.stream, name: x.name ?? x.stream, share: x.share,
    pct: x.share == null ? '–' : x.share > 0 && x.share < 0.005 ? '<1%' : `${Math.round(x.share * 100)}%`, own: x.stream === chosen.stream }));
  return {
    title: d.name, kind: d.kind, sub: SOURCE[d.source] ?? d.source,
    quality: { mark: d.quality.mark ?? 'none', short: markText(d.quality), text: qualityText(d.quality) },
    choose: d.outputs.length > 1 ? d.outputs.map((o) => o.name) : null, output: i,
    inputs, note: inputs.length > 1 ? IN_NOTE : ALONE_NOTE,
    model: modelView(d, now),
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
  return {
    id: m.id, name: m.name, as: one?.as ?? null, kind: m.kind ?? '–', chips,
    mark: m.quality.mark ?? 'none', markText: markText(m.quality), markTitle: `vs no change: ${qualityText(m.quality)}`,
    latest: one ? numText(one.latest?.value) : '', forecast: one ? numText(one.forecast.value) : `${outs.length} forecasts`,
    arrow: one ? ARROW[one.direction] ?? '' : '', horizon: one ? spanText(one.forecast.horizon) : '',
    dests: DESTS.filter((x) => to.has(x)),
  };
}

const MARKS = ['better', 'tie', 'worse', 'unscored'];
/** What the quality is (docs/design/models.md#quality-against-no-change): the owner asked whose score it is. */
export const QUALITY_NOTE = "The neuron's own backtest, made as it trains: how each model would have done on past data against no change."
  + " Not the Satori Network's score of the predictions it sent.";

/** The engine's quality at a glance (summaryOf's): by kind, by mark (a bar of the four), the median model. */
export function statusView(s) {
  if (!s.total) return { kinds: 'No models yet', marks: '', median: '', bar: [], note: '' };
  const kinds = Object.keys(s.kinds).sort((a, b) => (KINDS.indexOf(a) + 1 || 99) - (KINDS.indexOf(b) + 1 || 99));
  const m = s.marks;
  const median = s.median == null ? '' : `Median model: ${Math.abs(s.median - 1) < 0.005 ? 'the same error as no change'
    : s.median < 1 ? `${Math.round((1 - s.median) * 100)}% less error than no change` : `${Math.round((s.median - 1) * 100)}% more error than no change`}`;
  return {
    kinds: `${s.total} model${s.total === 1 ? '' : 's'} · ${kinds.map((k) => `${s.kinds[k]} ${k}`).join(' · ')}`,
    marks: `Beats no change on ${m.better} of ${s.total} · ties ${m.tie} · worse ${m.worse}${m.unscored ? ` · ${m.unscored} not scored yet` : ''}`,
    median,
    bar: MARKS.filter((k) => m[k] > 0).map((k) => ({ mark: k, n: m[k], pct: (m[k] / s.total) * 100 })),
    note: QUALITY_NOTE,
  };
}
