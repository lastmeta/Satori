// The database: DuckDB-WASM, one connection, calls run one at a time in order.
// Times are unix seconds (docs/design/central.md).
//
//   const db = await openDb(conn, close?)    // runs migrations
//   await db.get(key) / db.set(key, value)   // meta, JSON values
//   await db.addObservations(rows) → uuids with a new row / db.history(uuid) → [{ts, value}]
//   await db.centralHistories() → Map(uuid → [{ts, value}]) / db.histories(uuids) / db.specs() / db.saveSpecs(map, at)
//   await db.saveFits(list, at) → how many: the training pass's scores (src/neuron/train.js)
//   await db.setRetrain(uuid, value) / db.saveRetrained(row, at) → how many: Retrain's request and result (src/neuron/retrain.js)
//   await db.needHistory() → uuids / db.addHistories([{uuid, rows}], at) → rows added (older than the newest polled only)
//   await db.unpredicted() → uuids whose latest observation has no prediction made from it
//   await db.addPredictions(list) → ids / db.pending() / db.pendingCount() / db.markSent(ids, at) / db.dropPending(before)
//   await db.resetCentral()                  // the central URL changed
//   await db.streams() / db.predictions(uuidOrName, limit) / db.sparks(n)   // for the UI and agents
//   relay (Nostr) streams, apart from central's (docs/design/nostr.md):
//   db.subscribeRelay(s) / unsubscribeRelay(uuid) / relayStream(uuid) / relayStreams({active}) / countActiveRelay()
//   db.addRelayObservation(o) → new? / relayHistory(uuid) / nextPredSeq(uuid) / addRelayPrediction(p) / relayPredictions(uuid, limit)
//   db.setRelayFit(uuid, seq, { score, persist, tests }): a `_pred`'s backtest, kept later (the training pass)
//   the activity log (docs/design/health.md): db.addActivity(row) → id / updateActivity(id, fields) / activity(since) / firstSession() / pruneActivity(before)
//   await db.checkpoint() / db.close()
// `conn` is an AsyncDuckDBConnection (browser) or a blocking one (node tests).
import { MIGRATIONS } from './schema.js';
import { serial } from '../util.js';

const plain = (v) => (typeof v === 'bigint' ? Number(v) : v);
/**
 * A DOUBLE parameter, sent as text for `CAST(? AS DOUBLE)`: DuckDB-WASM sends
 * parameters as JSON, and its parser reads about 1 number in 12 one ulp off;
 * a JS number's shortest text parses back exactly.
 */
const dbl = (x) => (x == null ? null : String(x));
const D = 'CAST(? AS DOUBLE)';
/**
 * A column of many rows as one parameter (one statement, not one per row: each statement is a round trip to
 * DuckDB's worker): `col(xs)` joins the values with commas, numbers as their text (dbl), null as ''; text is
 * base64 (UTF-8, so a comma or anything else survives), null as '-'. `rowsOf(n)` splits n of them back into
 * rows c0, c1, …; `NUM('c0', 'DOUBLE')` and `TXT('c1')` read a column.
 */
const b64 = (s) => {
  let bin = '';
  for (const b of new TextEncoder().encode(String(s))) bin += String.fromCharCode(b);
  return btoa(bin);
};
const nums = (xs) => xs.map((x) => (x == null ? '' : dbl(x))).join(',');
const texts = (xs) => xs.map((x) => (x == null ? '-' : b64(x))).join(',');
const rowsOf = (n) => `(SELECT ${Array.from({ length: n }, (_, i) => `unnest(string_split(?, ',')) AS c${i}`).join(', ')})`;
const NUM = (c, type) => `CAST(NULLIF(${c}, '') AS ${type})`;
const TXT = (c) => `CASE WHEN ${c} = '-' THEN NULL ELSE decode(from_base64(${c})) END`;
const HISTORY_ROWS = 10_000; // rows per statement at most (one of 10,000: 80–160 ms; storage.md)
/** Whole streams ([{ rows }]) in groups of about `max` rows (a stream alone may have more). */
function byRows(list, max) {
  const out = [];
  let n = Infinity;
  for (const x of list) {
    if (n + x.rows.length > max) out.push([]), (n = 0);
    out.at(-1).push(x);
    n += x.rows.length;
  }
  return out;
}
const toRows = (table) => table.toArray().map((r) => {
  const o = r.toJSON();
  for (const k in o) o[k] = plain(o[k]);
  return o;
});

async function query(conn, sql, params = []) {
  if (!params.length) return conn.query(sql);
  const stmt = await conn.prepare(sql);
  try {
    return await stmt.query(...params);
  } finally {
    await stmt.close();
  }
}

async function migrate(conn) {
  await conn.query('CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
  const [row] = toRows(await conn.query("SELECT value FROM meta WHERE key = 'schema_version'"));
  let version = row ? JSON.parse(row.value) : 0;
  if (version > MIGRATIONS.length) {
    throw new Error(`This database is from a newer version of the app (schema ${version}, this app knows ${MIGRATIONS.length}).`);
  }
  const meta = {
    get: async (key) => {
      const [r] = toRows(await query(conn, 'SELECT value FROM meta WHERE key = ?', [key]));
      return r ? JSON.parse(r.value) : undefined;
    },
    set: (key, value) => query(conn, 'INSERT OR REPLACE INTO meta VALUES (?, ?)', [key, JSON.stringify(value)]),
    remove: (...keys) => query(conn, `DELETE FROM meta WHERE key IN (${keys.map(() => '?').join(', ')})`, keys),
  };
  for (; version < MIGRATIONS.length; version++) {
    const step = MIGRATIONS[version];
    await conn.query('BEGIN TRANSACTION');
    try {
      await (typeof step === 'function' ? step(meta) : conn.query(step));
      await conn.query(`INSERT OR REPLACE INTO meta VALUES ('schema_version', '${version + 1}')`);
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    }
  }
  return version;
}

export async function openDb(conn, closeDb = async () => conn.close()) {
  await conn.query('SET autoload_known_extensions = false');
  // DuckDB checkpoints every commit itself, so nothing is left in the WAL: on OPFS,
  // DuckDB-WASM 1.32.0 keeps only what is checkpointed, and cannot replay a WAL
  // that holds migration 3 (docs/design/storage.md#the-checkpoint-rule).
  await conn.query("SET checkpoint_threshold = '0b'");
  const version = await migrate(conn);
  await conn.query('CHECKPOINT'); // whatever the migrations left, before anything else runs

  const line = serial();
  const inOrder = (fn) => (...args) => line(() => fn(...args));
  const rows = async (sql, ...params) => toRows(await query(conn, sql, params));
  const run = async (sql, ...params) => void (await query(conn, sql, params));

  return {
    version,
    get: inOrder(async (key) => {
      const [row] = await rows('SELECT value FROM meta WHERE key = ?', key);
      return row ? JSON.parse(row.value) : undefined;
    }),
    set: inOrder((key, value) => run('INSERT OR REPLACE INTO meta VALUES (?, ?)', key, JSON.stringify(value))),

    /** One row per stream: its latest observation and our latest prediction. */
    streams: inOrder(() => rows(`
      SELECT s.uuid, s.name, s.meta,
        (SELECT count(*) FROM observations x WHERE x.stream_uuid = s.uuid) AS observations,
        o.ts AS obs_ts, o.value AS obs_value,
        p.model, p.t1, p.t2, p.phi, p.weight, p.made_at, p.status, p.sent_at,
        m.spec, m.score, m.persist, m.influence, m.generation, m.accepted, m.updated_at AS spec_at, m.fit_key, m.retrain, s.history_at
      FROM streams s
      LEFT JOIN model_specs m ON m.target_uuid = s.uuid
      LEFT JOIN (SELECT * FROM observations QUALIFY row_number() OVER (PARTITION BY stream_uuid ORDER BY ts DESC) = 1) o
        ON o.stream_uuid = s.uuid
      LEFT JOIN (SELECT * FROM predictions QUALIFY row_number() OVER (PARTITION BY stream_uuid ORDER BY id DESC) = 1) p
        ON p.stream_uuid = s.uuid
      ORDER BY s.name, s.uuid`)),

    /** Each central stream's last `n` observations, oldest first: { uuid: [value] } (Home's trend lines). */
    sparks: inOrder(async (n = 24) => {
      const out = {};
      for (const r of await rows(`SELECT stream_uuid, value FROM observations
        QUALIFY row_number() OVER (PARTITION BY stream_uuid ORDER BY ts DESC) <= ? ORDER BY stream_uuid, ts`, n)) {
        (out[r.stream_uuid] ??= []).push(r.value);
      }
      return out;
    }),

    /**
     * Upsert each row's stream (its last row in the list names it); insert or ignore the observations (a second
     * seen twice keeps the first). Two statements, one commit. The uuids that got a new row, in the list's order.
     */
    addObservations: inOrder(async (list) => {
      if (!list.length) return [];
      const streams = [...new Map(list.map((o) => [o.stream_uuid, o])).values()];
      let added;
      await run('BEGIN TRANSACTION');
      try {
        await run(`INSERT INTO streams (uuid, name, meta) SELECT ${TXT('c0')}, ${TXT('c1')}, ${TXT('c2')} FROM ${rowsOf(3)}
          ON CONFLICT (uuid) DO UPDATE SET name = excluded.name, meta = excluded.meta`,
        texts(streams.map((o) => o.stream_uuid)), texts(streams.map((o) => o.name)), texts(streams.map((o) => o.meta)));
        added = await rows(`INSERT OR IGNORE INTO observations SELECT ${TXT('c0')}, ${NUM('c1', 'BIGINT')}, ${NUM('c2', 'DOUBLE')}
          FROM ${rowsOf(3)} RETURNING stream_uuid`,
        texts(list.map((o) => o.stream_uuid)), nums(list.map((o) => o.ts)), nums(list.map((o) => o.value)));
        await run('COMMIT');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
      const fresh = new Set(added.map((r) => r.stream_uuid));
      return streams.map((o) => o.stream_uuid).filter((u) => fresh.has(u));
    }),
    /** A stream's observations, oldest first: [{ts, value}]. */
    history: inOrder((uuid) => rows('SELECT ts, value FROM observations WHERE stream_uuid = ? ORDER BY ts', uuid)),
    /** Every central stream's observations, oldest first, in one read: Map(uuid → [{ts, value}]). */
    centralHistories: inOrder(async () => {
      const t = await query(conn, `SELECT o.stream_uuid, o.ts::DOUBLE AS ts, o.value FROM observations o
        JOIN streams s ON s.uuid = o.stream_uuid ORDER BY o.stream_uuid, o.ts`);
      const uuids = t.getChild('stream_uuid').toArray();
      const ts = t.getChild('ts').toArray();
      const values = t.getChild('value').toArray();
      const out = new Map();
      let list;
      for (let i = 0; i < t.numRows; i++) {
        if (i === 0 || uuids[i] !== uuids[i - 1]) out.set(uuids[i], (list = []));
        list.push({ ts: ts[i], value: values[i] });
      }
      return out;
    }),
    /** Some streams' observations in one read, oldest first: Map(uuid → [{ts, value}]), in the order asked (the Models tab's drill-in). */
    histories: inOrder(async (uuids) => {
      const out = new Map(uuids.map((u) => [u, []]));
      if (!uuids.length) return out;
      const t = await query(conn, `SELECT stream_uuid, ts::DOUBLE AS ts, value FROM observations
        WHERE stream_uuid IN (${uuids.map(() => '?').join(', ')}) ORDER BY stream_uuid, ts`, uuids);
      const u = t.getChild('stream_uuid').toArray();
      const ts = t.getChild('ts').toArray();
      const values = t.getChild('value').toArray();
      for (let i = 0; i < t.numRows; i++) out.get(u[i]).push({ ts: ts[i], value: values[i] });
      return out;
    }),
    /** Central streams whose history has not been fetched yet. */
    needHistory: inOrder(async () => (await rows('SELECT uuid FROM streams WHERE history_at IS NULL ORDER BY uuid')).map((r) => r.uuid)),
    /**
     * Streams' history from central, [{ uuid, rows: [{ts, value}] }], in one commit (each commit is a checkpoint:
     * storage.md): for each, insert or ignore the rows older than its newest stored (polled) one, so a backfill
     * never pre-empts a poll's new row; mark them fetched. → how many rows were added
     */
    addHistories: inOrder(async (list, at) => {
      if (!list.length) return 0;
      let added = 0;
      await run('BEGIN TRANSACTION');
      try {
        // a statement per ~10,000 rows (83,000 in one stops the wasm: storage.md), whole streams; INSERT's Count is
        // the rows inserted, the ignored ones not counted (RETURNING made it 3× slower)
        for (const part of byRows(list.filter((x) => x.rows.length), HISTORY_ROWS)) {
          const [{ Count }] = await rows(`INSERT OR IGNORE INTO observations SELECT x.u, x.t, x.v FROM
            (SELECT ${TXT('c0')} AS u, ${NUM('c1', 'BIGINT')} AS t, ${NUM('c2', 'DOUBLE')} AS v FROM ${rowsOf(3)}) x
            JOIN (SELECT stream_uuid, max(ts) AS newest FROM observations GROUP BY stream_uuid) n ON n.stream_uuid = x.u
            WHERE x.t < n.newest`,
          part.map(({ uuid, rows: xs }) => Array(xs.length).fill(b64(uuid)).join(',')).join(','),
          part.map(({ rows: xs }) => nums(xs.map((o) => o.ts))).join(','), part.map(({ rows: xs }) => nums(xs.map((o) => o.value))).join(','));
          added += Number(Count);
        }
        await run(`UPDATE streams SET history_at = ? WHERE uuid IN (SELECT ${TXT('c0')} FROM ${rowsOf(1)})`, at, texts(list.map((x) => x.uuid)));
        await run('COMMIT');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
      return added;
    }),
    /** Each target's champion spec: Map(uuid → {spec, score, persist, influence, generation, accepted, updated_at, fit_key, retrain}). */
    specs: inOrder(async () => new Map((await rows('SELECT * FROM model_specs')).map((r) =>
      [r.target_uuid, { spec: JSON.parse(r.spec), score: r.score, persist: r.persist ?? null,
        influence: r.influence == null ? null : JSON.parse(r.influence), generation: r.generation, accepted: r.accepted,
        updated_at: r.updated_at, fit_key: r.fit_key ?? null, retrain: r.retrain == null ? null : JSON.parse(r.retrain) }]))),
    /**
     * Store the specs a poll touched: Map(uuid → {spec, score, persist?, influence?, generation, accepted, fit_key?}). One
     * statement. persist and influence: what the Models tab shows (migration 11); fit_key: the data they were computed on (12).
     */
    saveSpecs: inOrder(async (specs, at) => {
      if (!specs.size) return;
      const list = [...specs];
      await run(`INSERT INTO model_specs (target_uuid, spec, score, generation, accepted, updated_at, persist, influence, fit_key)
          SELECT ${TXT('c0')}, ${TXT('c1')}, ${NUM('c2', 'DOUBLE')}, ${NUM('c3', 'INTEGER')}, ${NUM('c4', 'INTEGER')},
            ${NUM('c5', 'BIGINT')}, ${NUM('c6', 'DOUBLE')}, ${TXT('c7')}, ${TXT('c8')} FROM ${rowsOf(9)}
        ON CONFLICT (target_uuid) DO UPDATE SET spec = excluded.spec, score = excluded.score, generation = excluded.generation,
          accepted = excluded.accepted, updated_at = excluded.updated_at, persist = excluded.persist, influence = excluded.influence,
          fit_key = excluded.fit_key`,
      texts(list.map(([u]) => u)), texts(list.map(([, r]) => JSON.stringify(r.spec))), nums(list.map(([, r]) => r.score)),
      nums(list.map(([, r]) => r.generation)), nums(list.map(([, r]) => r.accepted)), nums(list.map(() => at)),
      nums(list.map(([, r]) => r.persist)), texts(list.map(([, r]) => (r.influence ? JSON.stringify(r.influence) : null))),
      texts(list.map(([, r]) => r.fit_key ?? null)));
    }),
    /**
     * The training pass's scores ([{ uuid, spec (the stored text it fit), score, persist, influence, fit_key }]), one
     * statement: only where that spec is still the stored one (a poll that evolved it meanwhile wins); the spec, its
     * generation and accepted untouched; updated_at = at (when it last trained). → how many rows took it
     */
    saveFits: inOrder(async (list, at) => {
      if (!list.length) return 0;
      const [{ Count }] = await rows(`UPDATE model_specs SET score = x.score, persist = x.persist, influence = x.influence,
          fit_key = x.fit_key, updated_at = x.at
        FROM (SELECT ${TXT('c0')} AS u, ${TXT('c1')} AS spec, ${NUM('c2', 'DOUBLE')} AS score, ${NUM('c3', 'DOUBLE')} AS persist,
          ${TXT('c4')} AS influence, ${TXT('c5')} AS fit_key, ${NUM('c6', 'BIGINT')} AS at FROM ${rowsOf(7)}) x
        WHERE model_specs.target_uuid = x.u AND model_specs.spec = x.spec`,
      texts(list.map((r) => r.uuid)), texts(list.map((r) => r.spec)), nums(list.map((r) => r.score)),
      nums(list.map((r) => r.persist)), texts(list.map((r) => (r.influence ? JSON.stringify(r.influence) : null))),
      texts(list.map((r) => r.fit_key)), nums(list.map(() => at)));
      return Number(Count);
    }),

    /** A target's retrain (migration 13): the request, its progress, its result, as JSON on its spec's row (null clears it). → rows changed */
    setRetrain: inOrder(async (uuid, value) => {
      const [{ Count }] = await rows('UPDATE model_specs SET retrain = ? WHERE target_uuid = ?', value == null ? null : JSON.stringify(value), uuid);
      return Number(Count);
    }),
    /**
     * A retrain's new champion (docs/design/models.md#retrain), one statement: the spec with its fit (score, persist,
     * influence, fit_key: as the poll scores it), generation + 1, accepted + 1, the retrain's summary; only where the
     * stored spec is still `from` (the text it was compared with: a poll that evolved it meanwhile wins). → rows changed
     */
    saveRetrained: inOrder(async ({ uuid, from, spec, score, persist, influence, fit_key, retrain }, at) => {
      const [{ Count }] = await rows(`UPDATE model_specs SET spec = ?, score = ${D}, persist = ${D}, influence = ?, fit_key = ?,
          generation = generation + 1, accepted = accepted + 1, updated_at = ?, retrain = ?
        WHERE target_uuid = ? AND spec = ?`,
      JSON.stringify(spec), dbl(score), dbl(persist), influence ? JSON.stringify(influence) : null, fit_key, at, JSON.stringify(retrain), uuid, from);
      return Number(Count);
    }),

    /** Central streams whose latest observation has no prediction made from it (newer than predicted_ts). */
    unpredicted: inOrder(async () => (await rows(`SELECT s.uuid FROM streams s
      JOIN (SELECT stream_uuid, max(ts) AS ts FROM observations GROUP BY stream_uuid) o ON o.stream_uuid = s.uuid
      WHERE s.predicted_ts IS NULL OR o.ts > s.predicted_ts ORDER BY s.uuid`)).map((r) => r.uuid)),
    /**
     * A poll's predictions, in one transaction (one checkpoint); each with an obs_ts (the observation it was made
     * from) marks its stream predicted through it. → their ids, in order
     */
    addPredictions: inOrder(async (list) => {
      if (!list.length) return [];
      const col = (k, f = nums) => f(list.map((p) => p[k]));
      const marks = [...new Map(list.filter((p) => p.obs_ts != null).map((p) => [p.stream_uuid, p.obs_ts]))]; // its last
      let ids;
      await run('BEGIN TRANSACTION');
      try {
        // the ids come from the sequence in the list's order
        ids = (await rows(`INSERT INTO predictions (stream_uuid, made_at, model, t1, t2, phi, weight, observed_at, hash)
          SELECT ${TXT('c0')}, ${NUM('c1', 'DOUBLE')}, ${TXT('c2')}, ${NUM('c3', 'DOUBLE')}, ${NUM('c4', 'DOUBLE')},
            ${NUM('c5', 'DOUBLE')}, ${NUM('c6', 'DOUBLE')}, ${TXT('c7')}, ${TXT('c8')} FROM ${rowsOf(9)} RETURNING id`,
        col('stream_uuid', texts), col('made_at'), col('model', texts), col('t1'), col('t2'), col('phi'), col('weight'),
        col('observed_at', texts), col('hash', texts))).map((r) => r.id).sort((a, b) => a - b);
        if (marks.length) {
          await run(`UPDATE streams SET predicted_ts = x.t FROM (SELECT ${TXT('c0')} AS u, ${NUM('c1', 'BIGINT')} AS t FROM ${rowsOf(2)}) x
            WHERE streams.uuid = x.u`, texts(marks.map(([u]) => u)), nums(marks.map(([, t]) => t)));
        }
        await run('COMMIT');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
      return ids;
    }),
    /** The kept queue: every pending prediction, oldest first, with its stream's name. */
    pending: inOrder(() => rows(`SELECT p.*, s.name FROM predictions p JOIN streams s ON s.uuid = p.stream_uuid
      WHERE p.status = 'pending' ORDER BY p.id`)),
    pendingCount: inOrder(async () => (await rows("SELECT count(*) AS n FROM predictions WHERE status = 'pending'"))[0].n),
    markSent: inOrder(async (ids, at) => {
      if (ids.length) await run(`UPDATE predictions SET status = 'sent', sent_at = ${D} WHERE id IN (${ids.map(() => '?').join(', ')})`, dbl(at), ...ids);
    }),
    /** The cap on the kept queue: pending predictions made before `before` are deleted. */
    dropPending: inOrder((before) => run("DELETE FROM predictions WHERE status = 'pending' AND made_at < ?", before)),
    /** Another central: its uuids differ, so the pending queue, the stream list, the specs and the last poll/submission/history go. */
    resetCentral: inOrder(async () => {
      await run("DELETE FROM predictions WHERE status = 'pending'");
      await run('DELETE FROM streams');
      await run('DELETE FROM model_specs');
      await run("DELETE FROM meta WHERE key IN ('central_last_poll', 'central_last_submit', 'central_history')");
    }),
    /** A stream's predictions (by uuid or name), newest first. */
    predictions: inOrder((stream, limit = 20) => rows(`SELECT p.*, s.name FROM predictions p
      JOIN streams s ON s.uuid = p.stream_uuid WHERE p.stream_uuid = ? OR s.name = ? ORDER BY p.id DESC LIMIT ?`,
      stream, stream, limit)),

    // ── relay (Nostr) streams ──
    /**
     * Subscribe (again): active from `now`; a row that exists keeps its
     * pred_created_at and pred_seq. (meta and unsubscribed_at, from migration
     * 4, are no longer written: nothing read them.)
     */
    subscribeRelay: inOrder(async ({ uuid, stream_name, provider_pubkey, name, cadence_seconds, now }) => {
      await run(`INSERT INTO relay_streams (uuid, stream_name, provider_pubkey, name, cadence_seconds, active,
          subscribed_at, pred_created_at, pred_seq) VALUES (?, ?, ?, ?, ?, true, ?, ?, 0)
        ON CONFLICT (uuid) DO UPDATE SET name = excluded.name, cadence_seconds = excluded.cadence_seconds,
          active = true, subscribed_at = excluded.subscribed_at`,
      uuid, stream_name, provider_pubkey, name ?? '', cadence_seconds ?? null, now, now);
      return (await rows('SELECT * FROM relay_streams WHERE uuid = ?', uuid))[0];
    }),
    unsubscribeRelay: inOrder((uuid) => run('UPDATE relay_streams SET active = false WHERE uuid = ?', uuid)),
    relayStream: inOrder(async (uuid) => (await rows('SELECT * FROM relay_streams WHERE uuid = ?', uuid))[0] ?? null),
    countActiveRelay: inOrder(async () => (await rows('SELECT count(*) AS n FROM relay_streams WHERE active'))[0].n),
    /**
     * Each relay stream, newest subscription first, with its latest observation
     * (obs_*, the highest seq), our latest `_pred` (p_*) and its observation
     * count: all kept on the stream's row at insert time (migration 5).
     */
    relayStreams: inOrder(({ active } = {}) =>
      rows(`SELECT * FROM relay_streams ${active ? 'WHERE active' : ''} ORDER BY subscribed_at DESC, uuid`)),
    /** Insert or ignore (the event id, or the stream's seq, seen before): true when new (network_db.py:597-636). */
    addRelayObservation: inOrder(async (o) => {
      await run('BEGIN TRANSACTION');
      try {
        const fresh = (await rows(`INSERT OR IGNORE INTO relay_observations VALUES (?, ?, ?, ${D}, ?, ?, ?) RETURNING seq`,
          o.stream_uuid, o.seq, o.ts ?? null, dbl(o.value), o.raw ?? null, o.event_id, o.received_at)).length > 0;
        if (fresh) {
          await run('UPDATE relay_streams SET observations = observations + 1 WHERE uuid = ?', o.stream_uuid);
          await run(`UPDATE relay_streams SET obs_seq = ?, obs_ts = ?, obs_value = ${D}, obs_raw = ?, obs_received_at = ?
            WHERE uuid = ? AND (obs_seq IS NULL OR obs_seq < ?)`,
          o.seq, o.ts ?? null, dbl(o.value), o.raw ?? null, o.received_at, o.stream_uuid, o.seq);
        }
        await run('COMMIT');
        return fresh;
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
    }),
    /** The engine's input for a relay stream: [{ts, value}] with a number and a time, oldest first. */
    relayHistory: inOrder((uuid) => rows(`SELECT ts, value FROM relay_observations
      WHERE stream_uuid = ? AND value IS NOT NULL AND ts IS NOT NULL ORDER BY ts, seq`, uuid)),
    /** The `_pred` seq for the next publish: last + 1, kept (network_db.py:835-848). */
    nextPredSeq: inOrder(async (uuid) =>
      (await rows('UPDATE relay_streams SET pred_seq = pred_seq + 1 WHERE uuid = ? RETURNING pred_seq', uuid))[0].pred_seq),
    /** A `_pred` we publish, and on its stream's row (the latest): with its backtest (score, persist, tests) when it has one. */
    addRelayPrediction: inOrder(async (p) => {
      await run('INSERT INTO relay_predictions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        p.stream_uuid, p.seq, p.value, p.model ?? null, p.obs_seq ?? null, p.made_at, p.event_id, p.relays);
      await run(`UPDATE relay_streams SET p_seq = ?, p_value = ?, p_model = ?, p_made_at = ?, p_relays = ?, p_score = ${D},
          p_persist = ${D}, p_tests = ? WHERE uuid = ? AND (p_seq IS NULL OR p_seq < ?)`,
      p.seq, p.value, p.model ?? null, p.made_at, p.relays, dbl(p.score), dbl(p.persist), p.tests ?? null, p.stream_uuid, p.seq);
    }),
    /** The latest `_pred`'s backtest, computed later (the training pass): only while `seq` is still the latest. */
    setRelayFit: inOrder((uuid, seq, { score, persist, tests }) => run(`UPDATE relay_streams SET p_score = ${D}, p_persist = ${D},
      p_tests = ? WHERE uuid = ? AND p_seq = ?`, dbl(score), dbl(persist), tests ?? null, uuid, seq)),
    /** How many relays took a published `_pred` (known after it is kept). */
    setPredictionRelays: inOrder(async (uuid, seq, n) => {
      await run('UPDATE relay_predictions SET relays = ? WHERE stream_uuid = ? AND seq = ?', n, uuid, seq);
      await run('UPDATE relay_streams SET p_relays = ? WHERE uuid = ? AND p_seq = ?', n, uuid, seq);
    }),
    relayPredictions: inOrder((uuid, limit = 20) =>
      rows('SELECT * FROM relay_predictions WHERE stream_uuid = ? ORDER BY seq DESC LIMIT ?', uuid, limit)),

    // ── the activity log (docs/design/health.md) ──
    /** One event: { at, kind, level, data, until?, mkey? } → its id. */
    addActivity: inOrder(async ({ at, kind, level, data, until = null, mkey = null }) =>
      (await rows(`INSERT INTO activity (ts, last_ts, kind, level, data, mkey) VALUES (${D}, ${D}, ?, ?, ?, ?) RETURNING id`,
        dbl(at), dbl(until), kind, level, JSON.stringify(data ?? null), mkey))[0].id),
    /** A merged row's change: any of until, level, data, count. */
    updateActivity: inOrder(async (id, fields) => {
      const COLUMN = { until: `last_ts = ${D}`, level: 'level = ?', data: 'data = ?', count: 'count = ?' };
      const set = [];
      const args = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!COLUMN[k]) throw new Error(`activity has no ${k} to update`);
        set.push(COLUMN[k]);
        args.push(k === 'until' ? dbl(v) : k === 'data' ? JSON.stringify(v) : v);
      }
      if (set.length) await run(`UPDATE activity SET ${set.join(', ')} WHERE id = ?`, ...args, id);
    }),
    /** The rows that started or last changed at or after `since`, oldest first, data parsed. */
    activity: inOrder(async (since) => (await rows(`SELECT id, ts, last_ts, kind, level, data, count, mkey FROM activity
      WHERE greatest(ts, coalesce(last_ts, ts)) >= ${D} ORDER BY ts, id`, dbl(since)))
      .map(({ ts, last_ts: until, data, ...r }) => ({ id: r.id, at: ts, until, kind: r.kind, level: r.level,
        data: JSON.parse(data), count: r.count, mkey: r.mkey }))),
    /** When the log's oldest session began (unix seconds), or null. */
    firstSession: inOrder(async () => (await rows("SELECT min(ts) AS at FROM activity WHERE kind = 'open'"))[0].at ?? null),
    /** The 90-day bound: rows that ended before `before` go. */
    pruneActivity: inOrder((before) => run(`DELETE FROM activity WHERE greatest(ts, coalesce(last_ts, ts)) < ${D}`, dbl(before))),

    checkpoint: inOrder(() => run('CHECKPOINT')),
    close: inOrder(async () => {
      await run('CHECKPOINT');
      await closeDb();
    }),
  };
}
