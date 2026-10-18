// The Models tab (docs/design/models.md): every model the neuron runs, named for the stream it predicts, with its
// quality against no change (the engine's own rolling backtest), its inputs ranked by how much each moves the
// forecast, and its outputs, each with where it went. A model's outputs are a list: today each predicts one stream;
// a model of several (one VAR or a network for all) fills `name` with something like "bvar · 3 streams".
//
//   modelsOf({ streams, subscriptions, lastBatch, scores }) → [model]       pure: from what the app already holds
//   summaryOf(models), engineStatus({ summary, central, work, now })      the tab's top
//   sortModels(list, 'quality' | 'name'), filterModels(list, 'all' | 'central' | 'base' | 'network')
//   await modelDetail({ db, id, streams, subscriptions, lastBatch, baseHistory })   one model, recomputed on demand
//   await nostrScores({ db, subscriptions, cache })                                  the Nostr models' backtests
import { MARGIN, explainModel } from '../engine/evolve.js';
import { explainForecast, STEP_S, HORIZON_STEPS, median } from '../engine/index.js';
import { UP } from '../chain/index.js';
import { DEFAULT_CADENCE_S } from './nostr.js';
import { fmtAgo, fmtIn } from './health.js';

/** Within ±5 % of no change's error is a tie: the margin evolution keeps a challenger by (src/engine/evolve.js). */
export const TIE = MARGIN;
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
const classify = (ratio) => (ratio < 1 - TIE ? 'better' : ratio > 1 + TIE ? 'worse' : 'tie');

/**
 * A model against no change, from its backtest: score (its median error) and persist (no change's, on the same
 * origins). ratio = score / persist; better below 0.95, worse above 1.05, else a tie. naive is no change itself: a
 * tie. No backtest yet (fewer than 5 origins), or no model (an echoed value): mark null.
 * @returns {{mark: 'better'|'tie'|'worse'|null, ratio: number|null, error: number|null, noChange: number|null}}
 */
export function qualityOf({ kind, score = null, persist = null }) {
  if (kind === 'naive') return { mark: 'tie', ratio: 1, error: null, noChange: null };
  if (score == null || persist == null || kind === 'echo') return { mark: null, ratio: null, error: score ?? null, noChange: persist ?? null };
  if (!(persist > 0)) return score > 0 ? { mark: 'worse', ratio: null, error: score, noChange: persist } : { mark: 'tie', ratio: 1, error: score, noChange: persist };
  const ratio = score / persist;
  return { mark: classify(ratio), ratio, error: score, noChange: persist };
}

/** A model with several outputs: the median of their ratios (one output: its own). */
export function qualityOfAll(list) {
  if (list.length === 1) return list[0];
  const ratios = list.map((q) => q.ratio).filter(Number.isFinite);
  if (!ratios.length) return { mark: null, ratio: null, error: null, noChange: null };
  const ratio = median(ratios);
  return { mark: classify(ratio), ratio, error: null, noChange: null };
}

/** Influence, largest first (inputs whose share is unknown keep their order, after the known). */
const ranked = (list) => [...list].sort((a, b) => (b.share ?? -1) - (a.share ?? -1));

/** A model from its outputs: named for its one output, or "<kind> · n streams". */
function modelOf({ id, source, kind, inputs, outputs, trained, ...rest }) {
  const name = outputs.length === 1 ? outputs[0].name : `${kind} · ${outputs.length} streams`;
  return { id, source, name, kind, quality: qualityOfAll(outputs.map((o) => o.quality)), inputs, outputs, trained, ...rest };
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
    return modelOf({
      id: `central:${r.uuid}`, source: 'central', kind: r.model, inputs: inputs.map(named), trained: r.made_at ?? null,
      outputs: [{
        stream: r.uuid, name: r.name, latest: { value: r.obs_value ?? null, ts: r.obs_ts ?? null },
        forecast: { t1: r.t1, t2: r.t2, value: r.t2, step: STEP_S, horizon: CENTRAL_HORIZON, at: r.made_at },
        direction: direction(r.t2, r.obs_value),
        influence: ranked(inputs.map((u, i) => ({ ...named(u), share: shares?.[i] ?? null }))),
        quality,
        destinations: [{ to: 'central', status: sent ? 'accepted' : 'pending', when: sent ? r.sent_at : r.made_at, ref: null }],
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
 * first observation). scores: uuid → { score, persist } (nostrScores()).
 */
export function nostrModels(subscriptions, scores = new Map()) {
  return subscriptions.filter((s) => s.prediction).map((s) => {
    const p = s.prediction;
    const name = s.name || s.stream;
    const cadence = cadenceOf(s);
    const value = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(p.value ?? '') ? Number(p.value) : null;
    const latest = s.observation?.value ?? null;
    const quality = qualityOf({ kind: p.model, ...scores.get(s.uuid) });
    return modelOf({
      id: `nostr:${s.uuid}`, source: 'nostr', kind: p.model, inputs: [{ stream: s.uuid, name }], trained: p.made_at,
      outputs: [{
        stream: s.uuid, name, as: p.stream, latest: { value: latest, ts: s.observation?.ts ?? null },
        forecast: { value, step: cadence, horizon: cadence, at: p.made_at }, direction: direction(value, latest),
        influence: [{ stream: s.uuid, name, share: 1 }], quality,
        destinations: [{ to: 'network', status: p.relays > 0 ? 'published' : 'waiting', when: p.made_at,
          ref: { stream: p.stream, seq: p.seq, relays: p.relays } }],
      }],
    });
  });
}

/** The Base models: the last batch's games, and those left out after a forecast (by their simulate). */
export function baseModels(batch) {
  if (!batch) return [];
  const all = [...batch.games.map((g) => [g, true]), ...(batch.dropped ?? []).filter((g) => g.model).map((g) => [g, false])];
  return all.map(([g, sent]) => {
    const name = `${g.named ? 'Named stream' : 'Stream'} ${g.streamId}`;
    const stream = String(g.streamId);
    const dir = g.direction === UP ? 'up' : 'down'; // as sent: a tie is DOWN
    const quality = qualityOf({ kind: g.model, score: g.score, persist: g.persist });
    return modelOf({
      id: `base:${stream}`, source: 'base', kind: g.model, inputs: [{ stream, name }], trained: batch.at,
      outputs: [{
        stream, name, latest: { value: num(g.latest), ts: null },
        forecast: { value: num(g.forecast), step: g.step ?? null, horizon: g.horizon, at: batch.at }, direction: dir,
        influence: [{ stream, name, share: 1 }], quality,
        destinations: [{ to: 'base', status: sent ? 'sent' : 'left out', when: batch.at,
          ref: { round: batch.round, game: g.gameId, direction: dir, tx: sent ? batch.hash : null, ...(sent ? {} : { error: g.error }) } }],
      }],
    });
  });
}

/** Every model the neuron runs: central's, then Base's, then Nostr's. */
export const modelsOf = ({ streams = [], subscriptions = [], lastBatch = null, scores } = {}) =>
  [...centralModels(streams), ...baseModels(lastBatch), ...nostrModels(subscriptions, scores)];

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

/** The models whose predictions go to `to` ('central', 'base', 'network'); 'all': the list itself. */
export const filterModels = (list, to = 'all') => (to === 'all' ? list
  : list.filter((m) => m.outputs.some((o) => o.destinations.some((d) => d.to === to))));

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
  const reads = { histories: timed((u) => db.histories(u)), relayHistory: timed((u) => db.relayHistory(u)) };
  const [source, key] = parseId(id, streams);
  let d = null;
  if (source === 'central') d = await centralDetail(reads, key, streams);
  if (source === 'nostr') d = await nostrDetail(reads, key, subscriptions);
  if (source === 'base') d = await baseDetail(key, lastBatch, baseHistory && timed(baseHistory));
  const ms = (x) => Math.round(x * 10) / 10;
  return d && { ...d, ms: ms(clock() - t0), readMs: ms(read) };
}

/** The detail's shape: the list's model, its Model facts, each output with its history; In from the fit when it has one. */
function detailOf(m, x, model, histories) {
  const fit = x && x.model === m.kind; // the same model now as made the forecast (else In and the rows are the list's)
  const names = new Map(m.inputs.map((i) => [i.stream, i.name]));
  const outputs = m.outputs.map((o) => ({
    ...o,
    influence: fit ? ranked(x.inputs.map((u, i) => ({ stream: u, name: names.get(u) ?? null, share: x.influence[i] }))) : o.influence,
    quality: fit ? qualityOf({ kind: m.kind, score: x.score, persist: x.persist }) : o.quality,
    history: recent(histories.get(o.stream) ?? [], o.forecast.at, o.forecast.horizon),
  }));
  const quality = qualityOfAll(outputs.map((o) => o.quality));
  return {
    id: m.id, source: m.source, name: m.name, kind: m.kind, quality, inputs: m.inputs,
    model: { kind: m.kind, rows: fit ? x.rows : null, tests: fit ? x.tests : null, coef: fit ? x.coef ?? null : null,
      trained: m.trained, quality, ...model },
    outputs,
  };
}

async function centralDetail(db, key, streams) {
  const m = centralModels(streams).find((x) => x.uuid === key);
  if (!m) return null;
  const row = streams.find((r) => r.uuid === key);
  const spec = parse(row.spec);
  const histories = await db.histories([key, ...(spec?.companions ?? [])]); // one read
  const x = explainModel({ target: key, spec, histories });
  const model = { step: STEP_S, horizon: CENTRAL_HORIZON, weight: row.weight ?? null, phi: row.phi ?? null,
    ...(spec ? { lambda1: spec.lambda1, lambda2: spec.lambda2, generation: row.generation, accepted: row.accepted } : {}) };
  return detailOf(m, x, model, histories);
}

async function nostrDetail(db, key, subscriptions) {
  const s = subscriptions.find((x) => x.uuid === key);
  const [m] = s ? nostrModels([s]) : [];
  if (!m) return null;
  const cadence = cadenceOf(s);
  const points = await db.relayHistory(key);
  const x = explainForecast(points, { step: cadence, horizon: cadence });
  const scored = nostrModels([s], new Map([[key, { score: x?.score, persist: x?.persist }]]))[0];
  return detailOf(scored, x && { ...x, inputs: [key], influence: [1] }, { step: cadence, horizon: cadence, weight: x?.weight ?? null,
    phi: x?.phi ?? null }, new Map([[key, points]]));
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

/**
 * Each Nostr model's backtest (score, persist), recomputed from its stored history once per published seq (cache:
 * `uuid:seq` → result). → Map(uuid → { score, persist })
 */
export async function nostrScores({ db, subscriptions, cache = new Map() }) {
  const out = new Map();
  for (const s of subscriptions) {
    if (!s.prediction) continue;
    const key = `${s.uuid}:${s.prediction.seq}`;
    if (!cache.has(key)) {
      const x = explainForecast(await db.relayHistory(s.uuid), { step: cadenceOf(s), horizon: cadenceOf(s) });
      cache.set(key, { score: x?.score ?? null, persist: x?.persist ?? null });
    }
    out.set(s.uuid, cache.get(key));
  }
  return out;
}
