// Ordered migrations (storage.md "Schema (v1)"). Never edit a shipped entry:
// append a new one. schema_version holds how many have run.
export const MIGRATIONS = [
  // 1: v1 schema. JSON is VARCHAR text (no extensions in the wasm).
  `CREATE TABLE settings (key VARCHAR PRIMARY KEY, value VARCHAR);
   CREATE TABLE observations (stream_name VARCHAR, provider_pubkey VARCHAR,
     seq_num BIGINT, observed_at DOUBLE, received_at DOUBLE, value_raw VARCHAR,
     value DOUBLE, round BIGINT,
     UNIQUE (stream_name, provider_pubkey, seq_num));
   CREATE UNIQUE INDEX observations_round ON observations (stream_name, provider_pubkey, round);
   CREATE TABLE stream_names (stream_name VARCHAR, provider_pubkey VARCHAR,
     display_name VARCHAR, game_id INTEGER, PRIMARY KEY (stream_name, provider_pubkey));
   CREATE TABLE predictions (stream_name VARCHAR, provider_pubkey VARCHAR,
     observation_seq BIGINT, t1 DOUBLE, t2 DOUBLE, model VARCHAR,
     created_at DOUBLE, submitted BOOLEAN DEFAULT false);
   CREATE TABLE base_submits (ts BIGINT, round BIGINT, tx_hash VARCHAR,
     games VARCHAR, status VARCHAR);`,
];
