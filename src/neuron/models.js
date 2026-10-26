// The Models tab (docs/design/models.md): every model the neuron runs, named for the stream it predicts, with its
// quality against no change (the engine's own rolling backtest), its inputs ranked by how much each moves the
// forecast, and its outputs, each with where it went. A model's outputs are a list: today each predicts one stream;
// a model of several (one VAR or a network for all) fills `name` with something like "bvar · 3 streams".
//
//   modelsOf({ streams, subscriptions, lastBatch, baseFits }) → [model]    pure: from what the app already holds (each
//     model's backtest is kept with it, by the poll, the Nostr intake, the Base batch or the training pass: train.js)
//   summaryOf(models), engineStatus({ summary, central, work, now })      the tab's top
//   sortModels(list, 'quality' | 'name'), filterModels(list, ['network', 'contract', 'relays']), toggleDest(selected, to)
//   await modelDetail({ db, id, streams, subscriptions, lastBatch, baseHistory })   one model, recomputed on demand, with
//     `retrain`: whether Retrain is offered ({ available, why: null | 'source' | 'history', last: the last result })
import { explainModel } from '../engine/evolve.js';
import { TIE, classify, worded, markWords, qualityOf } from './quality.js';
import { canRetrain } from '../engine/retrain.js';
import { explainForecast, STEP_S, HORIZON_STEPS, median } from '../engine/index.js';
import { UP } from '../chain/index.js';
import { DEFAULT_CADENCE_S, RELAY_WINDOW } from './nostr.js';
import { fmtAgo, fmtIn } from './health.js';
import { outcomePairs } from './outcomes.js';

export { TIE, markWords, qualityOf };
/** The chart's history: this many horizons back from when the forecast was made, at most HISTORY_POINTS. */
export const HISTORY_HORIZONS = 7;
export const HISTORY_POINTS = 400;

const CENTRAL_HORIZON = HORIZON_STEPS * STEP_S;
const parse = (text) => {
  try { return text == null ? null : JSON.parse(text); } catch { return null; }
};
const num = (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const direction = (forecast, latest) => (forecast == null || latest == null ? null
  : forecast > latest ? 'up' : forecast < latest ? 'down' : 'flat');

/** A span of time in a word or two: '45 min', '12 h', '24 h', '3 days'. */
export function spanText(s) {
  if (!(s > 0)) return '–';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s <= 48 * 3600 && s % 3600 === 0) return `${s / 3600} h`;
  const n = Math.round(s / 86400);
  return n === 1 ? '1 day' : `${n} days`;
}

/** A model with several outputs: the median of their ratios (one output: its own). */
export function qualityOfAll(list) {
  if (list.length === 1) return list[0];
  const ratios = list.map((q) => q.ratio).filter(Number.isFinite);
  if (!ratios.length) return worded({ mark: null, ratio: null, error: null, noChange: null });
  const ratio = median(ratios);
  return worded({ mark: classify(ratio), ratio, error: null, noChange: null });
}

/** The fewest back-to-back steps a model needs before it leaves no change: 6 lag pairs (engine.md, `bar1` step 4). */
export const NAIVE_STEPS = 8;
const ALGORITHMS = { bvar: 'Bayesian VAR', bar1: 'Single-stream AR (bar1)', bar1d: 'Single-stream AR on changes (bar1d)',
  naive: 'No change · not enough history yet', echo: 'Echo · the value is not a number' };
const listText = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * Its algorithm in plain words, always shown under a model's name: "Bayesian VAR · reads 3 streams", "Single-stream AR
 * (bar1)", "No change · not enough history yet"; a model of several algorithms (an ensemble, later): "Ensemble · 3
 * algorithms". `algorithms`: a list, one today.
 */
export function kindLabelOf({ algorithms, inputs = [] }) {
  if (algorithms.length > 1) return `Ensemble · ${algorithms.length} algorithms`;
  const [k] = algorithms;
  if (k === 'bvar') return `${ALGORITHMS.bvar} · reads ${inputs.length} stream${inputs.length === 1 ? '' : 's'}`;
  return ALGORITHMS[k] ?? k;
}

/** How it works, in one plain sentence (the drill-in's Model), with the true rule for no change. */
export function descriptionOf({ algorithms, inputs = [], outputs }) {
  const o = outputs[0];
  const h = spanText(o.forecast.horizon);
  const step = o.forecast.step ?? o.forecast.horizon;
  if (algorithms.length > 1) return `Combines ${algorithms.length} algorithms, then predicts ${h} ahead.`;
  const others = inputs.filter((i) => i.stream !== o.stream).map((i) => i.name ?? i.stream);
  switch (algorithms[0]) {
    case 'bvar': return `Learns how this stream moves together with ${listText(others)}, then predicts ${h} ahead.`;
    case 'bar1': return `Learns how each ${spanText(step)} move of this stream follows the one before, then predicts ${h} ahead.`;
    case 'bar1d': return `Learns how each ${spanText(step)} change of this stream follows the one before, then predicts ${h} ahead.`;
    case 'naive': return `Repeats the latest value until it has ${spanText(NAIVE_STEPS * step)} of back-to-back history.`;
    case 'echo': return 'Passes the latest value on as it is: it is not a number, so there is nothing to forecast.';
    default: return '';
  }
}

/** Influence, largest first (inputs whose share is unknown keep their order, after the known). */
const ranked = (list) => [...list].sort((a, b) => (b.share ?? -1) - (a.share ?? -1));

/** A model from its outputs: named for its one output, or "<kind> · n streams"; what it is and how it works, in words. */
function modelOf({ id, source, kind, inputs, outputs, trained, algorithms = [kind], ...rest }) {
  const name = outputs.length === 1 ? outputs[0].name : `${kind} · ${outputs.length} streams`;
  return { id, source, name, kind, algorithms, kindLabel: kindLabelOf({ algorithms, inputs }),
    description: descriptionOf({ algorithms, inputs, outputs }), quality: qualityOfAll(outputs.map((o) => o.quality)), inputs, outputs,
    trained, ...rest };
}

/**
 * Central's models, from db.streams() rows (a stream with no forecast yet is no model yet). A bvar forecast reads its
 * spec's companions, with the shares the poll kept (null before migration 11); bar1 and naive read the stream alone.
 * Also the fields models() had before (uuid, model, spec, score, generation, accepted).
 */
export function centralModels(rows) {
  const names = new Map(rows.map((r) => [r.uuid, r.name]));
  const named = (u) => ({ stream: u, name: names.get(u) ?? null });
  return rows.filter((r) => r.model).map((r) => {
    const spec = parse(r.spec);
    const bvar = r.model === 'bvar';
    const inputs = [r.uuid, ...(bvar ? spec?.companions ?? [] : [])];
    const shares = bvar ? parse(r.influence) : [1];
    const quality = qualityOf({ kind: r.model, score: r.score, persist: r.persist });
    const sent = r.status === 'sent';
    // trained: when it was last fit (the poll that made its forecast, or the training pass after it)
    const trained = Math.max(r.made_at ?? -Infinity, r.spec_at ?? -Infinity);
    return modelOf({
      id: `central:${r.uuid}`, source: 'central', kind: r.model, inputs: inputs.map(named), trained: Number.isFinite(trained) ? trained : null,
      outputs: [{
        stream: r.uuid, name: r.name, latest: { value: r.obs_value ?? null, ts: r.obs_ts ?? null },
        forecast: { t1: r.t1, t2: r.t2, value: r.t2, step: STEP_S, horizon: CENTRAL_HORIZON, at: r.made_at },
        direction: direction(r.t2, r.obs_value),
        influence: ranked(inputs.map((u, i) => ({ ...named(u), share: shares?.[i] ?? null }))),
        quality,
        destinations: [{ to: 'network', status: sent ? 'accepted' : 'pending', when: sent ? r.sent_at : r.made_at, ref: null }],
      }],
      uuid: r.uuid, model: r.model,
      spec: spec && { companions: spec.companions.map((u) => ({ uuid: u, name: names.get(u) ?? null })), lambda1: spec.lambda1, lambda2: spec.lambda2 },
      score: r.score ?? null, generation: r.generation ?? null, accepted: r.accepted ?? null,
    });
  });
}

const cadenceOf = (s) => (s.cadence_seconds > 0 ? s.cadence_seconds : DEFAULT_CADENCE_S);

/**
 * The Nostr models: each subscription's `<stream>_pred`, one cadence ahead, published to the relays (none before its
 * first observation), with the backtest kept with it (score, persist).
 */
export function nostrModels(subscriptions) {
  return subscriptions.filter((s) => s.prediction).map((s) => {
    const p = s.prediction;
    const name = s.name || s.stream;
    const cadence = cadenceOf(s);
    const value = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(p.value ?? '') ? Number(p.value) : null;
    const latest = s.observation?.value ?? null;
    const quality = qualityOf({ kind: p.model, score: p.score ?? null, persist: p.persist ?? null });
    return modelOf({
      id: `nostr:${s.uuid}`, source: 'nostr', kind: p.model, inputs: [{ stream: s.uuid, name }], trained: p.made_at,
      outputs: [{
        stream: s.uuid, name, as: p.stream, latest: { value: latest, ts: s.observation?.ts ?? null },
        forecast: { value, step: cadence, horizon: cadence, at: p.made_at }, direction: direction(value, latest),
        influence: [{ stream: s.uuid, name, share: 1 }], quality,
        destinations: [{ to: 'relays', status: p.relays > 0 ? 'published' : 'waiting', when: p.made_at,
          ref: { stream: p.stream, seq: p.seq, relays: p.relays } }],
      }],
    });
  });
}

/**
 * The Base models: the last batch's games, and those left out after a forecast (by their simulate), each with the
 * backtest kept with it, or for a batch before they were, the training pass's (baseFits: `<hash>:<stream id>` → fit).
 */
export function baseModels(batch, baseFits = new Map()) {
  if (!batch) return [];
  // a game with no model (no values yet: sent by the no-opinion rule) has no forecast to show
  const all = [...batch.games.filter((g) => g.model).map((g) => [g, true]), ...(batch.dropped ?? []).filter((g) => g.model).map((g) => [g, false])];
  return all.map(([g, sent]) => {
    const name = `${g.named ? 'Sentiment stream' : 'Stream'} ${g.streamId}`;
    const stream = String(g.streamId);
    const dir = g.direction === UP ? 'up' : 'down'; // as sent (a tie follows the stream's last move: g.rule)
    const fit = 'tests' in g || 'score' in g ? g : baseFits.get(`${batch.hash ?? batch.round}:${g.streamId}`) ?? {};
    const quality = qualityOf({ kind: g.model, score: fit.score ?? null, persist: fit.persist ?? null });
    return modelOf({
      id: `base:${stream}`, source: 'base', kind: g.model, inputs: [{ stream, name }], trained: batch.at,
      outputs: [{
        stream, name, latest: { value: num(g.latest), ts: null },
        forecast: { value: num(g.forecast), step: g.step ?? null, horizon: g.horizon, at: batch.at }, direction: dir,
        influence: [{ stream, name, share: 1 }], quality,
        destinations: [{ to: 'contract', status: sent ? 'sent' : 'left out', when: batch.at,
          ref: { round: batch.round, game: g.gameId, direction: dir, ...(g.rule ? { rule: g.rule } : {}), tx: sent ? batch.hash : null,
            ...(sent ? {} : { error: g.error }) } }],
      }],
    });
  });
}

/** Every model the neuron runs: central's, then Base's, then Nostr's. */
export const modelsOf = ({ streams = [], subscriptions = [], lastBatch = null, baseFits } = {}) =>
  [...centralModels(streams), ...baseModels(lastBatch, baseFits), ...nostrModels(subscriptions)];

/**
 * The tab's top: how many models by kind, by mark, and the median ratio of the models with a backtest (naive, which
 * is no change, and the not scored left out); trained: the newest forecast's time.
 */
export function summaryOf(models) {
  const kinds = {};
  const marks = { better: 0, tie: 0, worse: 0, unscored: 0 };
  for (const m of models) {
    kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
    marks[m.quality.mark ?? 'unscored']++;
  }
  const ratios = models.filter((m) => m.kind !== 'naive').map((m) => m.quality.ratio).filter(Number.isFinite);
  const trained = models.map((m) => m.trained).filter(Number.isFinite);
  return { total: models.length, kinds, marks, median: ratios.length ? median(ratios) : null, scored: ratios.length,
    trained: trained.length ? Math.max(...trained) : null };
}

/**
 * The engine at a glance: 'Working' while the poll or the Base batch runs (the step, paced as Home's hero: `work`
 * { line, critical }), 'Needs a look' (amber) only when the engine itself failed (the last run's local error:
 * the database or the engine; central's own errors are Home's), else 'Resting', with when it last trained and runs next.
 */
export function engineStatus({ summary, central = {}, work = null, now }) {
  if (work?.line) return { tone: work.critical ? 'critical' : 'working', title: 'Working', line: work.line };
  const poll = central.lastPoll;
  if (poll?.local && poll.error) return { tone: 'warn', title: 'Needs a look', line: `The last run failed: ${poll.error}` };
  const when = central.nextPoll == null ? '' : fmtIn(central.nextPoll - now);
  if (!summary.total) return { tone: 'idle', title: 'No models yet', line: ['The first poll builds them', when].filter(Boolean).join(' · ') };
  const trained = summary.trained == null ? '' : `Trained ${fmtAgo(now - summary.trained)}`;
  return { tone: 'idle', title: 'Resting', line: [trained, when && `next run ${when}`].filter(Boolean).join(' · ') };
}

const MARK_ORDER = { better: 0, tie: 1, worse: 2 };
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true });
/** By quality (the lowest ratio first; ties by name; not scored last), or by name. */
export function sortModels(list, by = 'quality') {
  if (by === 'name') return [...list].sort(byName);
  const rank = (m) => (m.quality.mark == null ? 3 : MARK_ORDER[m.quality.mark]);
  const ratio = (m) => m.quality.ratio ?? Infinity;
  return [...list].sort((a, b) => rank(a) - rank(b) || ratio(a) - ratio(b) || byName(a, b));
}

/** Where predictions go, by the words people see: the Satori Network (central), the Satori contract (Base), the Satori relays (Nostr). */
export const DESTS = ['network', 'contract', 'relays'];

/** The models whose predictions go to any of `to` (the filters that are on). */
export const filterModels = (list, to = DESTS) =>
  list.filter((m) => m.outputs.some((o) => o.destinations.some((d) => to.includes(d.to))));

/** A filter tapped: off if on, on if off, in DESTS' order; the last one on stays on, so the filters never empty the list. */
export function toggleDest(selected, to) {
  if (!DESTS.includes(to)) return selected;
  const on = selected.includes(to);
  if (on && selected.length === 1) return selected;
  return DESTS.filter((k) => (k === to ? !on : selected.includes(k)));
}

/** The chart's history: the points from HISTORY_HORIZONS horizons before the forecast was made on, at most HISTORY_POINTS. */
function recent(points, at, horizon) {
  const from = (at ?? points.at(-1)?.ts ?? 0) - HISTORY_HORIZONS * horizon;
  return points.filter((p) => p.ts >= from).slice(-HISTORY_POINTS).map(({ ts, value }) => ({ ts, value }));
}

/** An id as models() gives it, or a central stream's bare uuid or name. → [source, key] */
function parseId(id, streams) {
  const s = String(id ?? '');
  const m = /^(central|nostr|base):(.+)$/.exec(s);
  if (m) return [m[1], m[2]];
  const row = streams.find((r) => r.uuid === s || r.name === s);
  return ['central', row?.uuid ?? s];
}

/**
 * One model, recomputed on demand (the drill-in, `#models/<id>`): its stored spec and history, refit as the poll fit
 * it (explainModel; Nostr and Base: explainForecast at their step and horizon), so In (each input's influence on
 * each output, ranked) and the Model (its rows, backtest, fade) are the fit's; Out is what was sent. Base's history is
 * the chain's (baseHistory(streamId) → [{ts, value}]); when the chain does not answer, Out stands alone. null: no such
 * model. `ms`: how long it took; `readMs`: of which reading the history.
 */
export async function modelDetail({ db, id, streams = [], subscriptions = [], lastBatch = null, baseHistory = null,
  clock = () => performance.now() }) {
  const t0 = clock();
  let read = 0; // the history reads' share (DuckDB's worker, or the chain), apart from the engine's
  const timed = (fn) => async (...args) => {
    const t = clock();
    try { return await fn(...args); } finally { read += clock() - t; }
  };
  const reads = { histories: timed((u) => db.histories(u)), relayHistory: timed((u, windowS) => db.relayHistory(u, windowS)),
    // what this app forecast before, for How it did (a db without them: none)
    predictions: timed(async (u, n) => (db.predictions ? db.predictions(u, n) : [])),
    relayPredictions: timed(async (u, n) => (db.relayPredictions ? db.relayPredictions(u, n) : [])) };
  const [source, key] = parseId(id, streams);
  let d = null;
  if (source === 'central') d = await centralDetail(reads, key, streams);
  if (source === 'nostr') d = await nostrDetail(reads, key, subscriptions);
  if (source === 'base') d = await baseDetail(key, lastBatch, baseHistory && timed(baseHistory));
  const ms = (x) => Math.round(x * 10) / 10;
  return d && { ...d, ms: ms(clock() - t0), readMs: ms(read) };
}

/** Retrain is offered on Satori Network models only, with the history to split (docs/design/models.md#retrain). */
const NO_RETRAIN = { available: false, why: 'source', last: null };
const PAST_N = 1000; // the forecasts read for How it did, newest first (an hourly stream: about 6 weeks)

/** The detail's shape: the list's model, its Model facts, each output with its history; In from the fit when it has one. */
function detailOf(m, x, model, histories, retrain = NO_RETRAIN, outcomes = new Map()) {
  const fit = x && x.model === m.kind; // the same model now as made the forecast (else In and the rows are the list's)
  const names = new Map(m.inputs.map((i) => [i.stream, i.name]));
  const outputs = m.outputs.map((o) => ({
    ...o,
    influence: fit ? ranked(x.inputs.map((u, i) => ({ stream: u, name: names.get(u) ?? null, share: x.influence[i] }))) : o.influence,
    quality: fit ? qualityOf({ kind: m.kind, score: x.score, persist: x.persist }) : o.quality,
    history: recent(histories.get(o.stream) ?? [], o.forecast.at, o.forecast.horizon),
    outcomes: outcomes.get(o.stream) ?? null, // null: not read (Base's)
  }));
  const quality = qualityOfAll(outputs.map((o) => o.quality));
  return {
    id: m.id, source: m.source, name: m.name, kind: m.kind, quality, inputs: m.inputs,
    model: { kind: m.kind, rows: fit ? x.rows : null, tests: fit ? x.tests : null, coef: fit ? x.coef ?? null : null,
      trained: m.trained, quality, ...model },
    outputs, retrain,
  };
}

async function centralDetail(db, key, streams) {
  const m = centralModels(streams).find((x) => x.uuid === key);
  if (!m) return null;
  const row = streams.find((r) => r.uuid === key);
  const spec = parse(row.spec);
  const histories = await db.histories([key, ...(spec?.companions ?? [])]); // one read
  const x = explainModel({ target: key, spec, histories });
  const last = parse(row.retrain)?.result ?? null;
  const model = { step: STEP_S, horizon: CENTRAL_HORIZON, weight: row.weight ?? null, phi: row.phi ?? null,
    ...(spec ? { lambda1: spec.lambda1, lambda2: spec.lambda2, generation: row.generation, accepted: row.accepted } : {}), retrain: last };
  const ok = !!spec && canRetrain({ target: key, histories }).ok;
  const made = (await db.predictions(key, PAST_N)).map((p) => ({ at: p.made_at, value: p.t2 }));
  const outcomes = new Map([[key, outcomePairs(made, histories.get(key) ?? [], CENTRAL_HORIZON)]]);
  return detailOf(m, x, model, histories, { available: ok, why: ok ? null : 'history', last }, outcomes);
}

async function nostrDetail(db, key, subscriptions) {
  const s = subscriptions.find((x) => x.uuid === key);
  const [m] = s ? nostrModels([s]) : [];
  if (!m) return null;
  const cadence = cadenceOf(s);
  const points = await db.relayHistory(key, cadence * RELAY_WINDOW); // the engine's window, as the intake reads it
  const x = explainForecast(points, { step: cadence, horizon: cadence });
  const scored = nostrModels([{ ...s, prediction: { ...s.prediction, score: x?.score, persist: x?.persist } }])[0];
  const made = (await db.relayPredictions(key, PAST_N)).map((p) => ({ at: Number(p.made_at), value: Number(p.value) }));
  return detailOf(scored, x && { ...x, inputs: [key], influence: [1] }, { step: cadence, horizon: cadence, weight: x?.weight ?? null,
    phi: x?.phi ?? null }, new Map([[key, points]]), NO_RETRAIN, new Map([[key, outcomePairs(made, points, cadence)]]));
}

async function baseDetail(key, lastBatch, baseHistory) {
  const m = baseModels(lastBatch).find((x) => x.outputs[0].stream === key);
  if (!m) return null;
  const { step, horizon } = m.outputs[0].forecast;
  let points = [];
  try {
    points = baseHistory ? await baseHistory(Number(key)) : [];
  } catch (err) {
    console.warn('[satori] base history', err);
  }
  const x = points.length ? explainForecast(points, { step: step ?? horizon, horizon }) : null;
  return detailOf(m, x && { ...x, inputs: [key], influence: [1] }, { step, horizon, weight: x?.weight ?? null, phi: x?.phi ?? null },
    new Map([[key, points]]));
}
