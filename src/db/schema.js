// Ordered migrations. Never edit a shipped entry: append a new one.
// meta.schema_version holds how many have run.
export const MIGRATIONS = [
  // 1 (step 1): streams fetched from a URL; times in ms.
  `CREATE TABLE streams (name VARCHAR PRIMARY KEY, url VARCHAR NOT NULL,
     path VARCHAR NOT NULL, interval_s INTEGER NOT NULL, created_at DOUBLE NOT NULL,
     last_error VARCHAR, last_error_at DOUBLE);
   CREATE TABLE observations (stream VARCHAR NOT NULL, ts DOUBLE NOT NULL, value DOUBLE NOT NULL);
   CREATE SEQUENCE prediction_ids;
   CREATE TABLE predictions (id INTEGER PRIMARY KEY DEFAULT nextval('prediction_ids'),
     stream VARCHAR NOT NULL, ts DOUBLE NOT NULL, target_ts DOUBLE NOT NULL,
     value DOUBLE NOT NULL, model VARCHAR NOT NULL, address VARCHAR NOT NULL,
     message VARCHAR NOT NULL, signature VARCHAR NOT NULL, published_at DOUBLE);`,
  // 2 (step 3): central's streams replace them (docs/design/central.md). Times
  // are unix seconds, as central and Satori Lite keep them. observations is
  // Lite's StreamStore: one row per (stream, whole second), insert or ignore.
  // predictions: status 'pending' until a batch with successful > 0 takes it.
  `DROP TABLE predictions; DROP SEQUENCE prediction_ids; DROP TABLE observations; DROP TABLE streams;
   CREATE TABLE streams (uuid VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, meta VARCHAR);
   CREATE TABLE observations (stream_uuid VARCHAR NOT NULL, ts BIGINT NOT NULL, value DOUBLE NOT NULL,
     PRIMARY KEY (stream_uuid, ts));
   CREATE SEQUENCE prediction_ids;
   CREATE TABLE predictions (id INTEGER PRIMARY KEY DEFAULT nextval('prediction_ids'),
     stream_uuid VARCHAR NOT NULL, made_at DOUBLE NOT NULL, model VARCHAR NOT NULL,
     t1 DOUBLE NOT NULL, t2 DOUBLE NOT NULL, observed_at VARCHAR NOT NULL, hash VARCHAR NOT NULL,
     status VARCHAR NOT NULL DEFAULT 'pending', sent_at DOUBLE);`,
  // 3 (step 4): the engine's AR coefficient and fade weight (docs/design/engine.md);
  // null for `naive` and for older rows.
  `ALTER TABLE predictions ADD COLUMN phi DOUBLE;
   ALTER TABLE predictions ADD COLUMN weight DOUBLE;`,
  // 4 (step 5): relay (Nostr) streams, apart from central's, as Lite's network.db
  // (docs/design/nostr.md#storage-migration-4). uuid = Lite's relay model uuid.
  // relay_streams: a subscription and its `_pred` publication (created_at, last seq).
  // relay_observations: deduped on the event id and on (stream, seq); value is
  // the unwrapped number or null. relay_predictions: what we published, to how many relays.
  `CREATE TABLE relay_streams (uuid VARCHAR PRIMARY KEY, stream_name VARCHAR NOT NULL, provider_pubkey VARCHAR NOT NULL,
     name VARCHAR, cadence_seconds BIGINT, meta VARCHAR, active BOOLEAN NOT NULL, subscribed_at BIGINT NOT NULL,
     unsubscribed_at BIGINT, pred_created_at BIGINT NOT NULL, pred_seq BIGINT NOT NULL DEFAULT 0);
   CREATE TABLE relay_observations (stream_uuid VARCHAR NOT NULL, seq BIGINT NOT NULL, ts BIGINT, value DOUBLE,
     raw VARCHAR, event_id VARCHAR NOT NULL UNIQUE, received_at BIGINT NOT NULL, PRIMARY KEY (stream_uuid, seq));
   CREATE TABLE relay_predictions (stream_uuid VARCHAR NOT NULL, seq BIGINT NOT NULL, value VARCHAR NOT NULL,
     model VARCHAR, obs_seq BIGINT, made_at BIGINT NOT NULL, event_id VARCHAR NOT NULL, relays INTEGER NOT NULL,
     PRIMARY KEY (stream_uuid, seq));`,
  // 5 (step 5 review): each relay stream keeps its latest observation, latest
  // prediction and observation count on its row, set at insert time, so the
  // status (on every change) reads one row per stream, not every observation.
  `ALTER TABLE relay_streams ADD COLUMN observations BIGINT DEFAULT 0;
   ALTER TABLE relay_streams ADD COLUMN obs_seq BIGINT;
   ALTER TABLE relay_streams ADD COLUMN obs_ts BIGINT;
   ALTER TABLE relay_streams ADD COLUMN obs_value DOUBLE;
   ALTER TABLE relay_streams ADD COLUMN obs_raw VARCHAR;
   ALTER TABLE relay_streams ADD COLUMN obs_received_at BIGINT;
   ALTER TABLE relay_streams ADD COLUMN p_seq BIGINT;
   ALTER TABLE relay_streams ADD COLUMN p_value VARCHAR;
   ALTER TABLE relay_streams ADD COLUMN p_model VARCHAR;
   ALTER TABLE relay_streams ADD COLUMN p_made_at BIGINT;
   ALTER TABLE relay_streams ADD COLUMN p_relays INTEGER;
   UPDATE relay_streams SET observations = x.n, obs_seq = x.seq, obs_ts = x.ts, obs_value = x.value, obs_raw = x.raw,
     obs_received_at = x.received_at
   FROM (SELECT stream_uuid, count(*) AS n, max(seq) AS seq, arg_max(ts, seq) AS ts, arg_max(value, seq) AS value,
     arg_max(raw, seq) AS raw, arg_max(received_at, seq) AS received_at FROM relay_observations GROUP BY stream_uuid) x
   WHERE x.stream_uuid = relay_streams.uuid;
   UPDATE relay_streams SET p_seq = x.seq, p_value = x.value, p_model = x.model, p_made_at = x.made_at, p_relays = x.relays
   FROM (SELECT stream_uuid, max(seq) AS seq, arg_max(value, seq) AS value, arg_max(model, seq) AS model,
     arg_max(made_at, seq) AS made_at, arg_max(relays, seq) AS relays FROM relay_predictions GROUP BY stream_uuid) x
   WHERE x.stream_uuid = relay_streams.uuid;`,
  // 6 (bvar): each central target's champion spec, drawn from the identity and
  // evolved after each poll (docs/design/engine.md#bvar-a-model-per-central-stream-unique-to-each-neuron):
  // spec = JSON {companions, lambda1, lambda2}; score = its backtest error (null
  // until 5 origins); generation = mutations proposed; accepted = mutations kept.
  // streams.history_at: when central's history was fetched for the stream (null = not yet).
  `CREATE TABLE model_specs (target_uuid VARCHAR PRIMARY KEY, spec VARCHAR NOT NULL, score DOUBLE,
     generation INTEGER NOT NULL DEFAULT 0, accepted INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL);
   ALTER TABLE streams ADD COLUMN history_at BIGINT;`,
];
