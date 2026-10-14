# Storage

[← OVERVIEW](OVERVIEW.md)

One DuckDB-WASM database on OPFS, owned by the neuron worker. Keys are the
exception: they live in IndexedDB ([identity.md](identity.md#at-rest)), so a
database reset never loses a wallet.

## Engine and version

- `@duckdb/duckdb-wasm` **1.32.0**. The npm `latest` tag (1.33.1-dev57.0) creates
  OPFS files and never writes to them; DuckDB advises 1.32.0 or ≥ 1.33.1-dev64.0
  (duckdb.org/2026/09/18/opfs-wasm).
- Open with `db.open({ path: 'opfs://satori.duckdb', accessMode: READ_WRITE })`.
- Startup self-test: write a row, close, reopen, read it back. Fail loudly.

### Bundle

The `eh` bundle (mvp fallback), no threads, so no COOP/COEP and any static host
works. About 7.6 MB gzip for the wasm (measured on jsDelivr), cached by the
service worker after the first load. Self-host the wasm and worker on our
origin (worker scripts must be same-origin).

## Durability rules

- Writes go to the WAL and reach the main file only at checkpoint. Tabs are
  often killed without a clean close, so run `CHECKPOINT` after each ingest or
  prediction batch, and on `pagehide`.
- One OPFS handle per file: only the leader tab's worker opens the database
  ([runtime.md](runtime.md#one-neuron-per-browser)).
- `navigator.storage.persist()` on first run. Eviction loses history, not keys
  or money; history rebuilds from the network.
- DuckDB is slow at single-row writes: batch inserts (buffer intake for up to
  1 s).

## Schema (v1)

Ported from `neuron/neuron-lite/satorineuron/network_db.py:74-447` and
`neuron/engine-lite/satoriengine/stream_store.py:48-56`, keeping only what v1
reads. `AUTOINCREMENT` becomes a sequence; Docker's try-`SELECT`-then-`ALTER`
migrations (`network_db.py`) become a `schema_version` row and ordered
migration files.

```sql
CREATE TABLE schema_version (version INTEGER);
CREATE TABLE settings (key VARCHAR PRIMARY KEY, value JSON);
  -- base_predict_enabled, base_last_submit_ts, central_poll_due, central_url,
  -- base_config_cache, next_reconcile, ui prefs

CREATE TABLE relays (relay_url VARCHAR PRIMARY KEY, first_seen BIGINT,
  last_active BIGINT, user_added BOOLEAN DEFAULT false);
CREATE TABLE relay_cursor (relay_url VARCHAR, sub_id VARCHAR, since BIGINT,
  PRIMARY KEY (relay_url, sub_id));

CREATE TABLE subscriptions (stream_name VARCHAR, provider_pubkey VARCHAR,
  relay_url VARCHAR, name VARCHAR, cadence_seconds INTEGER,
  price_per_obs INTEGER DEFAULT 0, active BOOLEAN DEFAULT true,
  user_unsubscribed BOOLEAN DEFAULT false, subscribed_at BIGINT,
  stale_since BIGINT, PRIMARY KEY (stream_name, provider_pubkey));

CREATE TABLE publications (stream_name VARCHAR PRIMARY KEY,   -- '<src>_pred'
  source_stream_name VARCHAR, source_provider_pubkey VARCHAR,
  cadence_seconds INTEGER, active BOOLEAN DEFAULT true,
  created_at BIGINT, last_published_at BIGINT, last_seq_num BIGINT DEFAULT 0);

CREATE TABLE observations (stream_name VARCHAR, provider_pubkey VARCHAR,
  seq_num BIGINT, observed_at DOUBLE, received_at DOUBLE, value_json JSON,
  value DOUBLE, event_id VARCHAR, round BIGINT,
  UNIQUE (stream_name, provider_pubkey, seq_num));
  -- plus a unique index on event_id, and on (stream_name, provider_pubkey, round)

CREATE TABLE predictions (stream_name VARCHAR, provider_pubkey VARCHAR,
  observation_seq BIGINT, t1 DOUBLE, t2 DOUBLE, model VARCHAR,
  created_at DOUBLE, published BOOLEAN DEFAULT false);

CREATE TABLE streams (stream_uuid VARCHAR PRIMARY KEY, name VARCHAR,
  author VARCHAR, meta JSON);                                -- central-lite
CREATE TABLE history (stream_uuid VARCHAR, epoch DOUBLE, value DOUBLE,
  id VARCHAR, PRIMARY KEY (stream_uuid, epoch));             -- central-lite

CREATE TABLE engine_state (stream_key VARCHAR PRIMARY KEY, kind VARCHAR,
  params JSON, updated_at DOUBLE);

CREATE TABLE base_submits (ts BIGINT, tx_hash VARCHAR, games JSON, status VARCHAR);
```

Differences from Docker, on purpose:

- `observations.value` is split into the raw JSON and a parsed `DOUBLE`, so the
  engine and charts read numbers with SQL.
- `user_unsubscribed` replaces "row exists but inactive" as the signal that
  auto-selection must not resubscribe (Docker skips ids "active or
  user-unsubscribed", `neuron/neuron-lite/start.py:453-517`).
- `base_submits` records each daily batch for the UI.
- No tables for channels, bounties, data sources or access requests until
  those features land.

## Engine reads

`conn.query('SELECT value FROM observations WHERE … ORDER BY observed_at')`
returns an Apache Arrow table; the engine takes its `value` column as a
`Float64Array` without a copy. Arrow version must be the one DuckDB resolves
(`^17`).

## Docker history import (later)

DuckDB's sqlite extension can read an exported `network.db` / `engine.db`. Not
in v1: history rebuilds from the network within days, and the v1 engine needs
only ~20 points.
