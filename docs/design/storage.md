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
  Implemented by `openStore()` in `src/store/index.js` (API documented at its
  top); the reopen terminates DuckDB's worker, so startup instantiates the wasm
  twice.
- Migrations are an ordered array in `src/store/schema.js` (one SQL string each,
  each run in a transaction), not separate files.
- Verified 2026-10-15 (Chrome 151, `e2e/opfs.spec.js`): `opfs://satori.duckdb`
  opened from a module worker that spawns DuckDB's eh worker, under the CSP
  header; write, `CHECKPOINT`, terminate, reopen and read, and again after a page
  reload. Also passes from a `vite build` bundle (`?url` imports for the wasm
  and DuckDB worker).

### Bundle

The `eh` bundle (mvp fallback), no threads, so no COOP/COEP. About 7.6 MB gzip
for the wasm (measured on jsDelivr), self-hosted on our origin with its worker
and precached by the service worker.

**No extensions.** Verified with 1.32.0 (DuckDB v1.4.3, same `duckdb-eh.wasm`):
only `core_functions` is statically linked; creating a `JSON` column autoloads
`json` from `https://extensions.duckdb.org/v1.4.3/wasm_eh/` (820 KB), and
`sqlite_scanner` loads the same way. That breaks offline start and the CSP. So:
JSON is stored as `VARCHAR` and parsed in JS, and
`SET autoload_known_extensions = false` at open so a stray type fails in tests,
not in the field. If an extension is ever needed, self-host its wasm, point
`custom_extension_repository` at our origin and precache it.

## Durability rules

- Writes go to the WAL; committed transactions replay on the next open
  (duckdb.org/2026/09/18/opfs-wasm, Durability). Run `CHECKPOINT` after each
  ingest or prediction batch. Nothing relies on `pagehide`: shutdown code does
  not run reliably in a tab (same source).
- One OPFS handle per file: only the leader tab's worker opens the database
  ([runtime.md](runtime.md#one-neuron-per-browser)).
- `navigator.storage.persist()` on first run, from the page: `persist()` is
  exposed on `Window` only, not in workers (Storage Standard). Eviction loses history, not keys
  or money; Base history reloads from the registry, central-lite history
  regrows from the poll.
- DuckDB is slow at single-row writes: batch inserts.

## Schema (v1)

Ported from `neuron/neuron-lite/satorineuron/network_db.py:74-447` and
`neuron/engine-lite/satoriengine/stream_store.py:48-56`, keeping only what v1
reads. Docker's try-`SELECT`-then-`ALTER` migrations become a `schema_version`
row and ordered migration files.

```sql
CREATE TABLE schema_version (version INTEGER);
CREATE TABLE settings (key VARCHAR PRIMARY KEY, value VARCHAR);  -- JSON text
  -- base_predict_enabled, base_last_submit_ts, central_poll_due, central_url,
  -- rpc_url, base_config_cache, registered_keys, ui prefs

-- One read path for the engine. Base: provider = 'base', stream_name = '<streamId>',
-- round = registry hour. Central-lite: provider = 'central', stream_name = stream_uuid.
CREATE TABLE observations (stream_name VARCHAR, provider_pubkey VARCHAR,
  seq_num BIGINT, observed_at DOUBLE, received_at DOUBLE, value_raw VARCHAR,
  value DOUBLE, round BIGINT,
  UNIQUE (stream_name, provider_pubkey, seq_num));
  -- plus a unique index on (stream_name, provider_pubkey, round)

CREATE TABLE stream_names (stream_name VARCHAR, provider_pubkey VARCHAR,
  display_name VARCHAR, game_id INTEGER, PRIMARY KEY (stream_name, provider_pubkey));

CREATE TABLE predictions (stream_name VARCHAR, provider_pubkey VARCHAR,
  observation_seq BIGINT, t1 DOUBLE, t2 DOUBLE, model VARCHAR,
  created_at DOUBLE, submitted BOOLEAN DEFAULT false);

CREATE TABLE base_submits (ts BIGINT, round BIGINT, tx_hash VARCHAR,
  games VARCHAR, status VARCHAR);                                  -- games: JSON text
```

Differences from Docker, on purpose:

- `observations.value` is split into the raw text and a parsed `DOUBLE`, so the
  engine reads numbers with SQL.
- Central-lite values share `observations` instead of separate `streams` /
  `history` tables.
- No `engine_state`: the engine refits from `observations` each time.
- No relay, subscription or publication tables until Nostr parity
  ([transport.md](transport.md)); no channels, bounties, data sources or access
  requests until those land.

## Engine reads

`conn.query('SELECT value FROM observations WHERE … ORDER BY observed_at')`
returns an Apache Arrow table; the engine takes its `value` column as a
`Float64Array` without a copy. Arrow version must be the one DuckDB resolves
(`^17`).

## Docker history import (later)

DuckDB's sqlite extension can read an exported `network.db` / `engine.db`, but
it must be self-hosted as above. Not in v1: Base history comes from the registry.
