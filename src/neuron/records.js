// The track record (docs/design/track-record.md): every prediction stream on the Satori Network watched on its own and
// scored against no change from what this neuron saw arrive. Watching only reads: nothing is published.
//
//   selectWatched(catalog, { me, cap, watched, gone, since }) → { list, lingering, found, left }   which `_pred` streams to watch
//   watchRows(list, now) → watch_streams rows: each prediction stream and each source once
//   followFilters([[author, stream]]) → the follow REQ's filters: one per author, its #d sorted
//   scoreRecord({ predictions, observations, n }) → a record: the verified-order rule, the last 28, the Models tab's mark
//   sortRecords(list) → best first
//   createWatch({ db, me, now, onChange }) → the watched set: load, apply(catalog, { gone }), drop(pairs), has, pairs,
//     count, intake, prune, list() (records()), one(pubkey, stream) (record(): with its pairs)
// Pure but createWatch. Scoring takes plain { value, ts, received_at } predictions, so a paid stream's revealed value,
// with its commitment's arrival, fits later (step 3).
import { PRED, relayUuid, numericValue } from '../nostr/satori.js';
import { EPOCH } from '../central/index.js';
import { qualityOf } from './quality.js';
import { DEFAULT_CADENCE_S, RELAY_WINDOW } from '../window.js';
import { AHEAD_S } from '../db/index.js';

export const WATCH_CAP = 200; // prediction streams watched at most: ours first, then the newest announced
export const WATCH_SCAN_S = 6 * 3600; // the catalog scanned again at most this often (the hourly pass)
export const WATCH_DROP_S = 7 * 86_400; // a stream no scan selected for this long goes, with its observations
export const RECORD_N = 28; // the record: the last 28 scored, as the Models tab's backtest has 28 origins
export const RECORD_READ = 60; // observations read per stream for a record: 28 outcomes with their baselines, and room
export const MIN_SCORED = 5; // fewer: "Not scored yet" (the Models tab's 5 origins)

const HEX64 = /^[0-9a-f]{64}$/;
const PREFIX = 'Predictions for ';
const OBSERVATION = 34601;
const tagOf = (e, name) => (Array.isArray(e?.tags) ? e.tags.find((t) => Array.isArray(t) && t[0] === name)?.[1] : undefined);
const cadenceOf = (x) => (Number.isFinite(x) && x > 0 ? x : null);
const pair = (pubkey, stream) => {
  const p = String(pubkey ?? '').trim().toLowerCase();
  return typeof stream === 'string' && stream && HEX64.test(p) ? { pubkey: p, stream } : null;
};

/**
 * A prediction stream's source, from its catalog entry: the `source_stream` and `source_pubkey` tags, as Lite writes
 * them (src/nostr/satori.js announceEvent), else its metadata's `source_stream_name` and `source_provider_pubkey`; the
 * pubkey 64 hex. → { pubkey, stream } | null
 */
export function sourceOf(entry) {
  const m = entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
  return pair(tagOf(entry?.event, 'source_pubkey'), tagOf(entry?.event, 'source_stream'))
    ?? pair(m.source_provider_pubkey, m.source_stream_name);
}

/** What the track record can watch, and so what this app buys (a delivery lands only in a watched stream): a `_pred` that names its source. */
export const watchable = (entry) => !!entry?.stream_name?.endsWith(PRED) && !!sourceOf(entry);

/**
 * Which prediction streams to watch, from the relays' verified catalog (catalog() of the signed 34600s: newest per
 * author and `d`, no tombstones; each with its `event`): every `_pred` that names its source, but those `gone` (keys
 * `pubkey:stream`: tombstoned on a relay, or our own we unsubscribed from). The cap holds for the whole watched set:
 * ours (`me`) first, then those already `watched` that are still announced, then the watched ones missing from this
 * catalog but seen since `since` (they keep their place: a relay down or an announcement lost for a while), then the
 * newcomers, most recently announced first; at most `cap` in all. Those in `keep` (`pubkey:stream`: the streams we buy,
 * docs/design/market.md) rank with ours. Cadence: the prediction stream's, else its source's,
 * else a day; a source not announced takes its prediction stream's. A source's name: its own announcement's, else its
 * stream id as it is, never the prediction stream's words (a predictor could name a stream it controls under another
 * key "BTC"); `announced`: whether the source has an announcement of its own in the catalog.
 * @param {object[]} entries catalog()
 * @param {{me?: string|null, cap?: number, watched?: {pubkey: string, stream: string, seen_at: number}[], gone?: Set<string>, since?: number, keep?: Set<string>}} [o]
 * @returns {{list: object[], lingering: {pubkey: string, stream: string}[], found: number, left: number}} list: from
 *   this catalog; lingering: watched ones kept though missing from it; found: every prediction stream that names a source
 *   (not gone); left: found and not watched (past the cap)
 */
export function selectWatched(entries, { me = null, cap = WATCH_CAP, watched = [], gone = new Set(), since = -Infinity, keep = new Set() } = {}) {
  const key = (pubkey, stream) => `${pubkey}:${stream}`;
  const announced = new Map(entries.map((s) => [key(s.pubkey, s.stream_name), s]));
  const was = new Set(watched.map((w) => key(w.pubkey, w.stream)));
  const found = [];
  for (const s of entries) {
    if (!watchable(s) || gone.has(key(s.pubkey, s.stream_name))) continue;
    const src = sourceOf(s);
    const own = announced.get(key(src.pubkey, src.stream));
    const cadence = cadenceOf(s.cadence_seconds) ?? cadenceOf(own?.cadence_seconds) ?? DEFAULT_CADENCE_S;
    found.push({
      pubkey: s.pubkey, stream: s.stream_name, name: s.name || `${PREFIX}${src.stream}`, cadence_seconds: cadence,
      announced_at: s.created_at, mine: s.pubkey === me,
      source: { ...src, name: own?.name || src.stream, announced: !!own, cadence_seconds: cadenceOf(own?.cadence_seconds) ?? cadence },
    });
  }
  const tier = (x) => (x.mine || keep.has(key(x.pubkey, x.stream)) ? 0 : was.has(key(x.pubkey, x.stream)) ? 1 : 2);
  const byKey = (a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0);
  found.sort((a, b) => tier(a) - tier(b) || (b.announced_at - a.announced_at) || byKey(a, b));
  const here = new Set(found.map((x) => key(x.pubkey, x.stream)));
  const firm = found.filter((x) => tier(x) < 2).slice(0, cap);
  const lingering = watched.filter((w) => !here.has(key(w.pubkey, w.stream)) && !gone.has(key(w.pubkey, w.stream)) && w.seen_at >= since)
    .sort((a, b) => (b.seen_at - a.seen_at) || byKey(a, b)).slice(0, cap - firm.length).map(({ pubkey, stream }) => ({ pubkey, stream }));
  const fresh = found.filter((x) => tier(x) === 2).slice(0, Math.max(0, cap - firm.length - lingering.length));
  return { list: [...firm, ...fresh], lingering, found: found.length, left: found.length - firm.length - fresh.length };
}

/**
 * watch_streams rows for a selection, seen `now`: each prediction stream, then each source not already one (a pred wins);
 * a source's meta: { announced }.
 */
export function watchRows(list, now) {
  const rows = new Map();
  for (const p of list) {
    const uuid = relayUuid(p.pubkey, p.stream);
    rows.set(uuid, { uuid, pubkey: p.pubkey, stream_name: p.stream, kind: 'pred', source_uuid: relayUuid(p.source.pubkey, p.source.stream),
      name: p.name, cadence_seconds: p.cadence_seconds, meta: JSON.stringify({ announced_at: p.announced_at }), seen_at: now });
  }
  for (const { source: s } of list) {
    const uuid = relayUuid(s.pubkey, s.stream);
    if (!rows.has(uuid)) {
      rows.set(uuid, { uuid, pubkey: s.pubkey, stream_name: s.stream, kind: 'source', source_uuid: null, name: s.name,
        cadence_seconds: s.cadence_seconds, meta: JSON.stringify({ announced: !!s.announced }), seen_at: now });
    }
  }
  return [...rows.values()];
}

/** The follow REQ's filters for [author, stream] pairs (the subscriptions' and the watched streams'): one per author, sorted, its #d each once, sorted. */
export function followFilters(pairs) {
  const by = new Map();
  for (const [author, stream] of pairs) (by.get(author) ?? by.set(author, new Set()).get(author)).add(stream);
  return [...by.keys()].sort().map((p) => ({ kinds: [OBSERVATION], authors: [p], '#d': [...by.get(p)].sort() }));
}

const byTime = (a, b) => a.ts - b.ts || a.seq - b.seq;
const sign = (x) => Math.sign(x);
/** The median, its two middles halved before adding: two errors near the largest double never sum to Infinity. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : s[m - 1] / 2 + s[m] / 2;
}

/**
 * Whether prediction p counts against baseline b and outcome o (the source's next observation after b), by when each
 * arrived here (received_at, this clock): p before the outcome's time AND before the outcome arrived here (one clock:
 * a source stamping ahead of ours credits no copy); and with a lead: within the first half of the interval after its
 * baseline arrived here, r_p − r_b ≤ (o.ts − b.ts) / 2 (a nowcast made just before the outcome, from the source's own
 * upstream, is not a forecast). Every time a number.
 */
function qualifies(p, b, o) {
  const [rp, rb, ro] = [p.received_at, b.received_at, o.received_at];
  return [rp, rb, ro].every(Number.isFinite) && rp < o.ts && rp < ro && rp - rb <= (o.ts - b.ts) / 2;
}

/**
 * A prediction stream's record, by the verified-order rule (docs/design/track-record.md#scoring-the-verified-order-rule).
 * A prediction p ({ value, ts, received_at }) is scored against the first source observation o with o.ts > p.ts, which
 * must be the source's next one after p's baseline b (the latest with ts ≤ p.ts: seq + 1, nothing missed between),
 * and only if it qualifies by when each arrived here (qualifies(): before the outcome's time and its arrival, within
 * the first half of the interval after the baseline arrived); v, b and o numbers, |v − o| and |b − o| finite. One
 * prediction per outcome: the earliest received that qualifies. Over the last `n` outcomes scored: error = median
 * |v − o|, noChange = median |b − o|, the Models tab's mark (qualityOf); direction over the same; since: the first
 * scored outcome's time. Fewer than MIN_SCORED scored: no mark and no numbers.
 * @param {{predictions: {seq?: number, ts: number|null, value: number|null, received_at: number}[], observations: {seq: number, ts: number|null, value: number|null, received_at: number}[], n?: number}} o
 */
export function scoreRecord({ predictions, observations, n = RECORD_N }) {
  const obs = observations.filter((o) => Number.isFinite(o.ts)).sort(byTime);
  const preds = predictions.filter((p) => Number.isFinite(p.ts)).sort((a, b) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0));
  const first = new Map(); // the outcome's seq → { at, seq, pair }: the earliest received prediction that qualifies
  let j = 0; // obs[j]: the first observation after the prediction's time
  for (const p of preds) {
    while (j < obs.length && obs[j].ts <= p.ts) j++;
    const b = obs[j - 1];
    const o = obs[j];
    if (!b || !o || o.seq !== b.seq + 1 || !qualifies(p, b, o)) continue;
    if (![p.value, b.value, o.value, Math.abs(p.value - o.value), Math.abs(b.value - o.value)].every(Number.isFinite)) continue;
    const was = first.get(o.seq);
    const seq = p.seq ?? 0;
    if (was && (was.at < p.received_at || (was.at === p.received_at && was.seq <= seq))) continue;
    first.set(o.seq, { at: p.received_at, seq, pair: { ts: o.ts, predicted: p.value, actual: o.value, baseline: b.value } });
  }
  const all = [...first.values()].map((x) => x.pair).sort((a, b) => a.ts - b.ts);
  const pairs = all.slice(-n);
  const scored = pairs.length;
  const enough = scored >= MIN_SCORED;
  const error = enough ? median(pairs.map((x) => Math.abs(x.predicted - x.actual))) : null;
  const noChange = enough ? median(pairs.map((x) => Math.abs(x.baseline - x.actual))) : null;
  let q = qualityOf({ kind: 'record', score: error, persist: noChange });
  if (q.ratio != null && !Number.isFinite(q.ratio)) q = { ...qualityOf({ kind: 'record', score: error, persist: 0 }), noChange }; // no change all but exact
  const direction = { right: 0, total: 0 };
  for (const x of pairs) {
    const want = sign(x.actual - x.baseline);
    const said = sign(x.predicted - x.baseline);
    if (!want || !said) continue;
    direction.total++;
    if (want === said) direction.right++;
  }
  return { scored, error: enough ? q.error : null, noChange: enough ? q.noChange : null, ratio: enough ? q.ratio : null,
    mark: q.mark, markText: q.text, direction, since: all[0]?.ts ?? null, pairs };
}

const metaOf = (r) => {
  try { return JSON.parse(r?.meta ?? 'null') ?? {}; } catch { return {}; }
};
/** Whether a watched source (a watch_streams row) has its own announcement: a prediction stream does; a source says in its meta. */
const announcedOf = (src) => !!src && (src.kind === 'pred' || metaOf(src).announced === true);

const rankOf = (r) => (r.mark == null ? 1 : 0);
const ratioOf = (r) => r.ratio ?? (r.mark === 'tie' ? 1 : Infinity); // no change perfect and some error: worst of the marked
/** Best first: a record before "not scored yet", by ratio; then by how many are scored, how many received, the name. */
export const compareRecords = (a, b) => rankOf(a) - rankOf(b) || ratioOf(a) - ratioOf(b)
  || b.scored - a.scored || b.received - a.received || String(a.name).localeCompare(String(b.name)) || String(a.stream).localeCompare(String(b.stream))
  || String(a.pubkey).localeCompare(String(b.pubkey));
export const sortRecords = (list) => [...list].sort(compareRecords);

/**
 * The watched set, kept in the db (watch_streams, watch_observations: migration 14) and in memory for the intake's
 * routing. Records are computed when asked, from each stream's last RECORD_READ observations, and kept until their
 * stream or its source gets something new (a scan that finds the same streams reads nothing again).
 * @param {{db: object, me: string, now?: () => number, onChange?: () => void}} o me: our Nostr pubkey (`mine`); onChange: an observation kept
 */
export function createWatch({ db, me, now = () => Date.now() / 1000, onChange = () => {} }) {
  let rows = new Map(); // uuid → watch_streams row
  let predsOf = new Map(); // source uuid → the prediction streams naming it
  const cache = new Map(); // pred uuid → { rec (scoreRecord's), received, last }
  const dirty = new Set();
  const preds = () => [...rows.values()].filter((r) => r.kind === 'pred');
  const pairsKey = () => [...rows.values()].map((r) => `${r.pubkey}:${r.stream_name}`).sort().join('|');

  /** The watched set read back: a record kept while its stream is still a prediction stream with the same source; the others computed when asked. */
  function index(list) {
    const was = rows;
    rows = new Map(list.map((r) => [r.uuid, r]));
    predsOf = new Map();
    for (const r of preds()) if (r.source_uuid) (predsOf.get(r.source_uuid) ?? predsOf.set(r.source_uuid, new Set()).get(r.source_uuid)).add(r.uuid);
    for (const u of [...cache.keys()]) if (rows.get(u)?.kind !== 'pred' || rows.get(u).source_uuid !== was.get(u)?.source_uuid) cache.delete(u);
    for (const u of [...dirty]) if (rows.get(u)?.kind !== 'pred') dirty.delete(u);
    for (const r of preds()) if (!cache.has(r.uuid)) dirty.add(r.uuid);
  }
  const reindex = async () => {
    await db.checkpoint(); // as the other writers do (every commit is checkpointed already: storage.md)
    index(await db.watchStreams());
  };

  async function compute() {
    if (!dirty.size) return;
    const asked = [...dirty].filter((u) => rows.has(u));
    dirty.clear();
    const want = new Set(asked);
    for (const u of asked) if (rows.get(u).source_uuid) want.add(rows.get(u).source_uuid);
    const [observed, held] = await Promise.all([db.watchObservations([...want], { last: RECORD_READ }), db.watchCounts(asked)]);
    for (const u of asked) {
      const r = rows.get(u);
      const mine = observed.get(u) ?? [];
      const latest = mine.reduce((a, x) => (!a || x.seq > a.seq ? x : a), null);
      cache.set(u, { rec: scoreRecord({ predictions: mine, observations: observed.get(r.source_uuid) ?? [] }), received: held.get(u) ?? mine.length,
        last: latest ? { value: latest.value, received_at: latest.received_at } : null });
    }
  }
  /** A prediction stream's record (record()'s: with its pairs), from its row, its source's and its cached score. */
  function viewOf(r) {
    const c = cache.get(r.uuid);
    if (!c) return null;
    const src = rows.get(r.source_uuid);
    const { rec } = c;
    return {
      pubkey: r.pubkey, stream: r.stream_name, name: r.name, mine: r.pubkey === me, sameAuthor: !!src && src.pubkey === r.pubkey,
      source: { pubkey: src?.pubkey ?? null, stream: src?.stream_name ?? null, name: src?.name || src?.stream_name || null, announced: announcedOf(src) },
      cadence_seconds: r.cadence_seconds, received: c.received, scored: rec.scored, error: rec.error, noChange: rec.noChange,
      ratio: rec.ratio, mark: rec.mark, markText: rec.markText, direction: rec.direction, since: rec.since, last: c.last, pairs: rec.pairs,
    };
  }
  const withoutPairs = ({ pairs, ...r }) => r;

  return {
    /** The watched set from the db (at start). */
    async load() { index(await db.watchStreams()); },
    /** A watched stream (a prediction stream or a source), by its uuid (relayUuid). */
    has: (uuid) => rows.has(uuid),
    /** [author, stream] of every watched stream: the follow REQ's (followFilters). */
    pairs: () => [...rows.values()].map((r) => [r.pubkey, r.stream_name]),
    /** How many prediction streams and sources are watched. */
    count: () => ({ streams: preds().length, sources: rows.size - preds().length }),
    /**
     * A scan's catalog (catalog() entries, with their events), what it saw `gone` (keys `pubkey:stream`: tombstoned,
     * or our own we unsubscribed from) and what we buy (`bought`, the same keys: ranked with ours): the selection (selectWatched: at most WATCH_CAP in all, the watched ones first)
     * kept, seen now; a watched one missing from the catalog kept until no scan has seen it for 7 days; everything else
     * (gone, past the cap, a source nothing names) dropped now with its observations.
     * → { found, left, changed: whether the followed set changed }
     */
    async apply(entries, { gone = new Set(), bought = new Set() } = {}) {
      const at = Math.floor(now());
      const was = pairsKey();
      const { list, lingering, found, left } = selectWatched(entries, { me, gone, keep: bought, since: at - WATCH_DROP_S,
        watched: preds().map((r) => ({ pubkey: r.pubkey, stream: r.stream_name, seen_at: r.seen_at })) });
      const stay = new Set(lingering.map((x) => relayUuid(x.pubkey, x.stream)));
      const saved = watchRows(list, at).filter((r) => !(r.kind === 'source' && stay.has(r.uuid))); // a lingering pred stays a pred
      const keep = new Set([...saved.map((r) => r.uuid), ...stay, ...[...stay].map((u) => rows.get(u)?.source_uuid).filter(Boolean)]);
      await db.saveWatch(saved);
      await db.retainWatch([...keep]);
      await reindex();
      return { found, left, changed: pairsKey() !== was };
    },
    /**
     * Prediction streams ([author, stream]) that leave now, with their observations (our own, unsubscribed: its
     * tombstone may take a while to reach the relays); a source goes with them when nothing else names it.
     * → whether any was watched
     */
    async drop(list) {
      const out = new Set(list.map(([p, st]) => relayUuid(String(p ?? '').trim().toLowerCase(), String(st ?? ''))));
      const kept = preds().filter((r) => !out.has(r.uuid));
      if (kept.length === preds().length) return false;
      const keep = new Set([...kept.map((r) => r.uuid), ...kept.map((r) => r.source_uuid).filter(Boolean)]);
      // one that a kept prediction stream predicts stays, as its source
      const demoted = [...out].filter((u) => keep.has(u) && rows.get(u)?.kind === 'pred').map((u) => ({ ...rows.get(u), kind: 'source', source_uuid: null,
        meta: JSON.stringify({ announced: false }) }));
      if (demoted.length) await db.saveWatch(demoted);
      await db.retainWatch([...keep]);
      await reindex();
      return true;
    },
    /**
     * A verified 34601 of a watched stream (o: parseObservation's) that arrived `at` (this clock, s: when the relay
     * delivered it, before the intake's queue): kept once, `at` in whole seconds rounded up (never earlier than it
     * arrived), and only with a timestamp (2000–2100) no more than max(its cadence, AHEAD_S) ahead of its arrival (a row
     * without one could never be pruned; one far ahead would move the prune's window past the whole history); never
     * forecast, never published. → whether it was new
     */
    async intake(uuid, o, e, at = now()) {
      const row = rows.get(uuid);
      if (!row) return false;
      const ts = Number.isFinite(o.timestamp) && o.timestamp > EPOCH[0] && o.timestamp < EPOCH[1] ? Math.floor(o.timestamp) : null; // as the relay intake's
      if (ts === null || ts > at + Math.max(cadenceOf(row.cadence_seconds) ?? DEFAULT_CADENCE_S, AHEAD_S)) return false;
      const n = numericValue(o.value);
      const fresh = await db.addWatchObservation({ stream_uuid: uuid, seq: o.seq, ts, value: Number.isFinite(n) ? n : null,
        received_at: Math.ceil(at), event_id: e.id }); // only while its stream is still watched (a scan may drop it meanwhile)
      if (!fresh) return false;
      if (rows.get(uuid)?.kind === 'pred') dirty.add(uuid);
      for (const p of predsOf.get(uuid) ?? []) dirty.add(p);
      onChange();
      return true;
    },
    /** Each watched stream's observations older than its window (RELAY_WINDOW of its cadences, back from its newest time not in the future) go, and any far ahead. → how many */
    async prune() {
      const n = await db.pruneWatch({ buckets: RELAY_WINDOW, now: now() });
      if (n) await db.checkpoint();
      return n;
    },
    /** records(): every watched prediction stream's record, best first. */
    async list() {
      await compute();
      return sortRecords(preds().map(viewOf).filter(Boolean).map(withoutPairs));
    },
    /** record(pubkey, stream): one, with its last 28 scored pairs; null when it is not watched. */
    async one(pubkey, stream) {
      const uuid = relayUuid(String(pubkey ?? '').trim().toLowerCase(), String(stream ?? ''));
      if (rows.get(uuid)?.kind !== 'pred') return null;
      await compute();
      return rows.get(uuid) ? viewOf(rows.get(uuid)) : null;
    },
  };
}
