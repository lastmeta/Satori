// The health rules (docs/design/health.md) on fabricated logs: every status,
// every reason and the action priority, open time and missed work, the day
// strip, the chips and the feed.
import { describe, expect, test } from 'vitest';
import {
  healthOf, missedBy, openTime, sessionsOf, isGood, daysOf, PRIORITY, WINDOW_S, FIRST_S, CADENCE_S, DAYS, fmtAgo, fmtIn, fmtDur,
} from './health.js';

const M = 60;
const H = 3600;
const D = 86400;
const NOW = new Date(2026, 9, 16, 15, 0, 0).getTime() / 1000; // 15:00 local
let id = 0;
const row = (kind, at, level, data, o = {}) => ({ id: ++id, kind, at, until: null, level, data, count: 1, mkey: null, ...o });
const open = (at, until = at, data = {}) => row('open', at, data.missed ? 'idle' : 'ok', { gap: null, missed: false, ...data }, { until });
const good = (at, accepted = 83, data = {}) => row('central', at, 'ok', { streams: 83, new: 83, predicted: accepted, sent: accepted, accepted, pending: 0, ...data });
const failed = (at, error = 'central 500: boom', data = {}) => row('central', at, 'bad', { streams: 83, new: 1, predicted: 1, sent: 83, accepted: 0, pending: 83, error, ...data });

const central = (o = {}) => ({ url: 'https://central2.satorinet.io', registration: { ok: true, peer_id: 7, vaultMismatch: false }, nextPoll: NOW + 9 * H,
  polling: false, pending: 0, ...o });
const base = (o = {}) => ({ config: 'bundled', error: '', round: 20742, identity: { eth: '0.1', power: '0', lowEth: false, batchesLeft: 100 },
  vault: { satori: '0', eth: '0', delegated: 'none' }, claimable: { rewards: '0', airdrop: '0' }, lastBatch: null, lastCheck: null, checking: false, ...o });
const delegated = (o = {}) => base({ identity: { eth: '0.1', power: '100', lowEth: false, batchesLeft: 100 }, vault: { satori: '100', eth: '0.1', delegated: 'identity' }, ...o });
const nostr = (o = {}) => ({ relays: [{ url: 'wss://a', state: 'open', write: true }, { url: 'wss://b', state: 'open', write: false }], subscriptions: [], ...o });
const sub = { uuid: 'r1', stream: 'x' };

/** A neuron open for the last 3 h whose last cycle was good, 2 h ago. */
const running = () => [open(NOW - 3 * H, NOW - 2 * M), good(NOW - 2 * H)];
const health = (o = {}) => healthOf({ now: NOW, rows: running(), central: central(), base: base(), nostr: nostr(),
  storage: { persisted: true }, app: { installed: false, canInstall: false }, backedUp: true, ...o });
const ids = (h) => h.reasons.map((r) => r.id);

describe('ok: predicting', () => {
  test('central took predictions within the window; Base not delegated with no SATORI; nothing subscribed', () => {
    const h = health();
    expect(h).toMatchObject({ status: 'ok', title: 'Predicting', line: 'Sent 83 predictions 2 h ago · next in 9 h', action: null, reasons: [] });
    expect(h.channels).toEqual({
      central: { state: 'ok', text: '83 sent 2 h ago' },
      base: { state: 'idle', text: 'Not delegated' },
      network: { state: 'idle', text: 'No streams' },
    });
  });
  test('delegated: this round sent, or its check not run yet; subscribed with every relay up (connecting counts)', () => {
    expect(health({ base: delegated({ lastBatch: { round: 20742, at: NOW - H, games: [{}] } }) }).channels.base)
      .toEqual({ state: 'ok', text: 'Round 20742 sent' });
    expect(health({ base: delegated() })).toMatchObject({ status: 'ok', channels: { base: { state: 'ok', text: 'Round 20742 due' } } });
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'connecting' }] });
    expect(health({ nostr: n })).toMatchObject({ status: 'ok', channels: { network: { state: 'ok', text: '2 relays' } } });
  });
  test('a poll with nothing to send is a good cycle', () => {
    expect(isGood(good(NOW, 0))).toBe(true);
    expect(isGood(failed(NOW))).toBe(false);
    expect(isGood(row('central', NOW, 'bad', { sent: 3, accepted: 0 }))).toBe(false); // central took none
    const h = health({ rows: [open(NOW - 3 * H), good(NOW - H, 0)] });
    expect(h).toMatchObject({ status: 'ok', line: 'Polled central 1 h ago, nothing new · next in 9 h' });
  });
});

describe('idle: calm, never red for being closed', () => {
  test('starting: a new neuron before its first good cycle', () => {
    const h = health({ rows: [open(NOW - 10 * M)], central: central({ nextPoll: NOW + 12 * M }) });
    expect(h).toMatchObject({ status: 'idle', title: 'Starting', line: 'First predictions in 12 min.', action: null });
    expect(h.channels.central).toEqual({ state: 'idle', text: 'First poll in 12 min' });
    expect(health({ rows: [open(NOW - 10 * M)], central: central({ polling: true }) }).line).toBe('First predictions now…');
  });

  test('asleep: closed while a poll came due; catching up, then caught up until the next normal cycle', () => {
    const before = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H)];
    const woke = open(NOW - 10 * M, NOW - M, { gap: 3 * D - 2 * H - 10 * M, missed: true });
    let h = health({ rows: [...before, woke], central: central({ nextPoll: NOW + 12 * M }) });
    expect(h).toMatchObject({ status: 'idle', title: 'Was asleep', line: 'Closed for 3 days. Catching up in 12 min.', action: null });
    expect(h.channels.central).toEqual({ state: 'idle', text: 'Catching up in 12 min' });
    // it never counts the closed time: three days closed is not overdue
    expect(ids(h)).toEqual(['asleep']);

    h = health({ rows: [...before, woke], app: { installed: false, canInstall: true } });
    expect(h.action).toEqual({ id: 'asleep', text: 'The neuron only runs while Satori is open. Install it so it stays open in its own window.',
      button: 'Install', do: 'install' });

    const caught = good(NOW - 20, 83, { caughtUp: woke.data.gap });
    h = health({ rows: [...before, woke, caught] });
    expect(h).toMatchObject({ status: 'idle', title: 'Was asleep', line: 'Closed for 3 days. Caught up just now.' });
    expect(h.channels.central).toEqual({ state: 'ok', text: '83 sent just now' });

    // a reload after catching up keeps it; the next normal cycle ends it
    const reload = open(NOW - 30 * M + 2 * H, NOW + 2 * H, { gap: 5 });
    expect(health({ now: NOW + 2 * H, rows: [...before, woke, caught, reload] }).status).toBe('idle');
    const later = NOW + 11 * H;
    expect(health({ now: later, rows: [...before, woke, caught, { ...reload, until: later }, good(later - M)] }).status).toBe('ok');
  });

  test('missedBy: a poll came due outside every session; open time counts only while open', () => {
    const rows = [open(1000, 1000 + 2 * H), good(1000 + H)];
    const due = 1000 + H + CADENCE_S;
    expect(missedBy(rows, due + 60)).toEqual({ missed: true, gap: due + 60 - (1000 + 2 * H) });
    expect(missedBy(rows, due - 60)).toEqual({ missed: false, gap: due - 60 - (1000 + 2 * H) });
    const stayedOpen = [open(1000, due + 10), good(1000 + H)];
    expect(missedBy(stayedOpen, due + 20).missed).toBe(false); // it was running when the poll came due
    expect(missedBy([open(1000, 2000)], 1e6)).toEqual({ missed: false, gap: 1e6 - 2000 }); // never a good cycle: starting, not asleep
    expect(missedBy([], 5)).toEqual({ missed: false, gap: null });

    const sessions = sessionsOf([open(0, 100), open(1000, 1100), open(5000, 5000)], 6000);
    expect(sessions).toEqual([{ at: 0, until: 100 }, { at: 1000, until: 1100 }, { at: 5000, until: 6000 }]); // the last runs to now
    expect(openTime(sessions, 50, 6000)).toBe(50 + 100 + 1000);
  });
});

describe('bad: predictions are failing', () => {
  test('overdue: no good cycle within the window of open time (and the first within FIRST_S)', () => {
    const rows = [open(NOW - 14 * H, NOW - M), good(NOW - 13 * H)];
    const h = health({ rows });
    expect(h).toMatchObject({ status: 'bad', title: 'Not predicting', line: 'Nothing sent for 13 h.' });
    expect(h.action).toMatchObject({ id: 'central-overdue', button: 'Poll now', do: 'poll' });
    expect(h.channels.central).toEqual({ state: 'bad', text: 'Nothing sent for 13 h' });
    expect(WINDOW_S).toBe(12.5 * H);
    // the same 13 h with 4 of them closed is fine
    expect(health({ rows: [open(NOW - 14 * H, NOW - 10 * H), good(NOW - 13 * H), open(NOW - 6 * H, NOW)] }).status).toBe('ok');
    expect(health({ rows: [open(NOW - FIRST_S - M)] }).reasons[0].id).toBe('central-overdue');
  });

  test('a failed cycle: once is warn (retrying), twice in a row is bad', () => {
    let h = health({ rows: [...running(), failed(NOW - H)] });
    expect(h).toMatchObject({ status: 'warn', title: 'Retrying', line: 'The last poll failed; next try in 9 h.' });
    expect(h.action).toEqual({ id: 'central-failed', text: 'central 500: boom. It tries again on its own; try now if something was fixed.',
      button: 'Try again', do: 'poll' });
    expect(h.channels.central).toEqual({ state: 'warn', text: 'Last poll failed' });
    h = health({ rows: [open(NOW - 12 * H), good(NOW - 11.5 * H), failed(NOW - 6 * H), failed(NOW - H)] });
    expect(h).toMatchObject({ status: 'bad', title: 'Not predicting', line: 'Central refused the last 2 batches.' });
    expect(h.channels.central).toEqual({ state: 'bad', text: '2 failed in a row' });
    const polls = [open(NOW - 12 * H), good(NOW - 11.5 * H), failed(NOW - 6 * H, 'central unreachable: Failed to fetch', { sent: 0 }),
      failed(NOW - H, 'central unreachable: Failed to fetch', { sent: 0 })];
    expect(health({ rows: polls }).line).toBe('The last 2 polls failed.');
  });

  test('login refused: bad at once', () => {
    const h = health({ rows: [...running(), failed(NOW - H, 'central 401: Invalid signature', { login: true })] });
    expect(h).toMatchObject({ status: 'bad', title: 'Not predicting', line: "Central refused this neuron's login." });
    expect(h.action).toEqual({ id: 'login-refused', text: "Central rejects this neuron's login. Check the central address in Settings.",
      button: 'Open Settings', do: 'go', tab: 'settings', section: 'central' });
    expect(h.channels.central).toEqual({ state: 'bad', text: 'Login refused' });
  });

  test('a database or engine failure in the cycle', () => {
    const h = health({ rows: [...running(), failed(NOW - M, 'IO Error: Could not write file', { local: true, sent: 0 })] });
    expect(h).toMatchObject({ status: 'bad', line: 'The database failed.', channels: { central: { state: 'bad', text: 'Database error' } } });
    expect(h.action).toMatchObject({ id: 'db-error', button: 'Reload', do: 'reload' });
  });

  test("Base failing: delegated, the check's same error twice in a row", () => {
    const err = row('base', NOW - 2 * H, 'bad', { round: 20742, error: 'HTTP request failed' }, { count: 2, until: NOW - H, mkey: 'e' });
    const h = health({ rows: [...running(), err], base: delegated({ lastCheck: { at: NOW - H, error: 'HTTP request failed' } }) });
    expect(h).toMatchObject({ status: 'bad', title: 'Base is failing', line: 'Central is fine. The Base batch failed 2 times.' });
    expect(h.action).toMatchObject({ id: 'base-failing', do: 'go', tab: 'settings', section: 'base' });
    expect(h.channels.base).toEqual({ state: 'bad', text: 'Failed 2 times' });
  });

  test('every relay down with a stream subscribed', () => {
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'closed' }, { url: 'ws://b', state: 'blocked' }] });
    const h = health({ nostr: n });
    expect(h).toMatchObject({ status: 'bad', title: 'Network is down', line: 'Central is fine. Every relay is down.' });
    expect(h.channels.network).toEqual({ state: 'bad', text: 'Relays down' });
    expect(health({ nostr: nostr({ subscriptions: [sub], relays: [] }) }).channels.network.state).toBe('bad');
    expect(health({ nostr: nostr({ relays: [{ url: 'wss://a', state: 'closed' }] }) }).status).toBe('ok'); // nothing subscribed
  });
});

describe('warn: predicting, but something needs you', () => {
  test('not delegated while the vault holds SATORI', () => {
    const h = health({ base: base({ vault: { satori: '100', delegated: 'none' } }) });
    expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'Central is fine. Base needs one step from you.' });
    expect(h.action).toEqual({ id: 'delegate', text: 'Base predictions are off. Delegate your vault’s prediction power to this neuron.',
      button: 'Delegate', do: 'delegate' });
    expect(h.channels.base).toEqual({ state: 'warn', text: 'Not delegated' });
  });
  test("the identity's gas runs low", () => {
    const h = health({ base: delegated({ identity: { power: '100', lowEth: true, batchesLeft: 3, eth: '0.00001' } }) });
    expect(h.action).toMatchObject({ id: 'gas-low', text: 'The identity has gas for about 3 daily batches. Send it a little Base ETH.',
      button: 'Add gas', do: 'go', tab: 'wallet' });
    expect(h.channels.base).toEqual({ state: 'warn', text: 'Gas: 3 batches' });
  });
  test("this round's batch skipped for a fixable reason; other skips are calm", () => {
    const check = { at: NOW, round: 20742, skipped: 'gas above the ceiling: a max fee of 3 gwei > 2 gwei; the next check tries again' };
    const h = health({ base: delegated({ lastCheck: check }) });
    expect(h).toMatchObject({ status: 'warn', line: 'Central is fine. The Base batch was skipped.' });
    expect(h.action).toMatchObject({ id: 'base-skipped', do: 'go', tab: 'settings', section: 'base' });
    expect(h.channels.base).toEqual({ state: 'warn', text: 'Skipped: gas above the ceiling' });
    const sim = health({ base: delegated({ lastCheck: { at: NOW, round: 20742, skipped: 'no game passes its simulation' } }) });
    expect(sim.action).toMatchObject({ id: 'base-skipped', tab: 'wallet' });
    expect(health({ base: delegated({ lastCheck: { round: 20742, skipped: 'no streams with a game' } }) }).status).toBe('ok');
    expect(health({ base: delegated({ lastCheck: { round: 20741, skipped: 'no game passes its simulation' } }) }).status).toBe('ok'); // last round's
  });
  test("Base unreachable (once, or never used): warn", () => {
    const h = health({ base: base({ error: 'HTTP request failed', config: null }) });
    expect(h).toMatchObject({ status: 'warn', line: "Central is fine. Can't reach Base." });
    expect(h.channels.base).toEqual({ state: 'warn', text: 'Unreachable' });
    expect(health({ base: base({ config: null }) }).channels.base).toEqual({ state: 'idle', text: 'Connecting…' });
  });
  test('a relay down', () => {
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'closed' }] });
    const h = health({ nostr: n });
    expect(h).toMatchObject({ status: 'warn', line: 'Central is fine. 1 of 2 relays down.' });
    expect(h.action).toMatchObject({ id: 'relay-down', do: 'go', tab: 'settings', section: 'relays' });
    expect(h.channels.network).toEqual({ state: 'warn', text: '1 of 2 relays down' });
  });
  test('storage not kept and no backup confirmed', () => {
    const h = health({ storage: { persisted: false }, backedUp: false });
    expect(h).toMatchObject({ status: 'warn', line: 'Central is fine. Back up your keys.' });
    expect(h.action).toEqual({ id: 'backup', text: 'This browser may clear Satori’s storage, your keys with it. Back up your vault’s 24 words.',
      button: 'Back up', do: 'backup' });
    expect(health({ storage: { persisted: false }, backedUp: true }).status).toBe('ok');
    expect(health({ storage: { persisted: true }, backedUp: false }).status).toBe('ok');
    expect(health({ storage: null, backedUp: false }).status).toBe('ok'); // not read yet
  });
  test('central: a vault mismatch; not registered', () => {
    let h = health({ central: central({ registration: { ok: true, vaultMismatch: 'other' } }) });
    expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'Central has another vault for this neuron.' });
    expect(h.channels.central).toEqual({ state: 'warn', text: 'Vault mismatch' });
    h = health({ central: central({ registration: { ok: false, error: 'central unreachable: Failed to fetch' } }) });
    expect(h.action).toMatchObject({ id: 'not-registered', do: 'reload' });
    expect(h.channels.central).toEqual({ state: 'warn', text: 'Not registered' });
  });
});

test('the action priority: the worst status; one card, the highest reason that has an action', () => {
  expect(PRIORITY).toEqual(['db-error', 'login-refused', 'central-failing', 'central-overdue', 'base-failing', 'relays-down',
    'central-failed', 'backup', 'vault-mismatch', 'not-registered', 'delegate', 'gas-low', 'base-skipped', 'base-unreachable',
    'relay-down', 'asleep', 'starting']);
  const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'closed' }] });
  const many = { nostr: n, storage: { persisted: false }, backedUp: false, base: base({ vault: { satori: '5', delegated: 'none' } }),
    central: central({ registration: { ok: true, vaultMismatch: 'none' } }) };
  let h = health(many);
  expect(ids(h)).toEqual(['backup', 'vault-mismatch', 'delegate', 'relay-down']);
  expect([h.status, h.action.id]).toEqual(['warn', 'backup']);
  h = health({ ...many, rows: [...running(), failed(NOW - H, 'central 401: Invalid signature', { login: true })] });
  expect([h.status, h.action.id, h.title]).toEqual(['bad', 'login-refused', 'Not predicting']);
  // asleep with no install offered and a warn below it: the warn's card
  const rows = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H), open(NOW - 10 * M, NOW, { gap: 3 * D, missed: true })];
  h = health({ rows, base: base({ vault: { satori: '5', delegated: 'none' } }) });
  expect([h.status, h.title, h.action.id]).toEqual(['warn', 'Was asleep', 'delegate']);
  expect(h.line).toBe('Base needs one step from you.'); // central is not "fine" while it catches up
});

describe('the day strip: local days', () => {
  const day = (k, hour = 12) => new Date(2026, 9, 16 - k, hour, 0, 0).getTime() / 1000; // k days ago, local
  test('full, part, error, closed (never ran, or ran with nothing due), before; today outlined; 30 days, oldest first', () => {
    const rows = [
      open(day(5, 8), day(5, 20)), good(day(5, 9)), row('base', day(5, 10), 'ok', { round: 1, games: [{}] }), // full
      open(day(4, 8), day(4, 20)), good(day(4, 9)), row('base', day(4, 10), 'bad', { error: 'x' }), // part: Base failed
      open(day(3, 8), day(3, 20)), failed(day(3, 9)), // error
      open(day(2, 8), day(2, 9)), // ran, nothing due
      // day 1: closed
      open(day(0, 8), NOW), failed(day(0, 9)), good(day(0, 14)), row('nostr', day(0, 14), 'ok', { published: 3 }), // full: central recovered
    ];
    const days = daysOf(rows, NOW);
    expect(days).toHaveLength(DAYS);
    expect(days.at(-1)).toMatchObject({ code: 'full', ran: true, today: true, date: '2026-10-16' });
    expect(days.slice(-6).map((d) => [d.date, d.code, d.ran])).toEqual([
      ['2026-10-11', 'full', true], ['2026-10-12', 'part', true], ['2026-10-13', 'error', true], ['2026-10-14', 'closed', true],
      ['2026-10-15', 'closed', false], ['2026-10-16', 'full', true]]);
    expect(days.filter((d) => d.today)).toHaveLength(1);
    expect(days[0]).toMatchObject({ date: '2026-09-17', code: 'before', ran: false }); // before the first session
  });
  test('before: the days before the neuron began (its first session, or `since` when earlier) are not closed days', () => {
    const fresh = [open(day(0, 8), NOW), good(day(0, 9))];
    const days = daysOf(fresh, NOW);
    expect(days.slice(0, -1).every((d) => d.code === 'before' && !d.ran)).toBe(true);
    expect(days.at(-1)).toMatchObject({ code: 'full', ran: true, today: true });
    // since: the keys made 3 days ago at 22:00, or the log's first session older than the rows read
    expect(daysOf(fresh, NOW, day(3, 22)).slice(-5).map((d) => d.code)).toEqual(['before', 'closed', 'closed', 'closed', 'full']);
    expect(daysOf(fresh, NOW, NOW + H).slice(-2).map((d) => d.code)).toEqual(['before', 'full']); // a later one changes nothing
    expect(daysOf([], NOW).every((d) => d.code === 'closed')).toBe(true); // nothing known: nothing before
    expect(health({ rows: fresh, since: day(1, 23) }).days.slice(-3).map((d) => d.code)).toEqual(['before', 'closed', 'full']);
  });
  test('a merged failure counts on every day it spans; a skip that is not a failure counts on none', () => {
    const rows = [open(day(2, 1), NOW), good(day(2, 2)), good(day(1, 2)), good(day(0, 2)),
      row('base', day(2, 3), 'bad', { error: 'x' }, { until: day(1, 3), count: 20 }),
      row('base', day(2, 3), 'idle', { skipped: 'no prediction power delegated to the identity' }, { until: day(0, 3), count: 30 })];
    expect(daysOf(rows, NOW).slice(-3).map((d) => d.code)).toEqual(['part', 'part', 'full']);
  });
});

test('the feed: newest first, 20 rows; sessions shown only when they missed work; merged rows counted', () => {
  const rows = [
    open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H),
    row('base', NOW - 3 * D + H, 'ok', { round: 20739, hash: '0xab', games: [{}, {}], dropped: [] }),
    open(NOW - 2 * H, NOW, { gap: 3 * D - 4 * H, missed: true }),
    row('history', NOW - 2 * H + 30, 'ok', { streams: 83, rows: 83000 }),
    good(NOW - H, 83, { caughtUp: 3 * D - 4 * H }),
    row('base', NOW - 50 * M, 'warn', { round: 20742, skipped: 'gas above the ceiling: a max fee of 3 gwei > 2 gwei; the next check tries again' },
      { count: 3, until: NOW - 10 * M }),
    row('nostr', NOW - 40 * M, 'ok', { published: 3 }),
    row('wallet', NOW - 30 * M, 'ok', { action: 'delegate', text: 'Delegated to this neuron' }),
    failed(NOW - 20 * M, 'central 401: Invalid signature', { login: true }),
    row('error', NOW - 10 * M, 'bad', { where: 'nostr', message: 'IO Error' }),
    open(NOW - 5 * M, NOW, { gap: 30 }),
  ];
  const { feed } = health({ rows });
  expect(feed.map((f) => [f.level, f.text])).toEqual([
    ['bad', 'A network forecast failed: IO Error'],
    ['bad', 'Central refused the login: central 401: Invalid signature'],
    ['ok', 'Delegated to this neuron'],
    ['ok', 'Published 3 forecasts to the network'],
    ['warn', 'Base batch skipped: gas above the ceiling (×3)'],
    ['ok', 'Caught up: sent 83 predictions'],
    ['ok', 'History loaded for 83 streams'],
    ['idle', 'Satori was closed for 3 d'],
    ['ok', 'Base batch for round 20739: 2 games'],
    ['ok', 'Sent 83 predictions to central'],
  ]);
  expect(feed[0]).toEqual({ at: NOW - 10 * M, level: 'bad', text: 'A network forecast failed: IO Error' });
  const busy = Array.from({ length: 30 }, (_, i) => good(NOW - (30 - i) * H));
  expect(health({ rows: busy }).feed).toHaveLength(20);
});

test('times in a few words', () => {
  expect([fmtAgo(20), fmtAgo(5 * M), fmtAgo(2 * H + 10 * M), fmtAgo(3 * D)]).toEqual(['just now', '5 min ago', '2 h ago', '3 d ago']);
  expect([fmtIn(-5), fmtIn(30), fmtIn(12 * M), fmtIn(9 * H - 1)]).toEqual(['now', 'in 1 min', 'in 12 min', 'in 9 h']);
  expect([fmtDur(45 * M), fmtDur(13 * H), fmtDur(D + 2 * H), fmtDur(3 * D - 4 * H)]).toEqual(['45 min', '13 h', '1 day', '3 days']);
  expect(fmtDur(3 * D - 4 * H, true)).toBe('3 d');
});

test('the feed is by time: a cycle logged when it ends sits at its start, after what happened meanwhile', () => {
  const rows = [open(NOW - H), row('base', NOW - 50 * M, 'idle', { skipped: 'no streams with a game' }), good(NOW - 55 * M)];
  expect(health({ rows }).feed.map((f) => f.text)).toEqual(['Base batch skipped: no streams with a game', 'Sent 83 predictions to central']);
});
