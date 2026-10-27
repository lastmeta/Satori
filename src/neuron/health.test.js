// The health rules (docs/design/health.md) on fabricated logs: every status,
// every reason and the action priority, open time and missed work, the day
// strip, the chips and the feed.
import { describe, expect, test } from 'vitest';
import {
  healthOf, toneOf, missedBy, openTime, sessionsOf, isGood, daysOf, feedOf, PRIORITY, LEVEL, WINDOW_S, FIRST_S, CADENCE_S, DAYS, RELAY_GRACE_S,
  fmtAgo, fmtIn, fmtDur,
} from './health.js';

const M = 60;
const H = 3600;
const D = 86400;
const NOW = new Date(2026, 9, 16, 15, 0, 0).getTime() / 1000; // 15:00 local
let id = 0;
const row = (kind, at, level, data, o = {}) => ({ id: ++id, kind, at, until: null, level, data, count: 1, mkey: null, ...o });
const open = (at, until = at, data = {}) => row('open', at, data.missed ? 'idle' : 'ok', { gap: null, missed: false, ...data }, { until });
const good = (at, accepted = 83, data = {}) => row('central', at, 'ok', { streams: 83, new: 83, predicted: accepted, sent: accepted, accepted, pending: 0, ...data });
const failed = (at, error = 'Satori Network 500: boom', data = {}) => row('central', at, 'bad', { streams: 83, new: 1, predicted: 1, sent: 83, accepted: 0, pending: 83, error, ...data });

const central = (o = {}) => ({ url: 'https://central2.satorinet.io', registration: { ok: true, peer_id: 7, walletMismatch: false }, nextPoll: NOW + 9 * H,
  polling: false, pending: 0, ...o });
const base = (o = {}) => ({ config: 'bundled', error: '', round: 20742, alias: { eth: '0.1', power: '0', lowEth: false, batchesLeft: 100 },
  wallet: { satori: '0', eth: '0', staked: 'none' }, claimable: { rewards: '0', airdrop: '0' }, lastBatch: null, lastCheck: null, checking: false, ...o });
const staked = (o = {}) => base({ alias: { eth: '0.1', power: '100', lowEth: false, batchesLeft: 100 }, wallet: { satori: '100', eth: '0.1', staked: 'alias' }, ...o });
const nostr = (o = {}) => ({ relays: [{ url: 'wss://a', state: 'open', write: true }, { url: 'wss://b', state: 'open', write: false }], subscriptions: [], ...o });
const sub = { uuid: 'r1', stream: 'x' };

/** A neuron open for the last 3 h whose last cycle was good, 2 h ago. */
const running = () => [open(NOW - 3 * H, NOW - 2 * M), good(NOW - 2 * H)];
const health = (o = {}) => healthOf({ now: NOW, rows: running(), central: central(), base: base(), nostr: nostr(),
  storage: { persisted: true }, app: { installed: false, canInstall: false }, backedUp: true, ...o });
const ids = (h) => h.reasons.map((r) => r.id);
const INSTALL_TEXT = "Satori works while it's open. Install it: it stays open in its own window, and keeps your keys.";

describe('ok: predicting', () => {
  test('central took predictions within the window; Base not staked with no SATORI; nothing subscribed', () => {
    const h = health();
    expect(h).toMatchObject({ status: 'ok', title: 'Predicted', line: 'Sent 83 predictions 2 h ago · next in 9 h', action: null, reasons: [] });
    expect(h.channels).toEqual({ // by the words people see: the Satori Network, the Satori contract, the Satori relays
      network: { state: 'ok', tone: 'idle', text: '83 sent 2 h ago' },
      contract: { state: 'idle', tone: 'off', text: 'Not staked' },
      relays: { state: 'idle', tone: 'off', text: 'No streams' },
    });
    expect([h.tone, h.work]).toEqual(['idle', null]); // all good, nothing in progress: sky green
  });
  test('staked: this round sent, or its check not run yet; subscribed with every relay up (connecting counts)', () => {
    expect(health({ base: staked({ lastBatch: { round: 20742, at: NOW - H, games: [{}] } }) }).channels.contract)
      .toEqual({ state: 'ok', tone: 'idle', text: 'Round 20742 sent' });
    expect(health({ base: staked() })).toMatchObject({ status: 'ok', channels: { contract: { state: 'ok', text: 'Round 20742 due' } } });
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'connecting' }] });
    expect(health({ nostr: n })).toMatchObject({ status: 'ok', channels: { relays: { state: 'ok', text: '2 relays' } } });
  });
  test('a poll with nothing to send is a good cycle: up to date, never "0 sent" (the chip, the line, the feed)', () => {
    expect(isGood(good(NOW, 0))).toBe(true);
    expect(isGood(failed(NOW))).toBe(false);
    expect(isGood(row('central', NOW, 'bad', { sent: 3, accepted: 0 }))).toBe(false); // central took none
    const h = health({ rows: [open(NOW - 3 * H), good(NOW - 2 * H), good(NOW - H, 0)] });
    expect(h).toMatchObject({ status: 'ok', title: 'Predicted', line: 'Up to date · next in 9 h' });
    expect(h.channels.network).toEqual({ state: 'ok', tone: 'idle', text: 'Up to date' });
    expect(h.feed.map((f) => f.text)).toEqual(['Checked the Satori Network: up to date', 'Sent 83 predictions to the Satori Network']);
    const polling = health({ rows: [open(NOW - 3 * H), good(NOW - H, 0)], central: central({ polling: true }) });
    expect([polling.line, polling.channels.network.text]).toEqual(['Up to date · next now…', 'Up to date']);
    // caught up after being asleep, with nothing to send
    const slept = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H), open(NOW - 10 * M, NOW, { gap: 3 * D, missed: true })];
    const caught = health({ rows: [...slept, good(NOW - 5 * M, 0, { caughtUp: 3 * D })] });
    expect(caught.feed[0].text).toBe('Caught up: up to date');
    expect(caught.channels.network.text).toBe('Up to date');
    for (const x of [h, polling, caught]) expect(JSON.stringify(x)).not.toMatch(/\b0 (sent|predictions)|sent 0|nothing new/);
  });
});

describe('idle: calm, never red for being closed', () => {
  test('starting: a new neuron before its first good cycle, getting its first predictions at once', () => {
    const register = { central: { task: 'central', step: 'register', done: null, total: null, since: 0, critical: false } };
    for (const [c, work] of [[central({ polling: true }), {}], [central({ nextPoll: null }), register]]) { // polling; registering first
      const h = health({ rows: [open(NOW - M)], central: c, work });
      expect(h).toMatchObject({ status: 'idle', title: 'Starting', line: 'Getting its first predictions…', action: null });
      expect(h.channels.network).toMatchObject({ state: 'idle', text: 'First poll now…' });
    }
    // due, and nothing runs (a timer that slept, until the catch-up pass): it never claims to be working
    for (const c of [central({ nextPoll: NOW }), central({ nextPoll: null })]) {
      const h = health({ rows: [open(NOW - M)], central: c });
      expect([h.line, h.channels.network.text]).toEqual(['First predictions soon.', 'First poll soon']);
    }
    // a stored time still ahead (none for a new neuron): says when
    expect(health({ rows: [open(NOW - 10 * M)], central: central({ nextPoll: NOW + 12 * M }) }).line).toBe('First predictions in 12 min.');
  });

  test('asleep: closed while a poll came due; catching up, then caught up until the next normal cycle', () => {
    const before = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H)];
    const woke = open(NOW - 10 * M, NOW - M, { gap: 3 * D - 2 * H - 10 * M, missed: true });
    let h = health({ rows: [...before, woke], central: central({ polling: true }) }); // the overdue poll runs at once
    expect(h).toMatchObject({ status: 'idle', title: 'Was asleep', line: 'Closed for 3 days. Catching up now…', action: null });
    expect(h.channels.network).toEqual({ state: 'idle', tone: 'idle', text: 'Catching up now…' });
    expect(health({ rows: [...before, woke], central: central({ nextPoll: NOW + 12 * M }) }).line).toBe('Closed for 3 days. Catching up in 12 min.');
    // "Catching up now…" only while the work runs: a poll due with nothing running (the bug: a device that slept with
    // the page open, its timer not fired) says soon, until the catch-up pass runs it
    const stuck = health({ rows: [...before, woke], central: central({ nextPoll: NOW - H }) });
    expect([stuck.line, stuck.channels.network.text]).toEqual(['Closed for 3 days. Catching up soon.', 'Catching up soon']);
    const signing = { central: { task: 'central', step: 'register', done: null, total: null, since: 0, critical: false } };
    expect(health({ rows: [...before, woke], central: central({ nextPoll: null }), work: signing }).line).toBe('Closed for 3 days. Catching up now…');
    // it never counts the closed time: three days closed is not overdue
    expect(ids(h)).toEqual(['asleep']);

    // the browser offers Install: advice, its own reason (the card), the state unchanged
    const offered = health({ rows: [...before, woke], central: central({ polling: true }), app: { installed: false, canInstall: true } });
    expect(ids(offered)).toEqual(['asleep', 'install']);
    expect(offered.reasons[1]).toMatchObject({ id: 'install', status: 'advice', channel: null });
    expect(offered.action).toEqual({ id: 'install', text: INSTALL_TEXT, button: 'Install', do: 'install', dismiss: 'Not now' });
    expect(offered).toMatchObject({ status: 'idle', tone: 'idle', title: 'Was asleep', line: 'Closed for 3 days. Catching up now…' });

    const caught = good(NOW - 20, 83, { caughtUp: woke.data.gap });
    h = health({ rows: [...before, woke, caught] });
    expect(h).toMatchObject({ status: 'idle', title: 'Predicted', line: 'Closed for 3 days. Caught up just now.' }); // caught up: predicting
    expect(h.channels.network).toEqual({ state: 'ok', tone: 'idle', text: '83 sent just now' });

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
    expect(h.channels.network).toEqual({ state: 'bad', tone: 'bad', text: 'Nothing sent for 13 h' });
    expect([WINDOW_S, FIRST_S]).toEqual([12 * H, H]); // 11 h + 1 h of grace; the first poll is at once, + 1 h
    // the same 13 h with 4 of them closed is fine
    expect(health({ rows: [open(NOW - 14 * H, NOW - 10 * H), good(NOW - 13 * H), open(NOW - 6 * H, NOW)] }).status).toBe('ok');
    expect(health({ rows: [open(NOW - FIRST_S - M)] }).reasons[0].id).toBe('central-overdue');
  });

  test('a failed cycle: amber while it retries in minutes, named for what failed; two quick failures stay amber', () => {
    let h = health({ rows: [...running(), failed(NOW - H)], central: central({ nextPoll: NOW + 2 * M, failures: 1 }) });
    expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'Sending failed; next try in 2 min.' });
    expect(h.action).toEqual({ id: 'central-failed', text: 'Satori Network 500: boom. It tries again in 2 min; try now if something was fixed.',
      button: 'Try again', do: 'poll' });
    expect(h.channels.network).toEqual({ state: 'warn', tone: 'warn', text: 'Sending failed' });
    // the bug: a second failure minutes later (a manual retry) turned Home red, though predictions went out minutes before
    h = health({ rows: [...running(), failed(NOW - 10 * M), failed(NOW - 2 * M)], central: central({ nextPoll: NOW + 8 * M, failures: 2 }) });
    expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'Sending failed; next try in 8 min.' });
    expect(ids(h)).toEqual(['central-failed']);
    // named for what failed: not reached at all, or central answered the poll with an error; trying again now
    const unreached = failed(NOW - M, 'Satori Network unreachable: Failed to fetch', { sent: 0, unreachable: true });
    h = health({ rows: [...running(), unreached], central: central({ nextPoll: NOW + 9 * M }) });
    expect([h.line, h.channels.network.text]).toEqual(["Couldn't reach the Satori Network; next try in 9 min.", 'Unreachable']);
    h = health({ rows: [...running(), failed(NOW - M, 'Satori Network 502: Bad Gateway', { sent: 0 })], central: central({ nextPoll: NOW + 9 * M }) });
    expect([h.line, h.channels.network.text]).toEqual(['The poll failed; next try in 9 min.', 'Poll failed']);
    const unsent = failed(NOW - M, undefined, { error: undefined }); // central answered, and took none of the batch
    expect(health({ rows: [...running(), unsent], central: central({ polling: true }) }).line).toBe('Sending failed; trying again now…');
  });

  test('red only once failures span a real cycle: nothing good for more than 12 h of open time', () => {
    const h = health({ rows: [open(NOW - 14 * H), good(NOW - 13 * H), failed(NOW - 6 * H), failed(NOW - H)] });
    expect(h).toMatchObject({ status: 'bad', title: 'Not predicting', line: 'Nothing sent for 13 h: sending failed.' });
    expect(h.action).toEqual({ id: 'central-failing', button: 'Try again', do: 'poll',
      text: "Satori Network 500: boom. Nothing went out for 13 h while Satori was open. It keeps trying; try now, or check the Satori Network's address in Settings." });
    expect(h.channels.network).toEqual({ state: 'bad', tone: 'bad', text: 'Sending failed' });
    expect(ids(h)).toEqual(['central-failing']); // not also overdue
    // the same failures within 11.5 h of open time: amber
    expect(health({ rows: [open(NOW - 12 * H), good(NOW - 11.5 * H), failed(NOW - 6 * H), failed(NOW - H)] }).status).toBe('warn');
    // a new neuron: no good cycle within FIRST_S of open time, its tries failing
    const fresh = [open(NOW - 2 * H), failed(NOW - 110 * M, 'Satori Network unreachable: Failed to fetch', { sent: 0, unreachable: true })];
    expect(health({ rows: fresh }).line).toBe("Nothing sent for 2 h: couldn't reach the Satori Network.");
  });

  test('login refused: bad at once', () => {
    const h = health({ rows: [...running(), failed(NOW - H, 'Satori Network 401: Invalid signature', { login: true })] });
    expect(h).toMatchObject({ status: 'bad', title: 'Not predicting', line: "The Satori Network refused this app's login." });
    expect(h.action).toEqual({ id: 'login-refused', text: "The Satori Network rejects this app's login. Check its address in Settings.",
      button: 'Open Settings', do: 'go', tab: 'settings', section: 'central' });
    expect(h.channels.network).toEqual({ state: 'bad', tone: 'bad', text: 'Login refused' });
  });

  test('a database or engine failure in the cycle', () => {
    const h = health({ rows: [...running(), failed(NOW - M, 'IO Error: Could not write file', { local: true, sent: 0 })] });
    expect(h).toMatchObject({ status: 'bad', line: 'The database failed.', channels: { network: { state: 'bad', text: 'Database error' } } });
    expect(h.action).toMatchObject({ id: 'db-error', button: 'Reload', do: 'reload' });
  });

  test("Base failing: staked, the check's same error twice in a row", () => {
    const err = row('base', NOW - 2 * H, 'bad', { round: 20742, error: 'HTTP request failed' }, { count: 2, until: NOW - H, mkey: 'e' });
    const h = health({ rows: [...running(), err], base: staked({ lastCheck: { at: NOW - H, error: 'HTTP request failed' } }) });
    expect(h).toMatchObject({ status: 'bad', title: 'Partly predicting', line: 'The Satori Network is fine. The Satori contract batch failed 2 times.' });
    expect(h.action).toMatchObject({ id: 'base-failing', do: 'go', tab: 'settings', section: 'base' });
    expect(h.channels.contract).toEqual({ state: 'bad', tone: 'bad', text: 'Failed 2 times' });
  });

  test('every relay down with a stream subscribed (a blocked one is not counted: none can carry them)', () => {
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'closed' }, { url: 'ws://b', state: 'blocked' }] });
    const h = health({ nostr: n });
    expect(h).toMatchObject({ status: 'bad', title: 'Predicting', line: 'The Satori Network is fine. Every relay is down.' });
    expect(h.channels.relays).toEqual({ state: 'bad', tone: 'bad', text: 'Relays down' });
    expect(health({ nostr: nostr({ subscriptions: [sub], relays: [] }) }).channels.relays.state).toBe('bad');
    expect(health({ nostr: nostr({ subscriptions: [sub], relays: [{ url: 'ws://b', state: 'blocked' }] }) }).channels.relays.state).toBe('bad');
    expect(health({ nostr: nostr({ relays: [{ url: 'wss://a', state: 'closed' }] }) }).status).toBe('ok'); // nothing subscribed
    // watching only: every relay down shows on the chip alone, amber; Home's answer (is it predicting?) stays ok
    const watchDown = health({ nostr: nostr({ watching: { streams: 3, sources: 1 }, relays: [{ url: 'wss://a', state: 'closed' }] }) });
    expect(watchDown).toMatchObject({ status: 'ok', reasons: [], channels: { relays: { state: 'warn', tone: 'warn', text: 'Relays down' } } });
    const watchGrace = health({ nostr: nostr({ watching: { streams: 3, sources: 1 }, relays: [{ url: 'wss://a', state: 'connecting', downSince: (NOW - 60) * 1000 }] }) });
    expect(watchGrace.channels.relays).toMatchObject({ state: 'ok', text: 'Watching 3' }); // reconnecting within 10 min counts as up
  });

  test(`a relay reconnecting has ${RELAY_GRACE_S / 60} min before it counts as down: then every relay down is red`, () => {
    const at = (min) => (NOW - min * M) * 1000; // downSince, ms
    const relays = (min) => [{ url: 'wss://a', state: 'closed', downSince: at(min) }, { url: 'wss://b', state: 'connecting', downSince: at(min) }];
    let h = health({ nostr: nostr({ subscriptions: [sub], relays: relays(9) }) });
    expect([h.status, ids(h), h.channels.relays]).toEqual(['ok', [], { state: 'ok', tone: 'idle', text: '2 relays' }]); // reconnecting
    h = health({ nostr: nostr({ subscriptions: [sub], relays: relays(10) }) });
    expect([h.status, ids(h), h.channels.relays.text]).toEqual(['bad', ['relays-down'], 'Relays down']);
    // one of two past the grace: advice, as before
    h = health({ nostr: nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open', downSince: null }, relays(30)[0]] }) });
    expect([ids(h), h.channels.relays.text]).toEqual([['relay-down'], '1 of 2 relays down']);
    h = health({ nostr: nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open', downSince: null }, relays(3)[0]] }) });
    expect(ids(h)).toEqual([]);
  });

  test('a relay blocked (ws:// on an https page) is neither down nor counted', () => {
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'ws://satorian:7777', state: 'blocked' }] });
    const h = health({ nostr: n });
    expect([h.status, ids(h), h.action]).toEqual(['ok', [], null]);
    expect(h.channels.relays).toEqual({ state: 'ok', tone: 'idle', text: '1 relay' }); // it was "1 of 2 relays down"
  });
});

const STAKE_TEXT = "Stake with this app to earn on the Satori contract. While staked, your SATORI can't be sent until you unstake.";
const STAKED_ELSEWHERE_TEXT = "Your wallet is staked with another address, so this app doesn't send its predictions to the Satori contract. "
  + 'Stake with this app to move the stake here.';

describe('staking (docs/design/health.md: stake, staked-elsewhere, stake-out-of-sync)', () => {
  test('not staked while the wallet holds SATORI: advice, the Stake card; the hero calm, the chip off', () => {
    const h = health({ base: base({ wallet: { satori: '100', staked: 'none' } }) });
    expect(h).toMatchObject({ status: 'ok', tone: 'idle', title: 'Predicted', line: 'Sent 83 predictions 2 h ago · next in 9 h' });
    expect(h.reasons).toEqual([{ id: 'stake', status: 'advice', channel: 'contract', text: STAKE_TEXT }]);
    expect(h.action).toEqual({ id: 'stake', text: STAKE_TEXT, button: 'Stake', do: 'stake' });
    expect(h.channels.contract).toEqual({ state: 'idle', tone: 'off', text: 'Not staked' });
  });
  test('staked with another address (another app\'s alias, after a new phone or a restore): advice, a Stake card to move it here', () => {
    const h = health({ base: base({ wallet: { satori: '100', staked: 'other', stakedWith: '0x' + 'ab'.repeat(20) } }) });
    expect(h).toMatchObject({ status: 'ok', tone: 'idle', title: 'Predicted' });
    expect(h.action).toEqual({ id: 'staked-elsewhere', text: STAKED_ELSEWHERE_TEXT, button: 'Stake here', do: 'stake' });
    expect(h.channels.contract).toEqual({ state: 'idle', tone: 'off', text: 'Staked elsewhere' });
  });
  test('out of sync (power under the wallet\'s SATORI): bad, on the Contract chip; the card explains, with no button; still predicting', () => {
    const h = health({ base: staked({ wallet: { satori: '100.000000000000000001', eth: '0.1', staked: 'alias', inSync: false,
      shortfall: '0.000000000000000001' } }) });
    expect(h).toMatchObject({ status: 'bad', tone: 'bad', title: 'Predicting', line: 'The Satori Network is fine. Staking is out of sync.' });
    expect(h.action).toEqual({ id: 'stake-out-of-sync', text: "Unstaking will fail until the contract fix. Don't add SATORI to the wallet." });
    expect(h.channels.contract).toEqual({ state: 'bad', tone: 'bad', text: 'Out of sync' });
    // in sync, or not checked (other stakers possible): nothing
    for (const inSync of [true, null]) expect(ids(health({ base: staked({ wallet: { satori: '100', staked: 'alias', inSync } }) }))).toEqual([]);
  });
});

describe('warn: predicting, but something needs you', () => {
  test("the alias's gas runs low", () => {
    const h = health({ base: staked({ alias: { power: '100', lowEth: true, batchesLeft: 3, eth: '0.00001' } }) });
    expect(h.action).toMatchObject({ id: 'gas-low', text: 'The app has gas for about 3 daily batches. Send a little Base ETH to its alias, on the Wallet tab.',
      button: 'Add gas', do: 'go', tab: 'wallet' });
    expect(h.channels.contract).toEqual({ state: 'warn', tone: 'warn', text: 'Gas: 3 batches' });
  });
  test("this round's batch skipped for a fixable reason; other skips are calm", () => {
    const check = { at: NOW, round: 20742, skipped: 'gas above the ceiling: a max fee of 3 gwei > 2 gwei; the next check tries again' };
    const h = health({ base: staked({ lastCheck: check }) });
    expect(h).toMatchObject({ status: 'warn', line: 'The Satori Network is fine. The Satori contract batch was skipped.' });
    expect(h.action).toMatchObject({ id: 'base-skipped', do: 'go', tab: 'settings', section: 'base' });
    expect(h.channels.contract).toEqual({ state: 'warn', tone: 'warn', text: 'Skipped: gas above the ceiling' });
    const sim = health({ base: staked({ lastCheck: { at: NOW, round: 20742, skipped: 'no game passes its simulation',
      dropped: [{ streamId: 1, gameId: 1, named: true, error: 'DuplicatePrediction' }, { streamId: 4, gameId: 2, error: 'SomethingNew' }] } }) });
    expect(sim.action).toMatchObject({ id: 'base-skipped', tab: 'wallet', text: 'Satori contract batch skipped: no game passes its '
      + "simulation (Sentiment stream 1: predicted less than 24 hours ago; stream 4: the contract refused it, SomethingNew). The next check tries again." });
    expect(health({ base: staked({ lastCheck: { round: 20742, skipped: 'no streams with a game' } }) }).status).toBe('ok');
    expect(health({ base: staked({ lastCheck: { round: 20741, skipped: 'no game passes its simulation' } }) }).status).toBe('ok'); // last round's
  });
  test('Base unreachable while it is in use (staked, or a batch sent before): warn', () => {
    for (const b of [staked({ error: 'HTTP request failed' }), base({ error: 'HTTP request failed', config: null, lastBatch: { round: 20741 } })]) {
      const h = health({ base: b });
      expect(h).toMatchObject({ status: 'warn', line: "The Satori Network is fine. Can't reach Base." });
      expect(h.channels.contract).toEqual({ state: 'warn', tone: 'warn', text: 'Unreachable' });
    }
    expect(health({ base: base({ config: null }) }).channels.contract).toEqual({ state: 'idle', tone: 'working', text: 'Connecting…' });
  });
  test('Base not used (not staked, no batch ever sent): an RPC error is a note on the Contract chip, grey; Home stays green', () => {
    for (const b of [base({ error: 'HTTP request failed', config: null }), base({ lastCheck: { at: NOW, error: 'HTTP request failed', unused: true } })]) {
      const h = health({ base: b });
      expect(h).toMatchObject({ status: 'ok', tone: 'idle', title: 'Predicted', line: 'Sent 83 predictions 2 h ago · next in 9 h', action: null });
      expect(h.reasons).toEqual([{ id: 'base-unused-unreachable', status: 'note', channel: 'contract', text: expect.stringMatching(/^Can't reach Base/) }]);
      expect(h.channels.contract).toEqual({ state: 'note', tone: 'off', text: 'Unreachable' });
    }
  });
  test('a Satori contract batch that never mines: amber, retrying with a higher fee; past the max fee, said, with Settings', () => {
    const pending = (stuck) => staked({ pendingBatch: { round: 20742, hash: '0xab', sentAt: NOW - M, stuck } });
    let h = health({ base: pending({ at: NOW - M, replaced: 1, fee: '0.025' }) });
    expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: 'The Satori Network is fine. The Satori contract batch is stuck; retrying with a higher fee.' });
    expect(h.action).toEqual({ id: 'base-stuck', text: 'The Satori contract batch was not mined for 10 min, so it was sent again with a higher fee '
      + '(0.025 gwei), within the max fee. It keeps checking.' });
    expect(h.channels.contract).toEqual({ state: 'warn', tone: 'warn', text: 'Batch stuck' });
    h = health({ base: pending({ at: NOW - M, ceiling: true, fee: '2.5', max: '2' }) });
    expect(h.action).toEqual({ id: 'base-stuck', button: 'Open Settings', do: 'go', tab: 'settings', section: 'base',
      text: 'The Satori contract batch is stuck: a higher fee (2.5 gwei) would pass the max fee (2 gwei), so it waits. Raise the max fee in Settings.' });
    expect(h.line).toBe('The Satori Network is fine. The Satori contract batch is stuck.');
    expect(ids(health({ base: pending(null) }))).toEqual([]); // waiting, not stuck yet
  });
  test("central: a wallet mismatch, by register's wallet_address; none is 'not linked', with why a link was refused", () => {
    const [ours, theirs] = ['0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7', '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'];
    const reg = (wallet_address, walletMismatch, walletLinkError = null) => central({ registration: { ok: true, peer_id: 7, wallet: ours,
      wallet_address, walletLinkError, walletMismatch } });
    let h = health({ central: reg(theirs, 'other') });
    expect(h).toMatchObject({ status: 'warn', title: 'Predicting', line: "The Satori Network pays this wallet's rewards to another address." });
    expect(h.action).toEqual({ id: 'wallet-mismatch', do: 'relink', button: 'Link this wallet',
      text: `The Satori Network pays this wallet's rewards to a different Base address, ${theirs}, not this wallet's ${ours}.`
        + ' Link this wallet: it signs a fresh link, and the Satori Network pays it.' });
    expect(h.channels.network).toEqual({ state: 'warn', tone: 'warn', text: 'Wallet mismatch' });
    h = health({ central: reg(null, 'none') });
    expect(h).toMatchObject({ status: 'warn', line: 'The Satori Network has no wallet linked to this app.' });
    expect(h.action).toMatchObject({ id: 'wallet-mismatch', text: 'The Satori Network has no wallet linked to this app, so it has no Base address '
      + 'to pay its rewards to. Link this wallet: it signs a fresh link, and the Satori Network pays it.' });
    expect(h.channels.network).toEqual({ state: 'warn', tone: 'warn', text: 'Wallet not linked' });
    h = health({ central: reg(null, 'none', 'stale link') });
    expect(h.action.text).toContain("It refused the wallet's link: stale link.");
    // a match, or a central that does not say: no reason
    for (const r of [reg(ours, false), reg(null, null)]) {
      h = health({ central: r });
      expect([h.status, ids(h), h.channels.network.state]).toEqual(['ok', [], 'ok']);
    }
    h = health({ central: central({ registration: { ok: false, error: 'Satori Network unreachable: Failed to fetch' } }) });
    expect(h.action).toEqual({ id: 'not-registered', button: 'Try again', do: 'poll', // a poll registers again first
      text: 'Registering with the Satori Network failed: Satori Network unreachable: Failed to fetch. It registers again before each poll until it succeeds.' });
    expect(h.channels.network).toEqual({ state: 'warn', tone: 'warn', text: 'Not registered' });
  });
});

describe('advice: the card, nothing wrong (never the status, the tone or the line)', () => {
  const calm = { status: 'ok', tone: 'idle', title: 'Predicted', line: 'Sent 83 predictions 2 h ago · next in 9 h' };
  test('storage not kept and no backup confirmed: the Back up card, the hero as it was', () => {
    const h = health({ storage: { persisted: false }, backedUp: false });
    expect(h).toMatchObject(calm);
    expect(h.reasons).toEqual([{ id: 'backup', status: 'advice', channel: null,
      text: 'This browser may clear Satori’s storage, your keys with it. Back up your wallet’s 24 words.' }]);
    expect(h.action).toEqual({ id: 'backup', text: 'This browser may clear Satori’s storage, your keys with it. Back up your wallet’s 24 words.',
      button: 'Back up', do: 'backup' });
    expect(ids(health({ storage: { persisted: false }, backedUp: true }))).toEqual([]);
    expect(ids(health({ storage: { persisted: true }, backedUp: false }))).toEqual([]);
    expect(ids(health({ storage: null, backedUp: false }))).toEqual([]); // not read yet
  });
  test('a relay down (another is up): the chip says so, calm; the card when nothing else needs one', () => {
    const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'closed' }] });
    const h = health({ nostr: n });
    expect(h).toMatchObject(calm);
    expect(h.action).toMatchObject({ id: 'relay-down', do: 'go', tab: 'settings', section: 'relays' });
    expect(h.channels.relays).toEqual({ state: 'advice', tone: 'idle', text: '1 of 2 relays down' });
  });
  test('the live finding: a new neuron, storage not kept, no backup: green through its first poll, then the Back up card at rest', () => {
    const fresh = { rows: [open(NOW - M)], central: central({ polling: true }), storage: { persisted: false }, backedUp: false };
    const step = (s, critical = false) => ({ central: { task: 'central', step: s, done: null, total: 82, since: 0, critical } });
    expect(health({ ...fresh, work: step('register') })).toMatchObject({ status: 'idle', tone: 'working', title: 'Starting' });
    expect(health({ ...fresh, work: step('history') })).toMatchObject({ status: 'idle', tone: 'working', line: 'Getting its first predictions…' });
    expect(health({ ...fresh, work: step('send', true) })).toMatchObject({ status: 'idle', tone: 'critical' });
    const rest = health({ ...fresh, rows: [open(NOW - M), good(NOW - 10, 82)], central: central({ nextPoll: NOW + 11 * H }) });
    expect(rest).toMatchObject({ status: 'ok', tone: 'idle', title: 'Predicted', line: 'Sent 82 predictions just now · next in 11 h',
      action: { id: 'backup', button: 'Back up' } });
  });
  test('a warn or bad reason with a button keeps the card; the advice waits', () => {
    const h = health({ storage: { persisted: false }, backedUp: false, base: staked({ alias: { power: '100', lowEth: true, batchesLeft: 3, eth: '0' } }) });
    expect([h.status, h.tone, h.action.id, h.line]).toEqual(['warn', 'warn', 'gas-low', 'The Satori Network is fine. Gas for the daily batch is running low.']);
    // two advice reasons: the first in order, the backup before the stake
    const two = health({ storage: { persisted: false }, backedUp: false, base: base({ wallet: { satori: '5', staked: 'none' } }) });
    expect([two.status, two.action.id]).toEqual(['ok', 'backup']);
  });
});

test('each reason\'s level (docs/design/health.md): bad, warn, idle (a calm state), advice (the card only)', () => {
  expect(LEVEL).toEqual({
    'db-error': 'bad', 'login-refused': 'bad', 'central-failing': 'bad', 'central-overdue': 'bad', 'base-failing': 'bad',
    'stake-out-of-sync': 'bad', 'relays-down': 'bad',
    'central-failed': 'warn', 'wallet-mismatch': 'warn', 'not-registered': 'warn', 'gas-low': 'warn', 'base-skipped': 'warn',
    'base-stuck': 'warn', 'base-unreachable': 'warn',
    asleep: 'idle', starting: 'idle',
    backup: 'advice', 'next-step': 'advice', stake: 'advice', 'staked-elsewhere': 'advice', install: 'advice', 'relay-down': 'advice',
    'base-unused-unreachable': 'note',
  });
  expect(PRIORITY).toEqual(Object.keys(LEVEL)); // highest first: every advice after every warn and bad
});

test('the action priority: the worst status; one card, the highest reason that has an action', () => {
  const n = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'closed' }] });
  const many = { nostr: n, storage: { persisted: false }, backedUp: false, base: base({ wallet: { satori: '5', staked: 'none' } }),
    central: central({ registration: { ok: true, walletMismatch: 'none' } }) };
  let h = health(many);
  expect(ids(h)).toEqual(['wallet-mismatch', 'backup', 'stake', 'relay-down']);
  expect([h.status, h.action.id]).toEqual(['warn', 'wallet-mismatch']);
  h = health({ ...many, rows: [...running(), failed(NOW - H, 'Satori Network 401: Invalid signature', { login: true })] });
  expect([h.status, h.action.id, h.title]).toEqual(['bad', 'login-refused', 'Not predicting']);
  // only advice: the first of them, in order (the backup before the relay)
  h = health({ nostr: n, storage: { persisted: false }, backedUp: false });
  expect([h.status, h.tone, h.action.id]).toEqual(['ok', 'idle', 'backup']);
  // asleep, Install offered, and a warn below it: the warn's card
  const rows = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H), open(NOW - 10 * M, NOW, { gap: 3 * D, missed: true })];
  h = health({ rows, base: staked({ alias: { power: '5', lowEth: true, batchesLeft: 2, eth: '0' } }), app: { installed: false, canInstall: true } });
  expect([h.status, h.title, h.action.id]).toEqual(['warn', 'Was asleep', 'gas-low']);
  expect(h.line).toBe('Gas for the daily batch is running low.'); // central is not "fine" while it catches up
});

describe('Install, as advice on Home, once (docs/design/pwa.md#install): wherever the browser can add Satori, not only after it was asleep', () => {
  const app = (o) => ({ installed: false, canInstall: false, addTo: null, ...o });
  test('Chromium offers its prompt: Install, or Not now', () => {
    const h = health({ app: app({ canInstall: true }) });
    expect(ids(h)).toEqual(['install']);
    expect(h).toMatchObject({ status: 'ok', tone: 'idle', title: 'Predicted', line: 'Sent 83 predictions 2 h ago · next in 9 h' }); // advice: nothing else moves
    expect(h.action).toEqual({ id: 'install', text: INSTALL_TEXT, button: 'Install', do: 'install', dismiss: 'Not now' });
  });
  test.each([
    ['ios', "Satori works while it's open. Add it to your Home Screen (Share › Add to Home Screen): it opens on its own screen and keeps "
      + 'your keys. The added app starts empty: set it up there, or restore it from your 24 words.'],
    ['mac', "Satori works while it's open. Add it to the Dock (File › Add to Dock): it stays open in its own window and keeps your keys. "
      + 'The added app starts empty: set it up there, or restore it from your 24 words.'],
    ['android', "Satori works while it's open. Add it to your Home screen (the browser's menu › Add app to Home screen): it opens in "
      + 'its own window.'],
  ])('no prompt (%s): how to add it, and Got it', (addTo, text) => {
    const h = health({ app: app({ addTo }) });
    expect(h.action).toEqual({ id: 'install', text, button: 'Got it', do: 'dismiss' });
  });
  test('once: dismissed, installed, or nothing to offer: none', () => {
    expect(ids(health({ app: app({ canInstall: true }), installDismissed: true }))).toEqual([]);
    expect(ids(health({ app: app({ addTo: 'ios' }), installDismissed: true }))).toEqual([]);
    expect(ids(health({ app: app({ installed: true, addTo: 'ios' }) }))).toEqual([]);
    expect(ids(health({ app: app({}) }))).toEqual([]); // Firefox on a computer: nothing to offer
  });
  test('below the backup and Stake: one card at a time', () => {
    const h = health({ app: app({ canInstall: true }), storage: { persisted: false }, backedUp: false });
    expect([ids(h), h.action.id]).toEqual([['backup', 'install'], 'backup']);
  });
});

test("each channel's last traffic (ms) for agents, when given: null before any", () => {
  const h = health({ traffic: { central: 1_792_250_000_000, base: null, network: null } });
  expect([h.channels.network.lastTraffic, h.channels.contract.lastTraffic, h.channels.relays.lastTraffic]).toEqual([1_792_250_000_000, null, null]);
  expect(health().channels.network).not.toHaveProperty('lastTraffic'); // not given
});

describe("the title: is my neuron predicting, on the channels that pay (central, and Base when staked), whichever reason leads", () => {
  const [ours, theirs] = ['0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7', '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'];
  const mismatch = { ok: true, peer_id: 7, wallet: ours, wallet_address: theirs, walletMismatch: 'other' };

  test('partly predicting: central predicts, but Base, a paying channel that should be predicting, is red', () => {
    const err = row('base', NOW - 2 * H, 'bad', { round: 20742, error: 'HTTP request failed' }, { count: 2, until: NOW - H, mkey: 'e' });
    const check = { lastCheck: { at: NOW - H, error: 'HTTP request failed' } };
    const failing = (b, rows = running()) => health({ rows: [...rows, err], base: b });
    // the bug: red, and the title said Predicting
    expect(failing(staked(check))).toMatchObject({ status: 'bad', title: 'Partly predicting', line: 'The Satori Network is fine. The Satori contract batch failed 2 times.',
      action: { id: 'base-failing' }, channels: { network: { state: 'ok' }, contract: { state: 'bad' } } });
    // its RPC down since this page loaded: the stake is not read, and a batch went out before: still Base's job
    const unread = base({ ...check, error: 'HTTP request failed', lastBatch: { round: 20741 }, wallet: { satori: null, eth: null, staked: null } });
    expect(failing(unread).title).toBe('Partly predicting');
    // not staked (any more): Base should not be predicting, so the title is central's
    expect(failing(base({ ...check, lastBatch: { round: 20741 } }))).toMatchObject({ status: 'bad', title: 'Predicting' });
    // central's last poll failed once: still predicting, so partly
    expect(failing(staked(check), [...running(), failed(NOW - 30 * M)])).toMatchObject({ status: 'bad', title: 'Partly predicting' });
    // central failing wins; a new neuron with no good cycle yet is starting; Nostr never moves the title
    expect(failing(staked(check), [open(NOW - 14 * H), good(NOW - 13 * H), failed(NOW - 6 * H), failed(NOW - H)]).title).toBe('Not predicting');
    expect(failing(staked(check), [open(NOW - 10 * M)]).title).toBe('Starting');
    const down = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'closed' }] });
    expect(health({ nostr: down })).toMatchObject({ status: 'bad', title: 'Predicting' });
  });

  test('the bug: a new neuron with a wallet mismatch is Starting, not Predicting; the mismatch keeps the status, the line and the card', () => {
    const h = health({ rows: [open(NOW - 10 * M)], central: central({ nextPoll: NOW + 12 * M, registration: mismatch }) });
    expect(ids(h)).toEqual(['wallet-mismatch', 'starting']);
    expect(h).toMatchObject({ status: 'warn', title: 'Starting', line: "The Satori Network pays this wallet's rewards to another address.",
      action: { id: 'wallet-mismatch', button: 'Link this wallet' } });
  });

  // The title-defining states, from the log.
  const slept = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H), open(NOW - 10 * M, NOW, { gap: 3 * D, missed: true })];
  const STATES = {
    starting: () => [open(NOW - 10 * M)], // no good cycle in the log yet
    asleep: () => slept, // a session missed work and has not caught up
    caughtUp: () => [...slept, good(NOW - 5 * M, 83, { caughtUp: 3 * D })], // …and has: the asleep reason stays, predicting
    predicting: running,
    retrying: () => [...running(), failed(NOW - H)], // central-failed: one failed poll, still predicting
    failing: () => [open(NOW - 14 * H), good(NOW - 13 * H), failed(NOW - 6 * H), failed(NOW - H)], // central-failing: over 12 h of open time
  };
  // Each reason added to a state's input; asleep and starting come only from the states' logs.
  const rows = (...more) => (i) => ({ ...i, rows: [...i.rows, ...more] });
  const reg = (registration) => (i) => ({ ...i, central: { ...i.central, registration } });
  const ADD = {
    'db-error': rows(failed(NOW - 10, 'IO Error: Could not write file', { local: true, sent: 0 })),
    'login-refused': rows(failed(NOW - 10, 'Satori Network 401: Invalid signature', { login: true })),
    'central-failing': (i) => ({ ...rows(failed(NOW + WINDOW_S - 10))(i), now: NOW + WINDOW_S }), // failing, open WINDOW_S more
    'central-overdue': (i) => ({ ...i, now: NOW + WINDOW_S }), // open WINDOW_S more with nothing sent
    'base-failing': (i) => ({ ...rows(row('base', NOW - 2 * H, 'bad', { round: 20742, error: 'HTTP request failed' }, { count: 2, until: NOW - H, mkey: 'e' }))(i),
      base: staked({ lastCheck: { at: NOW - H, error: 'HTTP request failed' } }) }),
    'stake-out-of-sync': (i) => ({ ...i, base: staked({ wallet: { satori: '101', eth: '0.1', staked: 'alias', inSync: false, shortfall: '1' } }) }),
    'relays-down': (i) => ({ ...i, nostr: nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'closed' }] }) }),
    'central-failed': rows(failed(NOW - 10)),
    'wallet-mismatch': reg(mismatch),
    'not-registered': reg({ ok: false, error: 'Satori Network unreachable: Failed to fetch' }),
    'gas-low': (i) => ({ ...i, base: staked({ alias: { power: '100', lowEth: true, batchesLeft: 3, eth: '0.00001' } }) }),
    'base-skipped': (i) => ({ ...i, base: staked({ lastCheck: { at: NOW, round: 20742, skipped: 'gas above the ceiling: 3 gwei > 2 gwei' } }) }),
    'base-stuck': (i) => ({ ...i, base: staked({ pendingBatch: { round: 20742, hash: '0xab', sentAt: NOW - M, stuck: { at: NOW, replaced: 1, fee: '0.02' } } }) }),
    'base-unreachable': (i) => ({ ...i, base: base({ error: 'HTTP request failed', config: null, lastBatch: { round: 20741 } }) }),
    asleep: (i) => i,
    starting: (i) => i,
    backup: (i) => ({ ...i, storage: { persisted: false }, backedUp: false }),
    'next-step': (i) => ({ ...i, rows: [open(NOW - 2 * D - 4 * H, NOW - 2 * D - 4 * H), open(NOW - D - 4 * H, NOW - D - 4 * H), ...i.rows],
      base: staked({ play: 'manual' }) }), // opened on 3 days, staked, by hand: Turn on Automatic
    stake: (i) => ({ ...i, base: base({ wallet: { satori: '100', staked: 'none' } }) }),
    'staked-elsewhere': (i) => ({ ...i, base: base({ wallet: { satori: '100', staked: 'other', stakedWith: '0x' + 'ab'.repeat(20) } }) }),
    install: (i) => ({ ...i, app: { installed: false, canInstall: true } }),
    'relay-down': (i) => ({ ...i, nostr: nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'closed' }] }) }),
    'base-unused-unreachable': (i) => ({ ...i, base: base({ error: 'HTTP request failed', config: null }) }),
  };
  const TITLE = { S: 'Starting', A: 'Was asleep', P: 'Predicting', B: 'Partly predicting', N: 'Not predicting' };
  const X = '(cannot meet)';
  // One row per reason, in PRIORITY order; one cell per state: "title status action" (the card's reason, – for none).
  // The title: a bad central reason is "predictions failing" (N); a red Base while it is staked is "partly" (B) once
  // central predicts; no other reason moves it (Nostr never does). The status: the worst bad, warn or idle; advice never
  // moves it, nor the tone, the title or the line. The card: the first reason with a button, so advice only when no warn
  // or bad has one. The tone follows the status: warn and bad as they are, else green (sky, working, vivid).
  const fixable = (id) => [`S warn ${id}`, `A warn ${id}`, `P warn ${id}`, `P warn ${id}`, 'P warn central-failed', 'N bad central-failing'];
  const TABLE = {
    //                  starting                 asleep                   caughtUp                 predicting               retrying                 failing
    'db-error':         ['N bad db-error',        'N bad db-error',        'N bad db-error',        'N bad db-error',        'N bad db-error',        'N bad db-error'],
    'login-refused':    ['N bad login-refused',   'N bad login-refused',   'N bad login-refused',   'N bad login-refused',   'N bad login-refused',   'N bad login-refused'],
    'central-failing':  ['N bad central-failing', 'N bad central-failing', 'N bad central-failing', 'N bad central-failing', 'N bad central-failing', 'N bad central-failing'],
    'central-overdue':  ['N bad central-overdue', 'N bad central-overdue', 'N bad central-overdue', 'N bad central-overdue', X,                       X],
    'base-failing':     ['S bad base-failing',    'B bad base-failing',    'B bad base-failing',    'B bad base-failing',    'B bad base-failing',    'N bad central-failing'],
    'stake-out-of-sync': ['S bad stake-out-of-sync', 'A bad stake-out-of-sync', 'P bad stake-out-of-sync', 'P bad stake-out-of-sync', 'P bad stake-out-of-sync', 'N bad central-failing'],
    'relays-down':      ['S bad relays-down',     'A bad relays-down',     'P bad relays-down',     'P bad relays-down',     'P bad relays-down',     'N bad central-failing'],
    'central-failed':   ['S warn central-failed', 'A warn central-failed', 'P warn central-failed', 'P warn central-failed', 'P warn central-failed', X],
    'wallet-mismatch':   fixable('wallet-mismatch'),
    'not-registered':   fixable('not-registered'),
    'gas-low':          fixable('gas-low'),
    'base-skipped':     fixable('base-skipped'),
    'base-stuck':       fixable('base-stuck'),
    'base-unreachable': fixable('base-unreachable'),
    asleep:             [X,                       'A idle –',              'P idle –',              X,                       X,                       X],
    starting:           ['S idle –',              X,                       X,                       X,                       X,                       X],
    backup:             ['S idle backup',         'A idle backup',         'P idle backup',         'P ok backup',           'P warn central-failed', 'N bad central-failing'],
    'next-step':        ['S idle next-step',      'A idle next-step',      'P idle next-step',      'P ok next-step',        'P warn central-failed', 'N bad central-failing'],
    stake:              ['S idle stake',          'A idle stake',          'P idle stake',          'P ok stake',            'P warn central-failed', 'N bad central-failing'],
    'staked-elsewhere': ['S idle staked-elsewhere', 'A idle staked-elsewhere', 'P idle staked-elsewhere', 'P ok staked-elsewhere', 'P warn central-failed', 'N bad central-failing'],
    install:            ['S idle install',        'A idle install',        'P idle install',        'P ok install',          'P warn central-failed', 'N bad central-failing'],
    'relay-down':       ['S idle relay-down',     'A idle relay-down',     'P idle relay-down',     'P ok relay-down',       'P warn central-failed', 'N bad central-failing'],
    'base-unused-unreachable': ['S idle –',       'A idle –',              'P idle –',              'P ok –',                'P warn central-failed', 'N bad central-failing'],
  };
  const cells = Object.entries(TABLE).flatMap(([id, row]) => Object.keys(STATES).map((state, k) => [state, id, row[k]]));
  const e = (task, step, critical = false) => ({ task, step, done: null, total: null, since: 0, critical });
  const WORK = [{}, { central: e('central', 'history') }, { central: e('central', 'send', true) }]; // none, working, critical
  const STATUS_TONE = { ok: ['idle', 'working', 'critical'], idle: ['idle', 'working', 'critical'], warn: ['warn', 'warn', 'warn'], bad: ['bad', 'bad', 'bad'] };
  const input = (state) => ({ now: NOW, rows: STATES[state](), central: central(), base: base(), nostr: nostr(),
    storage: { persisted: true }, app: { installed: false, canInstall: false }, backedUp: true });

  test('the table has a cell for every state and every reason', () => {
    expect(Object.keys(ADD)).toEqual(PRIORITY);
    expect(Object.keys(TABLE)).toEqual(PRIORITY);
    for (const row of Object.values(TABLE)) expect(row).toHaveLength(Object.keys(STATES).length);
  });

  test.each(cells)('%s + %s → %s', (state, id, cell) => {
    const [h, ...busy] = WORK.map((work) => healthOf({ ...ADD[id](input(state)), work }));
    if (cell === X) return expect(ids(h)).not.toContain(id); // e.g. a failure after 12 h of open time with none good is central-failing
    const [title, status, action] = cell.split(' ');
    expect(ids(h)).toContain(id);
    expect(h.reasons.find((r) => r.id === id).status).toBe(LEVEL[id]);
    expect([h.title, h.status, h.action?.id ?? '–']).toEqual([title === 'P' && ['ok', 'idle'].includes(status) ? 'Predicted' : TITLE[title], status, action]); // at rest: Predicted
    expect([h, ...busy].map((x) => x.tone)).toEqual(STATUS_TONE[status]);
    if (LEVEL[id] === 'advice') { // the hero exactly as without it
      const plain = healthOf(input(state));
      expect([h.title, h.status, h.tone, h.line]).toEqual([plain.title, plain.status, plain.tone, plain.line]);
    }
  });
});

describe('the tone: green while all is well (sky at rest, regular while working, vivid when closing would lose work)', () => {
  const e = (task, step, critical = false) => ({ task, step, done: null, total: null, since: 0, critical });
  const WORK = { none: {}, working: { central: e('central', 'history') }, critical: { central: e('central', 'send', true) } };
  test('toneOf: warn and bad win; else critical, working, or idle (never gray)', () => {
    for (const s of ['ok', 'idle']) expect([toneOf(s, null), toneOf(s, e('base', 'check')), toneOf(s, e('base', 'send', true))]).toEqual(['idle', 'working', 'critical']);
    for (const s of ['warn', 'bad']) expect([toneOf(s, null), toneOf(s, e('base', 'check')), toneOf(s, e('base', 'send', true))]).toEqual([s, s, s]);
  });

  // each reason's tone, in every state, with no work, working and critical: the table above
  const slept = [open(NOW - 3 * D, NOW - 3 * D + 2 * H), good(NOW - 3 * D + H), open(NOW - 10 * M, NOW, { gap: 3 * D, missed: true })];
  const LOG = { asleep: () => slept, starting: () => [open(NOW - 10 * M)] };

  test('health().work: the leading entry with its words; the hero never gray, starting and catching up are working', () => {
    const h = health({ rows: LOG.starting(), work: { central: { ...e('central', 'history'), done: 3, total: 82 } } });
    expect(h).toMatchObject({ status: 'idle', title: 'Starting', tone: 'working',
      work: { task: 'central', step: 'history', done: 3, total: 82, critical: false, text: 'Loading history · 3 of 82 streams' } });
    expect(health({ rows: LOG.asleep(), work: { central: { ...e('central', 'send', true), total: 82 } } })).toMatchObject({
      title: 'Was asleep', tone: 'critical', work: { critical: true, text: 'Keep Satori open · Sending 82 predictions…' } });
  });

  test('chips: working regular green, healthy idle sky, deliberately off gray, warn and bad as they are, advice calm', () => {
    const ch = (o) => health(o).channels;
    expect(ch({ work: WORK.working }).network).toMatchObject({ state: 'ok', tone: 'working' });
    expect(ch({ work: { claim: e('claim', 'confirm', true) } }).contract).toMatchObject({ tone: 'working' }); // a wallet action is Base's
    expect(ch({ base: staked() }).contract).toMatchObject({ state: 'ok', tone: 'idle', text: 'Round 20742 due' });
    expect(ch({ base: staked({ play: 'manual' }) }).contract).toMatchObject({ tone: 'off', text: 'Not played today' }); // the Game tab sends
    expect(ch({ base: staked({ play: 'manual', lastPlay: { round: 20742 } }) }).contract).toMatchObject({ state: 'ok', tone: 'idle', text: 'Played today' });
    expect(ch({ base: staked(), work: { base: e('base', 'send', true) } }).contract).toMatchObject({ tone: 'working' });
    expect(ch({ base: base({ config: null }) }).contract).toMatchObject({ text: 'Connecting…', tone: 'working' });
    expect(ch({ base: staked({ wallet: { satori: '100', staked: 'other' } }) }).contract).toMatchObject({ tone: 'off', text: 'Staked elsewhere' });
    // not staked with SATORI there: the Stake card is advice, and the chip says it plainly, off
    expect(ch({ base: base({ wallet: { satori: '100', staked: 'none' } }) }).contract).toMatchObject({ state: 'idle', tone: 'off', text: 'Not staked' });
    expect(ch({ base: staked({ wallet: { satori: '101', staked: 'alias', inSync: false } }) }).contract).toMatchObject({ state: 'bad', tone: 'bad' });
    expect(ch({ nostr: nostr({ subscriptions: [sub] }) }).relays).toMatchObject({ tone: 'idle', text: '2 relays' });
    const oneDown = nostr({ subscriptions: [sub], relays: [{ url: 'wss://a', state: 'open' }, { url: 'wss://b', state: 'closed' }] });
    expect(ch({ nostr: oneDown, work: { subscribe: e('subscribe', 'find') } }).relays).toEqual({ state: 'advice', tone: 'working', text: '1 of 2 relays down' });
    expect(ch({ work: { discover: e('discover', 'ask') } }).relays).toMatchObject({ tone: 'working', text: 'No streams' });
    // watching prediction streams (the track record), nothing subscribed: use of the relays, sky at rest, green while the scan runs
    const watching = (o) => nostr({ watching: { streams: 112, sources: 58 }, ...o });
    expect(ch({ nostr: watching() }).relays).toEqual({ state: 'ok', tone: 'idle', text: 'Watching 112' });
    expect(ch({ nostr: watching(), work: { watch: e('watch', 'verify') } }).relays).toMatchObject({ tone: 'working', text: 'Watching 112' });
    expect(ch({ nostr: nostr({ watching: { streams: 0, sources: 0 } }) }).relays).toMatchObject({ tone: 'off', text: 'No streams' });
    expect(ch({ nostr: watching({ subscriptions: [sub] }) }).relays).toMatchObject({ text: '2 relays' }); // subscriptions say what they said
    expect(ch({ rows: [...running(), failed(NOW - 20), failed(NOW - 10)], work: WORK.working }).network).toMatchObject({ tone: 'warn' });
    expect(ch({ rows: [open(NOW - 14 * H), good(NOW - 13 * H), failed(NOW - 10)], work: WORK.working }).network).toMatchObject({ tone: 'bad' });
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
    // each day's two halves: the Satori Network (off-chain) and the Satori contract (on-chain)
    expect(days.slice(-6).map((d) => `${d.network}/${d.contract}`)).toEqual(['ok/ok', 'ok/error', 'error/none', 'none/none', 'none/none', 'ok/none']);
    // a skipped check is no failure; the game's Submit with nothing to send (its time) is a play
    const skip = daysOf([open(day(0, 8), NOW), row('base', day(0, 9), 'warn', { skipped: 'gas above the ceiling' }), row('base', day(0, 10), 'ok', { games: [{}] })], NOW).at(-1);
    expect(skip.contract).toBe('ok');
    expect(daysOf([open(day(0, 8), NOW)], NOW, null, DAYS, day(0, 11)).at(-1).contract).toBe('ok');
    const play = daysOf([open(day(0, 8), NOW), row('wallet', day(0, 10), 'ok', { action: 'play', text: 'Sent 2…' })], NOW).at(-1);
    expect(play.contract).toBe('ok'); // the game played by hand
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
      row('base', day(2, 3), 'idle', { skipped: 'nothing staked with this app' }, { until: day(0, 3), count: 30 })];
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
    row('wallet', NOW - 30 * M, 'ok', { action: 'stake', text: 'Staked with this app' }),
    failed(NOW - 20 * M, 'Satori Network 401: Invalid signature', { login: true }),
    row('error', NOW - 10 * M, 'bad', { where: 'nostr', message: 'IO Error' }),
    open(NOW - 5 * M, NOW, { gap: 30 }),
  ];
  const { feed } = health({ rows });
  expect(feed.map((f) => [f.level, f.text])).toEqual([
    ['bad', 'A relay forecast failed: IO Error'],
    ['bad', 'The Satori Network refused the login: Satori Network 401: Invalid signature'],
    ['ok', 'Staked with this app'],
    ['ok', 'Published 3 forecasts to the Satori relays'],
    ['warn', 'Satori contract batch skipped: gas above the ceiling (×3)'],
    ['ok', 'Caught up: sent 83 predictions'],
    ['ok', 'History loaded for 83 streams'],
    ['idle', 'Satori was closed for 3 d'],
    ['ok', 'Satori contract batch for round 20739: 2 games'],
    ['ok', 'Sent 83 predictions to the Satori Network'],
  ]);
  expect(feed[0]).toEqual({ at: NOW - 10 * M, level: 'bad', text: 'A relay forecast failed: IO Error' });
  const busy = Array.from({ length: 30 }, (_, i) => good(NOW - (30 - i) * H));
  expect(health({ rows: busy }).feed).toHaveLength(20);
});

test('times in a few words', () => {
  expect([fmtAgo(20), fmtAgo(5 * M), fmtAgo(2 * H + 10 * M), fmtAgo(3 * D)]).toEqual(['just now', '5 min ago', '2 h ago', '3 d ago']);
  expect([fmtIn(-5), fmtIn(0), fmtIn(30), fmtIn(12 * M), fmtIn(9 * H - 1)]).toEqual(['soon', 'soon', 'in 1 min', 'in 12 min', 'in 9 h']);
  expect([fmtDur(45 * M), fmtDur(13 * H), fmtDur(D + 2 * H), fmtDur(3 * D - 4 * H)]).toEqual(['45 min', '13 h', '1 day', '3 days']);
  expect(fmtDur(3 * D - 4 * H, true)).toBe('3 d');
});

test('the feed is by time: a cycle logged when it ends sits at its start, after what happened meanwhile', () => {
  const rows = [open(NOW - H), row('base', NOW - 50 * M, 'idle', { skipped: 'no streams with a game' }), good(NOW - 55 * M)];
  expect(health({ rows }).feed.map((f) => f.text)).toEqual(['Satori contract batch skipped: no streams with a game', 'Sent 83 predictions to the Satori Network']);
});

describe('the Satori contract unused: its RPC errors are not failures (the day strip, the feed)', () => {
  test('a check that failed while Base was unused does not make a day part, and reads calm in the feed', () => {
    const day = [open(NOW - 3 * H, NOW), good(NOW - 2 * H)];
    const unused = row('base', NOW - H, 'idle', { round: null, error: 'HTTP request failed', unused: true }, { count: 3, until: NOW - 10 * M, mkey: 'e' });
    expect(daysOf([...day, unused], NOW).at(-1).code).toBe('full');
    const used = row('base', NOW - H, 'bad', { round: 20742, error: 'HTTP request failed' }, { mkey: 'e' });
    expect(daysOf([...day, used], NOW).at(-1).code).toBe('part'); // in use: a failure, as before
    expect(feedOf([unused])).toEqual([{ at: NOW - H, level: 'idle', text: "Couldn't reach the Satori contract (not staked): HTTP request failed (×3)" }]);
  });
  test('a stuck batch, logged: amber in the feed and a failure on the strip until it mines', () => {
    const stuck = row('base', NOW - H, 'warn', { round: 20742, skipped: 'stuck: retrying with a higher fee (0.02 gwei)', stuck: { replaced: 1, fee: '0.02' } }, { mkey: 'stuck' });
    expect(feedOf([stuck])).toEqual([{ at: NOW - H, level: 'warn', text: 'Satori contract batch stuck: sent again with a higher fee (0.02 gwei)' }]);
    expect(daysOf([open(NOW - 3 * H, NOW), good(NOW - 2 * H), stuck], NOW).at(-1).code).toBe('part');
  });
});

describe('address changes: a quiet note on Home for 24 h, and in the feed (the security review, 2026-10-19)', () => {
  const changed = (at, data) => row('setting', at, 'idle', data);
  test("the Satori Network's address or the Base RPC changed: a note each, newest first, for 24 h; the status, the card and the strip untouched", () => {
    const rows = [...running(), changed(NOW - 25 * H, { what: 'central', to: 'https://old.example' }),
      changed(NOW - 3 * H, { what: 'rpc', to: '', default: 'https://sepolia.base.org' }),
      changed(NOW - 30 * M, { what: 'central', to: 'https://other.example' })];
    const h = health({ rows });
    expect(h.notices).toEqual([
      { at: NOW - 30 * M, what: 'central', text: 'Satori Network address changed to https://other.example' },
      { at: NOW - 3 * H, what: 'rpc', text: 'Base RPC changed to the default, https://sepolia.base.org' },
    ]); // the one 25 h old has gone
    expect([h.status, h.action, h.reasons]).toEqual(['ok', null, []]);
    expect(h.days).toEqual(health().days);
    expect(h.feed.filter((f) => /changed/.test(f.text)).map((f) => [f.level, f.text])).toEqual([
      ['idle', 'Satori Network address changed to https://other.example'],
      ['idle', 'Base RPC changed to the default, https://sepolia.base.org'],
      ['idle', 'Satori Network address changed to https://old.example']]); // the feed keeps it
    expect(health().notices).toEqual([]);
    const rpc = changed(NOW - M, { what: 'rpc', to: 'https://mine.example' });
    expect(health({ rows: [...running(), rpc] }).notices[0].text).toBe('Base RPC changed to https://mine.example');
  });
  test('the reward address set or cleared: a note too, with the whole address; the status untouched', () => {
    const to = '0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7';
    const rows = [...running(), changed(NOW - 2 * H, { what: 'reward', to }), changed(NOW - H, { what: 'reward', to: '' })];
    const h = health({ rows });
    expect(h.notices).toEqual([
      { at: NOW - H, what: 'reward', text: 'Reward address cleared: rewards go to your wallet' },
      { at: NOW - 2 * H, what: 'reward', text: `Reward address set to ${to}` },
    ]);
    expect([h.status, h.action, h.reasons]).toEqual(['ok', null, []]);
    expect(h.feed.slice(0, 2).map((f) => f.text)).toEqual(['Reward address cleared: rewards go to your wallet', `Reward address set to ${to}`]);
  });
  test("central's contract addresses that differ from the app's: a quiet warning in the feed only", () => {
    const r = row('config', NOW - H, 'warn', { url: 'https://central2.satorinet.io', keys: ['token', 'hub'] });
    const h = health({ rows: [...running(), r] });
    expect([h.status, h.notices, h.days]).toEqual(['ok', [], health().days]);
    expect(h.feed[0]).toEqual({ at: NOW - H, level: 'warn',
      text: "The Satori Network's contract addresses differ from the app's (token, hub): the app's are used" });
  });
});

describe('the next step (the owner, 2026-10-27): a nudge toward predicting on the contract by itself', () => {
  const days = (n) => Array.from({ length: n }, (_, k) => open(NOW - (n - 1 - k) * D - 3 * H, NOW - (n - 1 - k) * D - 2 * H));
  const manual = staked({ play: 'manual' });
  test('from the third day the app was opened, the first step missing, with its button and Not now', () => {
    expect(ids(health({ rows: [...days(2), good(NOW - 2 * H)], base: manual }))).toEqual([]);
    const h = health({ rows: [...days(3), good(NOW - 2 * H)], base: manual });
    expect(h.reasons).toEqual([expect.objectContaining({ id: 'next-step', status: 'advice', channel: 'contract' })]);
    expect(h.action).toEqual({ id: 'next-step', text: expect.stringMatching(/^To earn more/), button: 'Turn on Automatic', do: 'auto', dismiss: 'Not now' });
    expect(h.status).toBe('ok'); // advice: never the status
    const eth = health({ rows: [...days(3), good(NOW - 2 * H)], base: base({ play: 'auto', alias: { eth: '0', lowEth: true, noGas: true, batchesLeft: 0 }, wallet: { satori: '100', eth: '0', lowEth: true, staked: 'none' } }) });
    expect(eth.action).toMatchObject({ id: 'next-step', button: 'Open Wallet', do: 'receive', text: expect.stringMatching(/Base ETH to your wallet/) });
    expect(ids(eth)).toEqual(['next-step', 'stake']); // Stake can't send without ETH: the nudge comes first on the card
    // Stake is the step: the Stake card says it already, from the first day
    expect(ids(health({ rows: [...days(3), good(NOW - 2 * H)], base: base({ play: 'auto', wallet: { satori: '100', eth: '0.01', staked: 'none' } }) }))).toEqual(['stake']);
  });
  test('Not now: away for 3 days, then back while the step is still missing', () => {
    const rows = [...days(4), good(NOW - 2 * H)];
    expect(ids(health({ rows, base: manual, nextStepDismissed: NOW - 2 * D }))).toEqual([]);
    expect(ids(health({ rows, base: manual, nextStepDismissed: NOW - 3 * D }))).toEqual(['next-step']);
  });
});
