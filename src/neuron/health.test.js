// The health rules (docs/design/health.md) on fabricated logs: every status,
// every reason and the action priority, open time and missed work, the day
// strip, the chips and the feed.
import { describe, expect, test } from 'vitest';
import {
  healthOf, toneOf, missedBy, openTime, sessionsOf, isGood, daysOf, PRIORITY, WINDOW_S, FIRST_S, CADENCE_S, DAYS, fmtAgo, fmtIn, fmtDur,
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
      central: { state: 'ok', tone: 'idle', text: '83 sent 2 h ago' },
      base: { state: 'idle', tone: 'off', text: 'Not delegated' },
      network: { state: 'idle', tone: 'off', text: 'No streams' },
    });
    expect([h.tone, h.work]).toEqual(['idle', null]); // all good, nothing in progress: sky green
  });
  test('delegated: this round sent, or its check not run yet; subscribed with every relay up (connecting counts)', () => {
    expect(health({ base: delegated({ lastBatch: { round: 20742, at: NOW - H, games: [{}] } }) }).channels.base)
      .toEqual({ state: 'ok', tone: 'idle', text: 'Round 20742 sent' });
    expect(health({ base: delegated() })).toMatchObject({ status: 'ok', channels: { base: { state: 'ok', text: 'Round 20742 due' } } });
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'connecting' }] });
    expect(health({ nostr: n })).toMatchObject({ status: 'ok', channels: { network: { state: 'ok', text: '2 relays' } } });
  });
  test('a poll with nothing to send is a good cycle: up to date, never "0 sent" (the chip, the line, the feed)', () => {
    expect(isGood(good(NOW, 0))).toBe(true);
    expect(isGood(failed(NOW))).toBe(false);
    expect(isGood(row('central', NOW, 'bad', { sent: 3, accepted: 0 }))).toBe(false); // central took none
    const h = health({ rows: [open(NOW - 3 * H), good(NOW - 2 * H), good(NOW - H, 0)] });
    expect(h).toMatchObject({ status: 'ok', title: 'Predicting', line: 'Up to date · next in 9 h' });
    expect(h.channels.central).toEqual({ state: 'ok', tone: 'idle', text: 'Up to date · next in 9 h' });
    expect(h.feed.map((f) => f.text)).toEqual(['Polled central: up to date', 'Sent 83 predictions to central']);
    const polling = health({ rows: [open(NOW - 3 * H), good(NOW - H, 0)], central: central({ polling: true }) });
    expect([polling.line, polling.channels.central.text]).toEqual(['Up to date · next now…', 'Up to date · next now…']);
    // caught up after being asleep, with nothing to send
    const slept = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H), open(NOW - 10 * M, NOW, { gap: 3 * D, missed: true })];
    const caught = health({ rows: [...slept, good(NOW - 5 * M, 0, { caughtUp: 3 * D })] });
    expect(caught.feed[0].text).toBe('Caught up: up to date');
    expect(caught.channels.central.text).toBe('Up to date · next in 9 h');
    for (const x of [h, polling, caught]) expect(JSON.stringify(x)).not.toMatch(/\b0 (sent|predictions)|sent 0|nothing new/);
  });
});

describe('idle: calm, never red for being closed', () => {
  test('starting: a new neuron before its first good cycle, getting its first predictions at once', () => {
    for (const c of [central({ polling: true }), central({ nextPoll: NOW }), central({ nextPoll: null })]) { // polling, due, not armed yet
      const h = health({ rows: [open(NOW - M)], central: c });
      expect(h).toMatchObject({ status: 'idle', title: 'Starting', line: 'Getting its first predictions…', action: null });
      expect(h.channels.central).toEqual({ state: 'idle', tone: 'idle', text: 'First poll now…' });
    }
    // a stored time still ahead (none for a new neuron): says when
    expect(health({ rows: [open(NOW - 10 * M)], central: central({ nextPoll: NOW + 12 * M }) }).line).toBe('First predictions in 12 min.');
  });

  test('asleep: closed while a poll came due; catching up, then caught up until the next normal cycle', () => {
    const before = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H)];
    const woke = open(NOW - 10 * M, NOW - M, { gap: 3 * D - 2 * H - 10 * M, missed: true });
    let h = health({ rows: [...before, woke], central: central({ polling: true }) }); // the overdue poll runs at once
    expect(h).toMatchObject({ status: 'idle', title: 'Was asleep', line: 'Closed for 3 days. Catching up now…', action: null });
    expect(h.channels.central).toEqual({ state: 'idle', tone: 'idle', text: 'Catching up now…' });
    expect(health({ rows: [...before, woke], central: central({ nextPoll: NOW + 12 * M }) }).line).toBe('Closed for 3 days. Catching up in 12 min.');
    // it never counts the closed time: three days closed is not overdue
    expect(ids(h)).toEqual(['asleep']);

    h = health({ rows: [...before, woke], app: { installed: false, canInstall: true } });
    expect(h.action).toEqual({ id: 'asleep', text: 'The neuron only runs while Satori is open. Install it so it stays open in its own window.',
      button: 'Install', do: 'install' });

    const caught = good(NOW - 20, 83, { caughtUp: woke.data.gap });
    h = health({ rows: [...before, woke, caught] });
    expect(h).toMatchObject({ status: 'idle', title: 'Predicting', line: 'Closed for 3 days. Caught up just now.' }); // caught up: predicting
    expect(h.channels.central).toEqual({ state: 'ok', tone: 'idle', text: '83 sent just now' });

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
    expect(h.channels.central).toEqual({ state: 'bad', tone: 'bad', text: 'Nothing sent for 13 h' });
    expect([WINDOW_S, FIRST_S]).toEqual([12 * H, H]); // 11 h + 1 h of grace; the first poll is at once, + 1 h
    // the same 13 h with 4 of them closed is fine
    expect(health({ rows: [open(NOW - 14 * H, NOW - 10 * H), good(NOW - 13 * H), open(NOW - 6 * H, NOW)] }).status).toBe('ok');
    expect(health({ rows: [open(NOW - FIRST_S - M)] }).reasons[0].id).toBe('central-overdue');
  });

  test('a failed cycle: once is warn (retrying, still predicting), twice in a row is bad', () => {
    let h = health({ rows: [...running(), failed(NOW - H)] });
    expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'The last poll failed; next try in 9 h.' });
    expect(h.action).toEqual({ id: 'central-failed', text: 'central 500: boom. It tries again on its own; try now if something was fixed.',
      button: 'Try again', do: 'poll' });
    expect(h.channels.central).toEqual({ state: 'warn', tone: 'warn', text: 'Last poll failed' });
    h = health({ rows: [open(NOW - 12 * H), good(NOW - 11.5 * H), failed(NOW - 6 * H), failed(NOW - H)] });
    expect(h).toMatchObject({ status: 'bad', title: 'Not predicting', line: 'Central refused the last 2 batches.' });
    expect(h.channels.central).toEqual({ state: 'bad', tone: 'bad', text: '2 failed in a row' });
    const polls = [open(NOW - 12 * H), good(NOW - 11.5 * H), failed(NOW - 6 * H, 'central unreachable: Failed to fetch', { sent: 0 }),
      failed(NOW - H, 'central unreachable: Failed to fetch', { sent: 0 })];
    expect(health({ rows: polls }).line).toBe('The last 2 polls failed.');
  });

  test('login refused: bad at once', () => {
    const h = health({ rows: [...running(), failed(NOW - H, 'central 401: Invalid signature', { login: true })] });
    expect(h).toMatchObject({ status: 'bad', title: 'Not predicting', line: "Central refused this neuron's login." });
    expect(h.action).toEqual({ id: 'login-refused', text: "Central rejects this neuron's login. Check the central address in Settings.",
      button: 'Open Settings', do: 'go', tab: 'settings', section: 'central' });
    expect(h.channels.central).toEqual({ state: 'bad', tone: 'bad', text: 'Login refused' });
  });

  test('a database or engine failure in the cycle', () => {
    const h = health({ rows: [...running(), failed(NOW - M, 'IO Error: Could not write file', { local: true, sent: 0 })] });
    expect(h).toMatchObject({ status: 'bad', line: 'The database failed.', channels: { central: { state: 'bad', text: 'Database error' } } });
    expect(h.action).toMatchObject({ id: 'db-error', button: 'Reload', do: 'reload' });
  });

  test("Base failing: delegated, the check's same error twice in a row", () => {
    const err = row('base', NOW - 2 * H, 'bad', { round: 20742, error: 'HTTP request failed' }, { count: 2, until: NOW - H, mkey: 'e' });
    const h = health({ rows: [...running(), err], base: delegated({ lastCheck: { at: NOW - H, error: 'HTTP request failed' } }) });
    expect(h).toMatchObject({ status: 'bad', title: 'Partly predicting', line: 'Central is fine. The Base batch failed 2 times.' });
    expect(h.action).toMatchObject({ id: 'base-failing', do: 'go', tab: 'settings', section: 'base' });
    expect(h.channels.base).toEqual({ state: 'bad', tone: 'bad', text: 'Failed 2 times' });
  });

  test('every relay down with a stream subscribed', () => {
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'closed' }, { url: 'ws://b', state: 'blocked' }] });
    const h = health({ nostr: n });
    expect(h).toMatchObject({ status: 'bad', title: 'Predicting', line: 'Central is fine. Every relay is down.' });
    expect(h.channels.network).toEqual({ state: 'bad', tone: 'bad', text: 'Relays down' });
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
    expect(h.channels.base).toEqual({ state: 'warn', tone: 'warn', text: 'Not delegated' });
  });
  test("the identity's gas runs low", () => {
    const h = health({ base: delegated({ identity: { power: '100', lowEth: true, batchesLeft: 3, eth: '0.00001' } }) });
    expect(h.action).toMatchObject({ id: 'gas-low', text: 'The identity has gas for about 3 daily batches. Send it a little Base ETH.',
      button: 'Add gas', do: 'go', tab: 'wallet' });
    expect(h.channels.base).toEqual({ state: 'warn', tone: 'warn', text: 'Gas: 3 batches' });
  });
  test("this round's batch skipped for a fixable reason; other skips are calm", () => {
    const check = { at: NOW, round: 20742, skipped: 'gas above the ceiling: a max fee of 3 gwei > 2 gwei; the next check tries again' };
    const h = health({ base: delegated({ lastCheck: check }) });
    expect(h).toMatchObject({ status: 'warn', line: 'Central is fine. The Base batch was skipped.' });
    expect(h.action).toMatchObject({ id: 'base-skipped', do: 'go', tab: 'settings', section: 'base' });
    expect(h.channels.base).toEqual({ state: 'warn', tone: 'warn', text: 'Skipped: gas above the ceiling' });
    const sim = health({ base: delegated({ lastCheck: { at: NOW, round: 20742, skipped: 'no game passes its simulation' } }) });
    expect(sim.action).toMatchObject({ id: 'base-skipped', tab: 'wallet' });
    expect(health({ base: delegated({ lastCheck: { round: 20742, skipped: 'no streams with a game' } }) }).status).toBe('ok');
    expect(health({ base: delegated({ lastCheck: { round: 20741, skipped: 'no game passes its simulation' } }) }).status).toBe('ok'); // last round's
  });
  test("Base unreachable (once, or never used): warn", () => {
    const h = health({ base: base({ error: 'HTTP request failed', config: null }) });
    expect(h).toMatchObject({ status: 'warn', line: "Central is fine. Can't reach Base." });
    expect(h.channels.base).toEqual({ state: 'warn', tone: 'warn', text: 'Unreachable' });
    expect(health({ base: base({ config: null }) }).channels.base).toEqual({ state: 'idle', tone: 'working', text: 'Connecting…' });
  });
  test('a relay down', () => {
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'closed' }] });
    const h = health({ nostr: n });
    expect(h).toMatchObject({ status: 'warn', line: 'Central is fine. 1 of 2 relays down.' });
    expect(h.action).toMatchObject({ id: 'relay-down', do: 'go', tab: 'settings', section: 'relays' });
    expect(h.channels.network).toEqual({ state: 'warn', tone: 'warn', text: '1 of 2 relays down' });
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
  test("central: a vault mismatch, by register's vault_base_address; unknown is none; not registered", () => {
    const [ours, theirs] = ['0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7', '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'];
    const reg = (vault_base_address, vaultMismatch) => central({ registration: { ok: true, peer_id: 7, vault: ours, vault_base_address, vaultMismatch } });
    let h = health({ central: reg(theirs, 'other') });
    expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: "Central pays this vault's rewards to another address." });
    expect(h.action).toEqual({ id: 'vault-mismatch', do: 'go', tab: 'settings', section: 'keys', button: 'Open Settings',
      text: `Central pays this vault's rewards to a different Base address, ${theirs}, not this vault's ${ours}. Check the keys in Settings.` });
    expect(h.channels.central).toEqual({ state: 'warn', tone: 'warn', text: 'Vault mismatch' });
    h = health({ central: reg(null, 'none') });
    expect(h).toMatchObject({ status: 'warn', line: 'Central has no vault for this neuron.' });
    expect(h.action).toMatchObject({ id: 'vault-mismatch', text: "Central kept no vault for this identity, so it has no Base address to pay this "
      + "neuron's rewards to (the vault may be registered to another neuron). Check the keys in Settings." });
    // a match, or a central that does not say (no vault_base_address: prod on main): no reason
    for (const r of [reg(ours, false), reg(null, null)]) {
      h = health({ central: r });
      expect([h.status, ids(h), h.channels.central.state]).toEqual(['ok', [], 'ok']);
    }
    h = health({ central: central({ registration: { ok: false, error: 'central unreachable: Failed to fetch' } }) });
    expect(h.action).toMatchObject({ id: 'not-registered', do: 'reload' });
    expect(h.channels.central).toEqual({ state: 'warn', tone: 'warn', text: 'Not registered' });
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

test("each channel's last traffic (ms) for agents, when given: null before any", () => {
  const h = health({ traffic: { central: 1_792_250_000_000, base: null, network: null } });
  expect([h.channels.central.lastTraffic, h.channels.base.lastTraffic, h.channels.network.lastTraffic]).toEqual([1_792_250_000_000, null, null]);
  expect(health().channels.central).not.toHaveProperty('lastTraffic'); // not given
});

describe("the title: is my neuron predicting, on the channels that pay (central, and Base when delegated), whichever reason leads", () => {
  const [ours, theirs] = ['0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7', '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'];
  const mismatch = { ok: true, peer_id: 7, vault: ours, vault_base_address: theirs, vaultMismatch: 'other' };

  test('partly predicting: central predicts, but Base, a paying channel that should be predicting, is red', () => {
    const err = row('base', NOW - 2 * H, 'bad', { round: 20742, error: 'HTTP request failed' }, { count: 2, until: NOW - H, mkey: 'e' });
    const check = { lastCheck: { at: NOW - H, error: 'HTTP request failed' } };
    const failing = (b, rows = running()) => health({ rows: [...rows, err], base: b });
    // the bug: red, and the title said Predicting
    expect(failing(delegated(check))).toMatchObject({ status: 'bad', title: 'Partly predicting', line: 'Central is fine. The Base batch failed 2 times.',
      action: { id: 'base-failing' }, channels: { central: { state: 'ok' }, base: { state: 'bad' } } });
    // its RPC down since this page loaded: the delegation is not read, and a batch went out before: still Base's job
    const unread = base({ ...check, error: 'HTTP request failed', lastBatch: { round: 20741 }, vault: { satori: null, eth: null, delegated: null } });
    expect(failing(unread).title).toBe('Partly predicting');
    // not delegated (any more): Base should not be predicting, so the title is central's
    expect(failing(base({ ...check, lastBatch: { round: 20741 } }))).toMatchObject({ status: 'bad', title: 'Predicting' });
    // central's last poll failed once: still predicting, so partly
    expect(failing(delegated(check), [...running(), failed(NOW - 30 * M)])).toMatchObject({ status: 'bad', title: 'Partly predicting' });
    // central failing wins; a new neuron with no good cycle yet is starting; Nostr never moves the title
    expect(failing(delegated(check), [open(NOW - 12 * H), good(NOW - 11.5 * H), failed(NOW - 6 * H), failed(NOW - H)]).title).toBe('Not predicting');
    expect(failing(delegated(check), [open(NOW - 10 * M)]).title).toBe('Starting');
    const down = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'closed' }] });
    expect(health({ nostr: down })).toMatchObject({ status: 'bad', title: 'Predicting' });
  });

  test('the bug: a new neuron with a vault mismatch is Starting, not Predicting; the mismatch keeps the status, the line and the card', () => {
    const h = health({ rows: [open(NOW - 10 * M)], central: central({ nextPoll: NOW + 12 * M, registration: mismatch }) });
    expect(ids(h)).toEqual(['vault-mismatch', 'starting']);
    expect(h).toMatchObject({ status: 'warn', title: 'Starting', line: "Central pays this vault's rewards to another address.",
      action: { id: 'vault-mismatch', button: 'Open Settings' } });
  });

  // The title-defining states, from the log.
  const slept = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H), open(NOW - 10 * M, NOW, { gap: 3 * D, missed: true })];
  const STATES = {
    starting: () => [open(NOW - 10 * M)], // no good cycle in the log yet
    asleep: () => slept, // a session missed work and has not caught up
    caughtUp: () => [...slept, good(NOW - 5 * M, 83, { caughtUp: 3 * D })], // …and has: the asleep reason stays, predicting
    predicting: running,
    retrying: () => [...running(), failed(NOW - H)], // central-failed: one failed poll, still predicting
    failing: () => [open(NOW - 12 * H), good(NOW - 11.5 * H), failed(NOW - 6 * H), failed(NOW - H)], // central-failing
  };
  // Each reason added to a state's input; asleep and starting come only from the states' logs.
  const rows = (...more) => (i) => ({ ...i, rows: [...i.rows, ...more] });
  const reg = (registration) => (i) => ({ ...i, central: { ...i.central, registration } });
  const ADD = {
    'db-error': rows(failed(NOW - 10, 'IO Error: Could not write file', { local: true, sent: 0 })),
    'login-refused': rows(failed(NOW - 10, 'central 401: Invalid signature', { login: true })),
    'central-failing': rows(failed(NOW - 20), failed(NOW - 10)),
    'central-overdue': (i) => ({ ...i, now: NOW + WINDOW_S }), // open WINDOW_S more with nothing sent
    'base-failing': (i) => ({ ...rows(row('base', NOW - 2 * H, 'bad', { round: 20742, error: 'HTTP request failed' }, { count: 2, until: NOW - H, mkey: 'e' }))(i),
      base: delegated({ lastCheck: { at: NOW - H, error: 'HTTP request failed' } }) }),
    'relays-down': (i) => ({ ...i, nostr: nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'closed' }] }) }),
    'central-failed': rows(failed(NOW - 10)),
    backup: (i) => ({ ...i, storage: { persisted: false }, backedUp: false }),
    'vault-mismatch': reg(mismatch),
    'not-registered': reg({ ok: false, error: 'central unreachable: Failed to fetch' }),
    delegate: (i) => ({ ...i, base: base({ vault: { satori: '100', delegated: 'none' } }) }),
    'gas-low': (i) => ({ ...i, base: delegated({ identity: { power: '100', lowEth: true, batchesLeft: 3, eth: '0.00001' } }) }),
    'base-skipped': (i) => ({ ...i, base: delegated({ lastCheck: { at: NOW, round: 20742, skipped: 'gas above the ceiling: 3 gwei > 2 gwei' } }) }),
    'base-unreachable': (i) => ({ ...i, base: base({ error: 'HTTP request failed', config: null }) }),
    'relay-down': (i) => ({ ...i, nostr: nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'closed' }] }) }),
    asleep: (i) => i,
    starting: (i) => i,
  };
  const [S, A, P, B, N, X] = ['Starting', 'Was asleep', 'Predicting', 'Partly predicting', 'Not predicting', '(cannot meet)'];
  // One column per reason, in PRIORITY order. A bad central reason is "predictions failing"; a red Base while it is
  // delegated is "partly" once central predicts (a good cycle); no other reason moves the title (Nostr never does).
  const TABLE = {
    //          db-err login fail'g overdue b-fail relays c-fail backup vault  notreg deleg  gas    skip   unreach relay  asleep start
    starting:   [N,    N,    N,     N,      S,     S,     S,     S,     S,     S,     S,     S,     S,     S,      S,     X,     S],
    asleep:     [N,    N,    N,     N,      B,     A,     A,     A,     A,     A,     A,     A,     A,     A,      A,     A,     X],
    caughtUp:   [N,    N,    N,     N,      B,     P,     P,     P,     P,     P,     P,     P,     P,     P,      P,     P,     X],
    predicting: [N,    N,    N,     N,      B,     P,     P,     P,     P,     P,     P,     P,     P,     P,      P,     X,     X],
    retrying:   [N,    N,    N,     N,      B,     P,     X,     P,     P,     P,     P,     P,     P,     P,      P,     X,     X],
    failing:    [N,    N,    N,     N,      N,     N,     X,     N,     N,     N,     N,     N,     N,     N,      N,     X,     X],
  };
  const cells = Object.entries(TABLE).flatMap(([state, titles]) => PRIORITY.map((id, k) => [state, id, titles[k]]));

  test('the table has a cell for every state and every reason', () => {
    expect(Object.keys(ADD)).toEqual(PRIORITY);
    expect(Object.keys(TABLE)).toEqual(Object.keys(STATES));
    for (const titles of Object.values(TABLE)) expect(titles).toHaveLength(PRIORITY.length);
  });

  test.each(cells)('%s + %s → %s', (state, id, title) => {
    const h = healthOf(ADD[id]({ now: NOW, rows: STATES[state](), central: central(), base: base(), nostr: nostr(),
      storage: { persisted: true }, app: { installed: false, canInstall: false }, backedUp: true }));
    if (title === X) return expect(ids(h)).not.toContain(id); // e.g. a third failure is still central-failing, not central-failed
    expect(ids(h)).toContain(id);
    expect(h.title).toBe(title);
    expect(h.status).toBe(h.reasons[0].status); // the status: still the highest reason's
  });
});

describe('the tone: green while all is well (sky at rest, regular while working, vivid when closing would lose work)', () => {
  const e = (task, step, critical = false) => ({ task, step, done: null, total: null, since: 0, critical });
  const WORK = { none: {}, working: { central: e('central', 'history') }, critical: { central: e('central', 'send', true) } };
  test('toneOf: warn and bad win; else critical, working, or idle (never gray)', () => {
    for (const s of ['ok', 'idle']) expect([toneOf(s, null), toneOf(s, e('base', 'check')), toneOf(s, e('base', 'send', true))]).toEqual(['idle', 'working', 'critical']);
    for (const s of ['warn', 'bad']) expect([toneOf(s, null), toneOf(s, e('base', 'check')), toneOf(s, e('base', 'send', true))]).toEqual([s, s, s]);
  });

  // every reason (each alone, added to a predicting neuron; asleep and starting from their logs) with each kind of work
  const slept = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H), open(NOW - 10 * M, NOW, { gap: 3 * D, missed: true })];
  const LOG = { asleep: () => slept, starting: () => [open(NOW - 10 * M)] };
  const ONE = {
    'db-error': { rows: [...running(), failed(NOW - 10, 'IO Error', { local: true, sent: 0 })] },
    'login-refused': { rows: [...running(), failed(NOW - 10, 'central 401: Invalid signature', { login: true })] },
    'central-failing': { rows: [...running(), failed(NOW - 20), failed(NOW - 10)] },
    'central-overdue': { now: NOW + WINDOW_S },
    'base-failing': { rows: [...running(), row('base', NOW - 2 * H, 'bad', { round: 20742, error: 'x' }, { count: 2, until: NOW - H, mkey: 'e' })],
      base: delegated({ lastCheck: { at: NOW - H, error: 'x' } }) },
    'relays-down': { nostr: nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'closed' }] }) },
    'central-failed': { rows: [...running(), failed(NOW - 10)] },
    backup: { storage: { persisted: false }, backedUp: false },
    'vault-mismatch': { central: central({ registration: { ok: true, vault: '0xa', vault_base_address: null, vaultMismatch: 'none' } }) },
    'not-registered': { central: central({ registration: { ok: false, error: 'x' } }) },
    delegate: { base: base({ vault: { satori: '100', delegated: 'none' } }) },
    'gas-low': { base: delegated({ identity: { power: '100', lowEth: true, batchesLeft: 3, eth: '0.00001' } }) },
    'base-skipped': { base: delegated({ lastCheck: { at: NOW, round: 20742, skipped: 'gas above the ceiling: 3 gwei > 2 gwei' } }) },
    'base-unreachable': { base: base({ error: 'x', config: null }) },
    'relay-down': { nostr: nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'closed' }] }) },
    asleep: { rows: LOG.asleep() },
    starting: { rows: LOG.starting() },
  };
  const STATUS_TONE = { ok: ['idle', 'working', 'critical'], idle: ['idle', 'working', 'critical'], warn: ['warn', 'warn', 'warn'], bad: ['bad', 'bad', 'bad'] };
  test('the table has every reason', () => expect(Object.keys(ONE)).toEqual(PRIORITY));
  test.each(PRIORITY)('%s, with no work, working, critical', (id) => {
    const tones = Object.values(WORK).map((work) => {
      const h = health({ ...ONE[id], work });
      expect(ids(h)).toContain(id);
      return [h.status, h.tone];
    });
    const status = tones[0][0];
    expect(tones.map(([, t]) => t)).toEqual(STATUS_TONE[status]);
  });

  test('health().work: the leading entry with its words; the hero never gray, starting and catching up are working', () => {
    const h = health({ rows: LOG.starting(), work: { central: { ...e('central', 'history'), done: 3, total: 82 } } });
    expect(h).toMatchObject({ status: 'idle', title: 'Starting', tone: 'working',
      work: { task: 'central', step: 'history', done: 3, total: 82, critical: false, text: 'Loading history · 3 of 82 streams' } });
    expect(health({ rows: LOG.asleep(), work: { central: { ...e('central', 'send', true), total: 82 } } })).toMatchObject({
      title: 'Was asleep', tone: 'critical', work: { critical: true, text: 'Keep Satori open · Sending 82 predictions…' } });
  });

  test('chips: working regular green, healthy idle sky, deliberately off gray, warn and bad as they are', () => {
    const ch = (o) => health(o).channels;
    expect(ch({ work: WORK.working }).central).toMatchObject({ state: 'ok', tone: 'working' });
    expect(ch({ work: { claim: e('claim', 'confirm', true) } }).base).toMatchObject({ tone: 'working' }); // a vault action is Base's
    expect(ch({ base: delegated() }).base).toMatchObject({ state: 'ok', tone: 'idle', text: 'Round 20742 due' });
    expect(ch({ base: delegated(), work: { base: e('base', 'send', true) } }).base).toMatchObject({ tone: 'working' });
    expect(ch({ base: base({ config: null }) }).base).toMatchObject({ text: 'Connecting…', tone: 'working' });
    expect(ch({ base: delegated({ vault: { satori: '100', delegated: 'other' } }) }).base).toMatchObject({ tone: 'off', text: 'Delegated elsewhere' });
    expect(ch({ base: base({ vault: { satori: '100', delegated: 'none' } }) }).base).toMatchObject({ state: 'warn', tone: 'warn' });
    expect(ch({ nostr: nostr({ subscriptions: [sub] }) }).network).toMatchObject({ tone: 'idle', text: '2 relays' });
    expect(ch({ work: { discover: e('discover', 'ask') } }).network).toMatchObject({ tone: 'working', text: 'No streams' });
    expect(ch({ rows: [...running(), failed(NOW - 20), failed(NOW - 10)], work: WORK.working }).central).toMatchObject({ tone: 'bad' });
  });
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
