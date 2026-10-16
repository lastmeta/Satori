# DuckDB-WASM's WAL on OPFS can't be relied on

**Status:** open upstream; worked around in this repo · **Kind:** fixable flaw · **Fix in:** DuckDB (the replay) and DuckDB-WASM (the OPFS WAL)

## Precondition

The database is on OPFS (`opfs://…`) in DuckDB-WASM 1.32.0, the newest
release (DuckDB 1.4.3), and a write is committed without a checkpoint. That
is DuckDB's default: it checkpoints once the WAL reaches 16 MB.

## Finding (verified in Chrome, 2026-10-16)

Measured on raw connections and in `e2e/wal.spec.js`; details in
[../design/storage.md](../design/storage.md#the-checkpoint-rule):

1. **Replay fails** for a WAL that holds an `ALTER TABLE … ADD COLUMN` on a
   table with a `DEFAULT nextval(…)` column: "Failure while replaying WAL
   file … Calling DatabaseManager::GetDefaultDatabase with no default
   database set". The database does not open. This is in DuckDB itself
   ([duckdb#18259](https://github.com/duckdb/duckdb/issues/18259), reported on
   1.3.0 to 1.5.6; fixed on DuckDB's main for 1.6, reported as not backported
   to 1.5). DuckDB-WASM's newest build, `1.33.1-dev65.0`, is DuckDB 1.5.6.
   This was the owner's "Satori could not start" (migration 3 is such an
   ALTER).
2. **After a checkpoint, the WAL file is never written again in that
   session**, and it is never truncated. A later write that isn't
   checkpointed is lost on reload: CREATE, CHECKPOINT, INSERT, reload gives
   0 rows.
3. **Stale WAL bytes can be replayed again** once checkpoints that never
   touch the WAL file have moved the database on. A database at CREATE +
   INSERT + CHECKPOINT, reopened, then one INSERT checkpointed at commit,
   fails its next open with "Table with name t already exists!".

## Worked around here

Every commit is checkpointed (`SET checkpoint_threshold = '0b'`), so the WAL
stays empty. A WAL an older version left is checkpointed or found
unreplayable once, then renamed aside before the database opens
(`src/db/recover.js`). When upstream fixes 1 and 2 in a release that writes
OPFS, the setting can stay; only the upgrade has to pass `e2e/store.spec.js`
and `e2e/wal.spec.js`.
