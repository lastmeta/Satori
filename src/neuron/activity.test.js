// The activity log's writer (docs/design/health.md#the-activity-log): sessions
// and their heartbeat, a wake after sleep, merges, the 90-day prune, caught up.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb } from '../../test/memory-db.js';
import { createActivity } from './activity.js';
import { CADENCE_S, HEARTBEAT_S, KEEP_S, SLEEP_S } from './health.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // DuckDB's wasm starts in the first beforeEach: slow on a busy box

const T = 1_792_000_000;
let db;
let clock;
const now = () => clock;
const make = (o) => createActivity({ db, now, ...o });
const kinds = (rows) => rows.map((r) => r.kind);
beforeEach(async () => {
  db = await memoryDb();
  clock = T;
});

describe('sessions', () => {
  test('each start is a session; a reload says how long nothing ran; the rows are the db\'s', async () => {
    const onChange = vi.fn();
    const a = make({ onChange });
    await a.start();
    expect(a.rows()).toEqual([expect.objectContaining({ kind: 'open', level: 'ok', at: T, until: T, data: { gap: null, missed: false } })]);
    expect(onChange).toHaveBeenCalled();
    clock += HEARTBEAT_S + 1;
    await a.beat();
    expect(a.rows()[0].until).toBe(T + HEARTBEAT_S + 1);
    clock += 60; // a tick inside the heartbeat: nothing written
    await a.beat();
    expect((await db.activity(0))[0].until).toBe(T + HEARTBEAT_S + 1);

    clock += 100; // a reload
    const b = make();
    await b.start();
    expect(b.rows().map((r) => [r.kind, r.data])).toEqual([['open', { gap: null, missed: false }], ['open', { gap: 160, missed: false }]]);
    expect(await db.activity(0)).toEqual(b.rows());
  });

  test('a tick after more than 15 min (a closed lid, a frozen tab) ends the session where it last ran and starts another', async () => {
    const a = make();
    await a.start();
    clock += 30;
    await a.beat();
    clock += SLEEP_S + 5;
    await a.beat();
    const [first, second] = a.rows();
    expect(first.until).toBe(T + 30);
    expect(second).toMatchObject({ kind: 'open', at: clock, data: { gap: SLEEP_S + 5, missed: false } });
  });

  test('missed work: a poll came due while nothing ran; the first good cycle after it is marked caught up, only that one', async () => {
    const a = make();
    await a.start();
    await a.central({ poll: { at: clock, streams: 2, new: 2, predicted: 2 }, submit: { at: clock, total_submitted: 2, successful: 2 } });
    for (let i = 0; i < 60; i++) { clock += 60; await a.beat(); } // an hour open, ticking
    clock += 2 * 86400; // asleep for two days: the poll due 11 h after the good one fell in the gap
    await a.beat();
    const woke = a.rows().at(-1);
    expect(woke).toMatchObject({ kind: 'open', level: 'idle', data: { gap: 2 * 86400, missed: true } });
    await a.central({ poll: { at: clock + 600, error: 'central unreachable: Failed to fetch' }, submit: null });
    await a.central({ poll: { at: clock + 700, streams: 2, new: 2, predicted: 2 }, submit: { at: clock + 700, total_submitted: 2, successful: 2 } });
    await a.central({ poll: { at: clock + 800, streams: 2, new: 0, predicted: 0 }, submit: null });
    expect(a.rows().slice(-3).map((r) => [r.level, r.data.caughtUp])).toEqual([['bad', undefined], ['ok', 2 * 86400], ['ok', undefined]]);

    clock += CADENCE_S - 60; // a reload before the next poll is due: nothing missed
    const b = make();
    await b.start();
    expect(b.rows().at(-1).data.missed).toBe(false);
  });
});

test('central: one row per cycle with its counts; errors tagged (login, local, unreachable); a failed submission is bad', async () => {
  const a = make();
  await a.start();
  await a.central({ poll: { at: T + 1, streams: 83, new: 83, predicted: 83, engine_ms: 900 }, submit: { at: T + 2, total_submitted: 83, successful: 83 } }, 0);
  await a.central({ poll: { at: T + 3, streams: 83, new: 1, predicted: 1 }, submit: { at: T + 4, error: 'central 401: Invalid signature', total_submitted: 84, login: true } }, 84);
  await a.central({ poll: { at: T + 5, error: 'IO Error', local: true }, submit: null }, 84);
  await a.central({ poll: { at: T + 6, streams: 83, new: 0, predicted: 0 }, submit: { at: T + 7, total_submitted: 84, successful: 0, failed: 84 } }, 84);
  await a.central({ poll: { at: T + 8, streams: 83, new: 0, predicted: 0 },
    submit: { at: T + 9, error: 'Satori Service unreachable: Failed to fetch', total_submitted: 84, unreachable: true } }, 84);
  await a.central({ poll: { at: T + 10, error: 'Satori Service timed out (15 s)', unreachable: true }, submit: null }, 84);
  expect(a.rows().slice(1).map((r) => [r.at, r.level, r.data])).toEqual([
    [T + 1, 'ok', { streams: 83, new: 83, predicted: 83, sent: 83, accepted: 83, pending: 0 }],
    [T + 3, 'bad', { streams: 83, new: 1, predicted: 1, sent: 84, accepted: 0, pending: 84, error: 'central 401: Invalid signature', login: true }],
    [T + 5, 'bad', { streams: 0, new: 0, predicted: 0, sent: 0, accepted: 0, pending: 84, error: 'IO Error', local: true }],
    [T + 6, 'bad', { streams: 83, new: 0, predicted: 0, sent: 84, accepted: 0, pending: 84 }],
    // not reached at all (a network error, a timeout): Home says "Couldn't reach the Satori Service"
    [T + 8, 'bad', { streams: 83, new: 0, predicted: 0, sent: 84, accepted: 0, pending: 84, error: 'Satori Service unreachable: Failed to fetch', unreachable: true }],
    [T + 10, 'bad', { streams: 0, new: 0, predicted: 0, sent: 0, accepted: 0, pending: 84, error: 'Satori Service timed out (15 s)', unreachable: true }],
  ]);
});

describe('Base checks', () => {
  test('a batch sent; "already predicted" and "waiting" not logged; the same skip or error again merges (count, until)', async () => {
    const a = make();
    await a.start();
    await a.base({ at: T, round: 7, sent: { round: 7, at: T, hash: '0xab', games: [{ gameId: 1, streamId: 1, named: true, direction: 1, cadenceMinutes: 60 }], dropped: [{ gameId: 70, error: 'x' }] } });
    await a.base({ at: T + 1, round: 7, skipped: 'already predicted this round' });
    await a.base({ at: T + 2, round: 7, skipped: 'waiting for the batch already sent (0xab)' });
    clock = T + 86400;
    await a.base({ at: clock, round: 8, skipped: 'gas above the ceiling: a max fee of 3 gwei > 2 gwei; the next check tries again' });
    clock += 3600;
    await a.base({ at: clock, round: 8, skipped: 'gas above the ceiling: a max fee of 4 gwei > 2 gwei; the next check tries again' });
    await a.base({ at: clock, error: 'HTTP request failed' });
    clock += 3600;
    await a.base({ at: clock, error: 'HTTP request failed' });
    await a.base({ at: clock, round: 8, skipped: 'nothing staked with this app' });
    const base = a.rows().filter((r) => r.kind === 'base');
    expect(base.map((r) => [r.level, r.count, r.data])).toEqual([
      ['ok', 1, { round: 7, hash: '0xab', games: [1], dropped: [70],
        calls: [{ streamId: 1, named: true, direction: 'up', cadenceMinutes: 60, hour: Math.floor(T / 3600) }] }],
      ['warn', 2, { round: 8, skipped: 'gas above the ceiling: a max fee of 4 gwei > 2 gwei; the next check tries again' }],
      ['bad', 2, { round: null, error: 'HTTP request failed' }],
      ['idle', 1, { round: 8, skipped: 'nothing staked with this app' }],
    ]);
    expect(base[1]).toMatchObject({ at: T + 86400, until: T + 86400 + 3600 });
    expect(await db.activity(0)).toEqual(a.rows());
  });
  test('the contract unused: an RPC error is calm (idle) and marked, so the day strip leaves it out; a stuck batch is amber', async () => {
    const a = make();
    await a.start();
    await a.base({ at: T, error: 'HTTP request failed', unused: true });
    await a.base({ at: T, error: 'HTTP request failed', unused: true });
    await a.base({ at: T, round: 9, skipped: 'stuck: retrying with a higher fee (0.025 gwei)', stuck: { at: T, replaced: 1, fee: '0.025' }, pendingAt: T });
    const base = a.rows().filter((r) => r.kind === 'base');
    expect(base.map((r) => [r.level, r.count, r.data])).toEqual([
      ['idle', 2, { round: null, error: 'HTTP request failed', unused: true }],
      ['warn', 1, { round: 9, skipped: 'stuck: retrying with a higher fee (0.025 gwei)', stuck: { at: T, replaced: 1, fee: '0.025' } }],
    ]);
  });
});

test('Nostr: each _pred a relay took, merged per hour', async () => {
  const a = make();
  await a.start();
  clock = Math.ceil(T / 3600) * 3600 + 10;
  await a.published();
  await a.published();
  clock += 3600;
  await a.published();
  expect(a.rows().filter((r) => r.kind === 'nostr').map((r) => [r.data.published, r.count])).toEqual([[2, 2], [1, 1]]);
});

test('history (only a run that loaded or failed; a central without the route is not news), wallet actions, errors', async () => {
  const a = make();
  await a.start();
  await a.history({ at: T, streams: 83, rows: 83000, error: null });
  await a.history({ at: T, streams: 0, rows: 0, error: 'central 404: Not Found', retryAt: T + 86400 });
  await a.history({ at: T, streams: 3, rows: 30, left: 80, error: 'central unreachable: Failed to fetch' });
  await a.history(null);
  await a.wallet('stake', 'Staked with this app');
  await a.error('nostr', new Error('IO Error'));
  expect(a.rows().slice(1).map((r) => [r.kind, r.level, r.data])).toEqual([
    ['history', 'ok', { streams: 83, rows: 83000 }],
    ['history', 'warn', { streams: 3, rows: 30, error: 'central unreachable: Failed to fetch' }],
    ['wallet', 'ok', { action: 'stake', text: 'Staked with this app' }],
    ['error', 'bad', { where: 'nostr', message: 'IO Error' }],
  ]);
});

test("address changes (the Satori Service's, the Base RPC) and central's contract addresses that differ: rows of their own", async () => {
  const a = make();
  await a.start();
  await a.setting('central', 'https://other.example');
  await a.setting('rpc', '', 'https://sepolia.base.org');
  await a.configDiffers(['token'], 'https://central2.example');
  await a.configDiffers(['token'], 'https://central2.example'); // the same again: merged
  expect(a.rows().slice(1).map((r) => [r.kind, r.level, r.data, r.count])).toEqual([
    ['setting', 'idle', { what: 'central', to: 'https://other.example' }, 1],
    ['setting', 'idle', { what: 'rpc', to: '', default: 'https://sepolia.base.org' }, 1],
    ['config', 'warn', { url: 'https://central2.example', keys: ['token'] }, 2],
  ]);
});

test('kept 90 days: pruned at start and once a day', async () => {
  const old = await db.addActivity({ at: T - KEEP_S - 10, kind: 'central', level: 'ok', data: {} });
  await db.addActivity({ at: T - KEEP_S + 3600, kind: 'central', level: 'ok', data: {} }); // gone a day later
  const a = make();
  await a.start();
  expect((await db.activity(0)).map((r) => r.id)).not.toContain(old);
  clock = T + 86400 + 1;
  await a.beat(); // a wake: a new session, and the day's prune
  expect((await db.activity(0)).map((r) => r.at)).toEqual([T, T + 86400 + 1]);
  expect(kinds(a.rows())).toEqual(['open', 'open']);
});

test('first(): when the log\'s first session began, also one older than the rows health reads; this one in a new log', async () => {
  const a = make();
  expect(a.first()).toBe(null);
  await db.addActivity({ at: T - 50 * 86400, kind: 'open', level: 'ok', data: {}, until: T - 50 * 86400 + 600 });
  await a.start();
  expect(a.first()).toBe(T - 50 * 86400);
  expect(kinds(a.rows())).toEqual(['open']); // 50 days ago is not read: only this session
  await db.pruneActivity(T); // a new log
  const b = make();
  await b.start();
  expect(b.first()).toBe(T);
});

test('a write that fails is logged, never thrown', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const a = createActivity({ db: { ...db, addActivity: async () => { throw new Error('IO Error') } }, now });
  await a.start();
  await a.wallet('claim', 'x');
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
