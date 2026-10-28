// A WAL an older version of the app left, and a database file that will not open (docs/design/storage.md#recovery).
// On OPFS, DuckDB-WASM 1.32.0 never truncates the WAL at a checkpoint, and a
// WAL the database has moved past can be replayed again; it cannot replay one
// that holds migration 3 at all, an ALTER TABLE … ADD COLUMN on a table with a
// nextval default (DuckDB 1.4.3, duckdb#18259). Since this version every
// commit is checkpointed and the WAL stays empty, so a non-empty WAL is an
// older version's: before the database opens, it is moved out of DuckDB's way,
// renamed, never deleted.

export const WAL_REPLAY_FAILED = /Failure while replaying WAL/;

/**
 * Settle a WAL left by an older version, before the database opens:
 * checkpoint() opens the database on it once (DuckDB replays it, or skips it
 * as already checkpointed) and checkpoints, then it is set aside as
 * 'checkpointed' (what it held is in the database file). When DuckDB fails to
 * replay it, it is set aside as 'unreplayed' and its changes are not in the
 * database. Any other failure is thrown, the WAL left where it is.
 * @param {{walBytes: () => Promise<number>, checkpoint: () => Promise<void>, setAside: (kind: string) => Promise<string>}} o
 * @returns {Promise<string | null>} the unreplayed WAL's new name, or null
 */
export async function settleWal({ walBytes, checkpoint, setAside }) {
  if (!(await walBytes())) return null;
  try {
    await checkpoint();
  } catch (err) {
    if (!WAL_REPLAY_FAILED.test(String(err?.message ?? err))) throw err;
    console.warn('[satori] DuckDB could not replay the WAL: it is set aside', err);
    return setAside('unreplayed');
  }
  await setAside('checkpointed');
  return null;
}

/** A file renamed in an OPFS directory, tried `tries` times 100 ms apart while an ended worker still holds it. */
async function moveWhenFree(dir, from, to, { tries = 50, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const handle = await dir.getFileHandle(from);
  for (let i = 1; ; i++) {
    try {
      await handle.move(to);
      return to;
    } catch (err) {
      if (i >= tries) throw err;
      await wait(100);
    }
  }
}
const stamp = (now) => now.toISOString().replace(/[:.]/g, '-');

/**
 * A database file DuckDB will not open (damaged: "Corrupt database file"), set aside so the app can start again
 * (docs/design/storage.md#recovery): renamed `<name>.corrupt-<time>`, never deleted, with its WAL, if any, as
 * `<name>.wal.corrupt-<time>` (a fresh file must not replay another's WAL). The person asked for it ("Set aside and
 * start again"). → the database file's new name
 */
export async function setAsideDatabase(dir, name, { kind = 'corrupt', now = new Date(), tries, wait } = {}) {
  const at = stamp(now);
  const to = await moveWhenFree(dir, name, `${name}.${kind}-${at}`, { tries, wait });
  const wal = await dir.getFileHandle(`${name}.wal`).then(() => true, () => false);
  if (wal) await moveWhenFree(dir, `${name}.wal`, `${name}.wal.${kind}-${at}`, { tries, wait });
  return to;
}

/**
 * Rename `<name>.wal` to `<name>.wal.<kind>-<time>` in the OPFS directory
 * `dir` (FileSystemFileHandle.move: Chrome 102, Firefox 111, Safari 15.2).
 * DuckDB's worker is ended first; until it has let go of the file the move
 * fails, so it is tried again every 100 ms, `tries` times.
 * @returns {Promise<string>} the new name
 */
export async function setAsideWal(dir, name, kind, { now = new Date(), tries, wait } = {}) {
  return moveWhenFree(dir, `${name}.wal`, `${name}.wal.${kind}-${stamp(now)}`, { tries, wait });
}

/** A file's size in the OPFS directory `dir`; 0 when there is none. */
export async function fileBytes(dir, name) {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size;
  } catch (err) {
    if (err?.name === 'NotFoundError') return 0;
    throw err;
  }
}
