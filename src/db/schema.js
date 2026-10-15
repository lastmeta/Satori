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
];
