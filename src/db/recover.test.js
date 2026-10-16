import { describe, expect, test, vi } from 'vitest';
import { settleWal, setAsideWal, fileBytes } from './recover.js';

// DuckDB-WASM 1.32.0's error on the owner's profile, as its worker sends it
const REPLAY = new Error('Opening the database failed with error: {"exception_type":"INTERNAL","exception_message":"Failure while replaying WAL file \\"opfs://satori-mvp.duckdb.wal\\": Calling DatabaseManager::GetDefaultDatabase with no default database set","stack_trace_pointers":""}');

describe('settleWal: a WAL an older version left, before the database opens', () => {
  const calls = (o) => {
    const log = [];
    return { log, o: {
      walBytes: async () => o.bytes,
      checkpoint: async () => { log.push('checkpoint'); if (o.fail) throw o.fail; },
      setAside: async (kind) => { log.push(kind); return `n.wal.${kind}-t`; },
    } };
  };
  test('no WAL (or an empty one, as every commit is checkpointed now): nothing to do', async () => {
    const { log, o } = calls({ bytes: 0 });
    expect(await settleWal(o)).toBeNull();
    expect(log).toEqual([]);
  });
  test('a WAL DuckDB replays or skips: checkpointed, then set aside as checkpointed; nothing to recover', async () => {
    const { log, o } = calls({ bytes: 8077 });
    expect(await settleWal(o)).toBeNull();
    expect(log).toEqual(['checkpoint', 'checkpointed']);
  });
  test('a WAL DuckDB cannot replay (the owner\'s): set aside as unreplayed → its new name', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { log, o } = calls({ bytes: 6250, fail: REPLAY });
    expect(await settleWal(o)).toBe('n.wal.unreplayed-t');
    expect(log).toEqual(['checkpoint', 'unreplayed']);
  });
  test('any other failure is thrown and the WAL stays where it is (the database file itself, a busy file)', async () => {
    const { log, o } = calls({ bytes: 100, fail: new Error('IO Error: Could not read from file') });
    await expect(settleWal(o)).rejects.toThrow(/Could not read/);
    expect(log).toEqual(['checkpoint']);
  });
});

/** An OPFS directory: files by name and size; move() renames, failing while `locked` > 0. */
function fakeDir(entries, locked = 0) {
  const files = new Map(Object.entries(entries));
  return {
    files,
    async getFileHandle(name) {
      if (!files.has(name)) throw Object.assign(new Error(`${name} not found`), { name: 'NotFoundError' });
      return {
        async getFile() { return { size: files.get(name) }; },
        async move(to) {
          if (locked-- > 0) throw Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' });
          files.set(to, files.get(name));
          files.delete(name);
        },
      };
    },
  };
}

describe('setAsideWal', () => {
  const now = new Date('2026-10-16T14:55:00.123Z');
  const wait = async () => {};
  test('renames <name>.wal to <name>.wal.<kind>-<time>, whole; the database file stays', async () => {
    const dir = fakeDir({ 'satori-mvp.duckdb': 12288, 'satori-mvp.duckdb.wal': 6250 });
    expect(await setAsideWal(dir, 'satori-mvp.duckdb', 'unreplayed', { now, wait }))
      .toBe('satori-mvp.duckdb.wal.unreplayed-2026-10-16T14-55-00-123Z');
    expect(Object.fromEntries(dir.files)).toEqual({ 'satori-mvp.duckdb': 12288, 'satori-mvp.duckdb.wal.unreplayed-2026-10-16T14-55-00-123Z': 6250 });
  });
  test("waits while DuckDB's ended worker still holds the file", async () => {
    const dir = fakeDir({ 'n.wal': 1 }, 3);
    const w = vi.fn(wait);
    expect(await setAsideWal(dir, 'n', 'checkpointed', { now, wait: w })).toBe('n.wal.checkpointed-2026-10-16T14-55-00-123Z');
    expect(w).toHaveBeenCalledTimes(3);
  });
  test('gives up after its tries, the WAL where it was', async () => {
    const dir = fakeDir({ 'n.wal': 1 }, 99);
    await expect(setAsideWal(dir, 'n', 'unreplayed', { now, wait, tries: 5 })).rejects.toThrow(/locked/);
    expect([...dir.files.keys()]).toEqual(['n.wal']);
  });
});

test('fileBytes: the size, 0 when there is no such file', async () => {
  const dir = fakeDir({ 'n.wal': 6250 });
  expect(await fileBytes(dir, 'n.wal')).toBe(6250);
  expect(await fileBytes(dir, 'x.wal')).toBe(0);
});
