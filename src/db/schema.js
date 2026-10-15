// Ordered migrations. Never edit a shipped entry: append a new one.
// meta.schema_version holds how many have run. Times are ms since the epoch.
export const MIGRATIONS = [
  // 1
  `CREATE TABLE streams (name VARCHAR PRIMARY KEY, url VARCHAR NOT NULL,
     path VARCHAR NOT NULL, interval_s INTEGER NOT NULL, created_at DOUBLE NOT NULL,
     last_error VARCHAR, last_error_at DOUBLE);
   CREATE TABLE observations (stream VARCHAR NOT NULL, ts DOUBLE NOT NULL, value DOUBLE NOT NULL);
   CREATE SEQUENCE prediction_ids;
   CREATE TABLE predictions (id INTEGER PRIMARY KEY DEFAULT nextval('prediction_ids'),
     stream VARCHAR NOT NULL, ts DOUBLE NOT NULL, target_ts DOUBLE NOT NULL,
     value DOUBLE NOT NULL, model VARCHAR NOT NULL, address VARCHAR NOT NULL,
     message VARCHAR NOT NULL, signature VARCHAR NOT NULL, published_at DOUBLE);`,
];
