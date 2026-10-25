// Home's answer to "is my neuron predicting every day on its own, and is
// anything broken?" (docs/design/health.md): the activity log and the current
// state in, one object out. Pure: the UI and window.satori.health() draw the same.
import { POLL_EVERY_S } from './index.js';
import { leading, workText, HERO } from './work.js';

export const CADENCE_S = POLL_EVERY_S; // 11 h, Lite's
export const GRACE_S = 3600;
export const WINDOW_S = CADENCE_S + GRACE_S; // open time a good cycle may take after the last one
export const FIRST_S = GRACE_S; // … and the first one (it polls at once)
export const HEARTBEAT_S = 300;
export const SLEEP_S = 900; // a heartbeat this late: the page did not run (closed, asleep, frozen)
export const KEEP_S = 90 * 86400;
export const RELAY_GRACE_S = 600; // a relay reconnecting counts as up this long (its backoff reaches 5 min)
export const DAYS = 30;
export const FEED = 20;
export const NOTICE_S = 86400; // an address change is noted on Home this long

/**
 * Each reason's level, highest first (docs/design/health.md#reasons-in-priority-order). bad and warn: something is
 * wrong for predicting or earning (red, amber); idle: a calm state (starting, catching up), green on Home; advice:
 * nothing is wrong, a suggestion for the card only, never the status, the tone or the line; note: words on its
 * channel's chip only (grey: a channel not used), no card. The status is the worst bad, warn or idle; the card is the
 * first with an action, so advice only when no warn or bad has one.
 */
export const LEVEL = {
  'db-error': 'bad', 'login-refused': 'bad', 'central-failing': 'bad', 'central-overdue': 'bad', 'base-failing': 'bad',
  'stake-out-of-sync': 'bad', 'relays-down': 'bad',
  'central-failed': 'warn', 'wallet-mismatch': 'warn', 'not-registered': 'warn', 'gas-low': 'warn', 'base-skipped': 'warn',
  'base-stuck': 'warn', 'base-unreachable': 'warn',
  asleep: 'idle', starting: 'idle',
  backup: 'advice', stake: 'advice', 'staked-elsewhere': 'advice', install: 'advice', 'relay-down': 'advice',
  'base-unused-unreachable': 'note',
};
export const PRIORITY = Object.keys(LEVEL);
const FRESH_LINK = ' Link this wallet: it signs a fresh link, and the Satori Network pays it.';
export const FIXABLE_SKIPS = /^(gas above the ceiling|no game passes its simulation)/;

/** The engine's refusals a batch's simulate names (SatoriEngine.sol predictMultipleWithPayloads), in a few words. */
const REFUSED = {
  DuplicatePrediction: 'predicted less than 24 hours ago', AlreadyPredicted: 'already predicted this round',
  StaleValue: 'no new value since the last prediction', EmptyStream: 'the stream has no values yet',
  StreamPullFailed: "the stream's source did not answer", Delegated: 'the alias has staked its own power elsewhere',
  ZeroBalance: 'no prediction power yet (the stake may not show on the chain yet)', UnknownStream: 'the game has no stream',
};
/** A check's skip, with each game left out and why: 'no game passes … (Sentiment stream 1: predicted less than 24 hours ago)'. */
export function skipText(check) {
  const why = (check?.dropped ?? []).map((g) => `${g.named ? 'Sentiment stream' : 'stream'} ${g.streamId}: ${
    REFUSED[g.error] ?? (g.error ? `the contract refused it, ${g.error}` : 'refused')}`);
  return why.length ? `${check.skipped} (${why.join('; ')})` : check?.skipped ?? '';
}

// ── times in a few words ──
const M = 60;
const H = 3600;
const D = 86400;
const round = (x) => Math.max(1, Math.round(x));
/** 'just now', '5 min ago', '2 h ago', '3 d ago' */
export function fmtAgo(s) {
  if (s < M) return 'just now';
  if (s < H) return `${Math.floor(s / M)} min ago`;
  if (s < D) return `${Math.floor(s / H)} h ago`;
  return `${Math.floor(s / D)} d ago`;
}
/** 'soon' (due: the catch-up pass runs it), 'in 12 min', 'in 9 h' */
export function fmtIn(s) {
  if (s <= 0) return 'soon';
  if (s < H) return `in ${Math.ceil(s / M)} min`;
  if (s < D) return `in ${Math.round(s / H)} h`;
  return `in ${Math.round(s / D)} d`;
}
/** '45 min', '13 h', '3 days' (short: '3 d') */
export function fmtDur(s, short = false) {
  if (s < H) return `${round(s / M)} min`;
  if (s < D) return `${round(s / H)} h`;
  const n = round(s / D);
  return short ? `${n} d` : `${n} day${n === 1 ? '' : 's'}`;
}

// ── the log ──

/** A central cycle with no error that had central take predictions, or had nothing to send. */
export const isGood = (r) => r.kind === 'central' && !r.data?.error && !(r.data?.sent > 0 && !(r.data?.accepted > 0));
const isFailed = (r) => r.kind === 'central' && !isGood(r);
const end = (r) => r.until ?? r.at;

/** The sessions ([at, until]) from the `open` rows, oldest first; the last one runs to `now`. */
export function sessionsOf(rows, now) {
  const opens = rows.filter((r) => r.kind === 'open');
  return opens.map((r, i) => ({ at: r.at, until: i === opens.length - 1 ? Math.max(now, end(r)) : end(r) }));
}

/** Seconds the app ran between `from` and `to`. */
export function openTime(sessions, from, to) {
  return sessions.reduce((n, s) => n + Math.max(0, Math.min(s.until, to) - Math.max(s.at, from)), 0);
}

/**
 * Whether a session starting at `at` missed work: the poll due after the last good cycle (+ 11 h) came while
 * nothing ran. gap: how long nothing ran before `at` (null before the first session).
 */
export function missedBy(rows, at) {
  const before = rows.filter((r) => r.at < at);
  const sessions = before.filter((r) => r.kind === 'open').map((r) => ({ at: r.at, until: end(r) }));
  const gap = sessions.length ? at - sessions.at(-1).until : null;
  const good = before.filter(isGood).at(-1);
  if (!good) return { missed: false, gap };
  const due = good.at + CADENCE_S;
  return { missed: due < at && !sessions.some((s) => s.at <= due && due <= s.until), gap };
}

// ── the reasons (docs/design/health.md#reasons-in-priority-order) ──

/**
 * What a failed cycle's row says failed, in words and as the chip says it: central refused the login, was not reached
 * at all (a network error, a timeout), took none of a batch or refused it (sending), or answered the poll with an error.
 */
function failedWhat(d) {
  if (d.login) return ['Login refused', 'Login refused'];
  if (d.unreachable) return ["Couldn't reach the Satori Network", 'Unreachable'];
  if (d.sent > 0) return ['Sending failed', 'Sending failed'];
  return ['The poll failed', 'Poll failed'];
}

const go = (tab, section) => (section ? { do: 'go', tab, section } : { do: 'go', tab });
const reason = (id, channel, o) => ({ id, status: LEVEL[id], channel, ...o });

function centralReasons({ now, rows, sessions, central, work }) {
  const out = [];
  const cycles = rows.filter((r) => r.kind === 'central');
  const last = cycles.at(-1);
  const lastGood = cycles.filter(isGood).at(-1);
  const failed = !!last && isFailed(last);
  const next = fmtIn((central?.nextPoll ?? now) - now);
  // "now" only while central's work runs (the poll, or its sign-in before it): a poll that is due with nothing running
  // (a timer that slept with the device) is "soon", until the catch-up pass runs it
  const atOnce = !!central?.polling || !!work?.central;
  // open time with nothing good: red once failures (or no tries) span a real cycle, not after two quick failures
  const since = lastGood?.at ?? sessions[0]?.at;
  const ran = since == null ? 0 : openTime(sessions, since, now);
  const overdue = ran > (lastGood ? WINDOW_S : FIRST_S);

  if (failed) {
    const d = last.data;
    const err = d.error ?? `The Satori Network took none of ${d.sent} predictions`;
    const [what, chip] = failedWhat(d);
    if (d.local) {
      out.push(reason('db-error', 'network', { line: 'The database failed.', chip: 'Database error',
        text: `Saving or forecasting failed: ${err}. Reload Satori; your keys are safe.`, button: 'Reload', act: { do: 'reload' } }));
    } else if (d.login) {
      out.push(reason('login-refused', 'network', { line: "The Satori Network refused this app's login.", chip: 'Login refused',
        text: "The Satori Network rejects this app's login. Check its address in Settings.", button: 'Open Settings', act: go('settings', 'central') }));
    } else if (overdue) {
      out.push(reason('central-failing', 'network', { line: `Nothing sent for ${fmtDur(ran)}: ${what[0].toLowerCase()}${what.slice(1)}.`, chip,
        text: `${err}. Nothing went out for ${fmtDur(ran)} while Satori was open. It keeps trying; try now, or check the Satori Network's address in Settings.`,
        button: 'Try again', act: { do: 'poll' } }));
    } else {
      out.push(reason('central-failed', 'network', { line: `${what}; ${central?.polling ? 'trying again now…' : `next try ${next}.`}`, chip,
        text: `${err}. It tries again ${next}; try now if something was fixed.`, button: 'Try again', act: { do: 'poll' } }));
    }
  }
  if (overdue && !out.some((r) => r.id === 'central-failing')) {
    out.push(reason('central-overdue', 'network', { line: `Nothing sent for ${fmtDur(ran)}.`, chip: `Nothing sent for ${fmtDur(ran)}`,
      text: `No predictions went out for ${fmtDur(ran)} while Satori was open. Try a poll now.`, button: 'Poll now', act: { do: 'poll' } }));
  }

  // register's wallet_address: 'other' or 'none'; false (it pays this wallet) and null (this central does not say) are fine
  const reg = central?.registration;
  if (reg?.ok && reg.walletMismatch) {
    const other = reg.walletMismatch === 'other';
    const refused = reg.walletLinkError ? ` It refused the wallet's link: ${reg.walletLinkError}.` : '';
    out.push(reason('wallet-mismatch', 'network', { chip: other ? 'Wallet mismatch' : 'Wallet not linked',
      line: other ? "The Satori Network pays this wallet's rewards to another address." : 'The Satori Network has no wallet linked to this app.',
      text: `${other ? `The Satori Network pays this wallet's rewards to a different Base address, ${reg.wallet_address}, not this wallet's ${reg.wallet}.`
        : 'The Satori Network has no wallet linked to this app, so it has no Base address to pay its rewards to.'}${refused}${FRESH_LINK}`,
      button: 'Link this wallet', act: { do: 'relink' } }));
  }
  if (reg && !reg.ok) {
    out.push(reason('not-registered', 'network', { line: "The Satori Network didn't register this app.", chip: 'Not registered',
      text: `Registering with the Satori Network failed: ${reg.error}. It registers again before each poll until it succeeds.`,
      button: 'Try again', act: { do: 'poll' } }));
  }

  // was asleep: the latest session that missed work, until the next normal cycle (the second good one after it)
  const woke = rows.filter((r) => r.kind === 'open' && r.data?.missed).at(-1);
  const after = woke ? cycles.filter((r) => isGood(r) && r.at >= woke.at) : [];
  if (woke && after.length < 2) {
    const closed = `Closed for ${fmtDur(woke.data.gap ?? 0)}.`;
    const caught = after[0];
    const catching = atOnce ? 'Catching up now…' : `Catching up ${next}`;
    out.push(reason('asleep', 'network', {
      line: caught ? `${closed} Caught up ${fmtAgo(now - caught.at)}.` : `${closed} ${catching}${atOnce ? '' : '.'}`,
      chip: caught ? null : catching }));
  }
  if (!lastGood && !failed && !overdue) {
    out.push(reason('starting', 'network', { line: atOnce ? 'Getting its first predictions…' : `First predictions ${next}.`,
      chip: atOnce ? 'First poll now…' : `First poll ${next}` }));
  }
  // central's part of the title, from the log, whichever reason leads (failing: a bad one above); healthOf adds Base's
  const title = out.some((r) => r.status === 'bad') ? 'Not predicting' : !lastGood ? 'Starting'
    : woke && !after.length ? 'Was asleep' : 'Predicting';
  return { out, lastGood, title };
}

function baseReasons({ rows, base }) {
  const out = [];
  if (!base) return out;
  const d = base.wallet?.staked;
  // in use: staked with this neuron, or a batch went out before (the stake may not be read: the RPC down since load)
  const inUse = d === 'alias' || !!base.lastBatch;
  const lastRow = rows.filter((r) => r.kind === 'base').at(-1);
  const repeated = lastRow?.level === 'bad' && lastRow.count >= 2;
  const check = base.lastCheck;
  const failingErr = base.error || check?.error;
  if (failingErr && !inUse) {
    // not used: nothing to predict or earn there, so a note on its chip (grey), never Home's colour (the review, 2026-10-19)
    out.push(reason('base-unused-unreachable', 'contract', { chip: 'Unreachable', // unused, its check fails only on the RPC
      line: `Can't reach Base: ${failingErr}. Not staked, so nothing is lost; the Wallet works once it answers.` }));
  } else if (failingErr) {
    if (repeated) {
      out.push(reason('base-failing', 'contract', { line: `The Satori contract batch failed ${lastRow.count} times.`, chip: `Failed ${lastRow.count} times`,
        text: `${failingErr}. Check the Base RPC in Settings.`, button: 'Open Settings', act: go('settings', 'base') }));
    } else {
      out.push(reason('base-unreachable', 'contract', { line: base.error ? "Can't reach Base." : 'The Satori contract batch failed.',
        chip: base.error ? 'Unreachable' : 'Batch failed', text: `${failingErr}. Check the Base RPC in Settings.`,
        button: 'Open Settings', act: go('settings', 'base') }));
    }
  }
  // a batch sent and not mined for STUCK_S: sent again with a higher fee (base.js), or waiting under the max fee
  const stuck = base.pendingBatch?.stuck;
  if (stuck) {
    out.push(stuck.ceiling
      ? reason('base-stuck', 'contract', { line: 'The Satori contract batch is stuck.', chip: 'Batch stuck',
        text: `The Satori contract batch is stuck: a higher fee (${stuck.fee} gwei) would pass the max fee (${stuck.max} gwei), so it waits. `
          + 'Raise the max fee in Settings.', button: 'Open Settings', act: go('settings', 'base') })
      : reason('base-stuck', 'contract', { line: 'The Satori contract batch is stuck; retrying with a higher fee.', chip: 'Batch stuck',
        text: `The Satori contract batch was not mined for 10 min, so it was sent again with a higher fee (${stuck.fee} gwei), within the max fee. `
          + 'It keeps checking.' }));
  }
  if (base.error || !base.config) return out;
  // advice: the card offers it; the chip keeps the plain "Not staked" (off)
  if (d === 'none' && Number(base.wallet.satori) > 0) {
    out.push(reason('stake', 'contract', { text: "Stake with this app to earn on the Satori contract. While staked, your SATORI can't be "
      + 'sent until you unstake.',
    button: 'Stake', act: { do: 'stake' } }));
  }
  // staked with another address (another app's alias: a new phone, a restore): Stake moves it here in one step
  if (d === 'other') {
    out.push(reason('staked-elsewhere', 'contract', { text: "Your wallet is staked with another address, so this app doesn't send "
      + 'its predictions to the Satori contract. Stake with this app to move the stake here.', button: 'Stake here', act: { do: 'stake' } }));
  }
  // the wallet is the alias's only staker, and its SATORI is more than the power booked: unstaking underflows until the fix
  if (d === 'alias' && base.wallet?.inSync === false) {
    out.push(reason('stake-out-of-sync', 'contract', { line: 'Staking is out of sync.', chip: 'Out of sync',
      text: "Unstaking will fail until the contract fix. Don't add SATORI to the wallet." }));
  }
  if (d === 'alias' && base.alias?.lowEth) {
    const n = base.alias.batchesLeft;
    out.push(reason('gas-low', 'contract', { line: 'Gas for the daily batch is running low.', chip: `Gas: ${n} batch${n === 1 ? '' : 'es'}`,
      text: `The app has gas for about ${n} daily batch${n === 1 ? '' : 'es'}. Send a little Base ETH to its alias, on the Wallet tab.`,
      button: 'Add gas', act: go('wallet') }));
  }
  if (d === 'alias' && check?.skipped && FIXABLE_SKIPS.test(check.skipped) && (check.round == null || check.round === base.round)) {
    const why = check.skipped.split(':')[0];
    const gas = why.startsWith('gas');
    out.push(reason('base-skipped', 'contract', { line: 'The Satori contract batch was skipped.', chip: `Skipped: ${why}`,
      text: gas ? `Satori contract batch skipped: ${check.skipped}.` : `Satori contract batch skipped: ${skipText(check)}. The next check tries again.`,
      button: gas ? 'Open Settings' : 'Open Wallet',
      act: gas ? go('settings', 'base') : go('wallet') }));
  }
  return out;
}

/**
 * A relay that is down: not open for RELAY_GRACE_S (its reconnects get that long; downSince, ms, from src/nostr/relay.js),
 * or closed when it does not say since when. A blocked one (ws:// on an https page) is neither down nor counted.
 */
const relayDown = (r, now) => r.state !== 'open' && (r.downSince == null ? r.state === 'closed' : now - r.downSince / 1000 >= RELAY_GRACE_S);
/** The relays that count: not blocked (ws:// on an https page can never open there). */
export const usableRelays = (nostr) => (nostr?.relays ?? []).filter((r) => r.state !== 'blocked');

function networkReasons({ nostr, now }) {
  const out = [];
  if (!nostr?.subscriptions?.length) return out;
  const relays = usableRelays(nostr);
  const down = relays.filter((r) => relayDown(r, now));
  if (!relays.length || down.length === relays.length) {
    out.push(reason('relays-down', 'relays', { line: 'Every relay is down.', chip: 'Relays down',
      text: "No relay is connected, so subscribed streams aren't predicted. Check the relays in Settings.",
      button: 'Open Settings', act: go('settings', 'relays') }));
  } else if (down.length) {
    out.push(reason('relay-down', 'relays', { chip: `${down.length} of ${relays.length} relays down`,
      text: `${down.map((r) => r.url).join(', ')} not connected; it keeps retrying. Check the relays in Settings.`,
      button: 'Open Settings', act: go('settings', 'relays') }));
  }
  return out;
}

/** How each browser without an install prompt adds Satori (docs/design/pwa.md#install): the card's words. */
const STARTS_EMPTY = 'The added app starts empty: set it up there, or restore it from your 24 words.';
export const ADD_TO = {
  ios: `Add it to your Home Screen (Share › Add to Home Screen): it opens on its own screen and keeps your keys. ${STARTS_EMPTY}`,
  mac: `Add it to the Dock (File › Add to Dock): it stays open in its own window and keeps your keys. ${STARTS_EMPTY}`,
  android: "Add it to your Home screen (the browser's menu › Add app to Home screen): it opens in its own window.",
};
const WORKS_WHILE_OPEN = "Satori works while it's open.";

/**
 * Install, as advice, once (docs/design/pwa.md#install): wherever this browser can add Satori (its prompt, or the
 * steps where it has none) and it is not installed, until the person installs it or puts the card away (Not now,
 * Got it: installDismissed, kept on this device).
 */
function installReason({ app, installDismissed }) {
  if (!app || app.installed || installDismissed) return [];
  if (app.canInstall) {
    return [reason('install', null, { text: `${WORKS_WHILE_OPEN} Install it: it stays open in its own window, and keeps your keys.`,
      button: 'Install', act: { do: 'install' }, dismiss: 'Not now' })];
  }
  if (ADD_TO[app.addTo]) return [reason('install', null, { text: `${WORKS_WHILE_OPEN} ${ADD_TO[app.addTo]}`, button: 'Got it', act: { do: 'dismiss' } })];
  return [];
}

// ── the tone: the colour Home shows (docs/design/health.md#the-tone) ──

/**
 * warn and bad win; else green: 'critical' (vivid: closing now would lose work), 'working' (regular), or 'idle' (sky:
 * all good, waiting for the next cycle). Never gray: starting and catching up are working. ('off', gray, is only a
 * channel deliberately not used.)
 */
export const toneOf = (status, work) => (status === 'warn' || status === 'bad' ? status
  : work ? (work.critical ? 'critical' : 'working') : 'idle');

/**
 * The channels, by the words people see (docs/intent/ui.md, 2026-10-18): `network` the Satori Network (central, free to
 * submit to), `contract` the Satori contract (Base, uses gas), `relays` the Satori relays (Nostr). Each one's work:
 * central's poll; the batch and the wallet's actions; discover and subscribe. TRAFFIC: each one's traffic channel
 * (src/traffic.js keeps the code's names).
 */
const CHANNEL_WORK = { network: ['central'], contract: ['base', 'stake', 'unstake', 'claim', 'send'], relays: ['discover', 'subscribe', 'watch'] };
export const TRAFFIC = { network: 'central', contract: 'base', relays: 'network' };
/** A traffic channel's chip (src/traffic.js's name → the channel's). */
export const CHIP_OF = Object.fromEntries(Object.entries(TRAFFIC).map(([chip, t]) => [t, chip]));

// ── the channels (chips) ──

/** The last good cycle in a few words: what central took, or, with nothing to send, up to date (never "0 sent"). */
const sentText = (lg, now, next) => (lg.data.accepted > 0 ? `${lg.data.accepted} sent ${fmtAgo(now - lg.at)}` : `Up to date · next ${next}`);

function chips({ now, next, reasons, lastGood, base, nostr, traffic, work = {} }) {
  const top = (channel) => reasons.find((r) => r.channel === channel && r.chip);
  const sent = lastGood ? sentText(lastGood, now, next) : '–';
  const c = top('network');
  const central = c ? { state: c.status, text: c.chip } : { state: lastGood ? 'ok' : 'idle', text: sent };

  const b = top('contract');
  let baseChip;
  if (b) baseChip = { state: b.status, text: b.chip, off: b.status === 'note' }; // a note: a channel not used, grey
  else if (!base?.config) baseChip = { state: 'idle', text: 'Connecting…', busy: true };
  else if (base.play === 'manual' && base.wallet?.staked !== 'other') { // the Game tab sends, staked or not: green once played this round
    baseChip = base.lastPlay?.round === base.round || base.lastBatch?.round === base.round ? { state: 'ok', text: 'Played today' }
      : { state: 'idle', text: 'Not played today', off: true };
  }
  else if (base.wallet?.staked === 'other') baseChip = { state: 'idle', text: 'Staked elsewhere', off: true };
  else if (base.wallet?.staked !== 'alias') baseChip = { state: 'idle', text: 'Not staked', off: true };
  else if (!(Number(base.alias?.power) > 0)) baseChip = { state: 'idle', text: 'No SATORI staked', off: true };
  else if (base.lastBatch?.round === base.round) baseChip = { state: 'ok', text: `Round ${base.round} sent` };
  else baseChip = { state: 'ok', text: base.checking ? 'Sending…' : `Round ${base.round} due` };

  const n = top('relays');
  // watching prediction streams (the track record, docs/design/track-record.md#home) is use of the relays, but predicts
  // nothing: "Watching 112", and with every relay down the chip alone says so (no reason: the hero is the predicting's)
  const watched = nostr?.watching?.streams ?? 0;
  const allDown = () => { const r = usableRelays(nostr); return !r.length || r.every((x) => relayDown(x, now)); };
  const relays = n ? { state: n.status, text: n.chip }
    : nostr?.subscriptions?.length ? { state: 'ok', text: `${usableRelays(nostr).length} relay${usableRelays(nostr).length === 1 ? '' : 's'}` }
      : watched > 0 ? (allDown() ? { state: 'warn', text: 'Relays down' } : { state: 'ok', text: `Watching ${watched}` })
        : { state: 'idle', text: 'No streams', off: true };
  // the tone: warn and bad as they are; working (its channel has work in progress, or is connecting); off (deliberately
  // not used: Base not staked here, no stream subscribed); else idle (sky: healthy, waiting). Advice is calm: its
  // words, a green tone.
  const toned = (key, { off, busy, ...chip }) => {
    const working = busy || CHANNEL_WORK[key].some((t) => work[t]);
    const tone = chip.state === 'warn' || chip.state === 'bad' ? chip.state : working ? 'working' : off ? 'off' : 'idle';
    return { state: chip.state, tone, text: chip.text, ...(traffic ? { lastTraffic: traffic[TRAFFIC[key]] ?? null } : {}) }; // ms; the glow's
  };
  return { network: toned('network', central), contract: toned('contract', baseChip), relays: toned('relays', relays) };
}

// ── the day strip ──

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** What a row says about a channel: ['network' | 'contract' | 'relays', 'ok' | 'fail'], or null. */
function outcome(r) {
  if (r.kind === 'central') return ['network', isGood(r) ? 'ok' : 'fail'];
  if (r.kind === 'base') {
    if (r.data?.unused) return null; // the contract not used: its RPC's trouble is no failure (docs/design/health.md#the-day-strip)
    return r.level === 'ok' ? ['contract', 'ok'] : r.level === 'bad' || r.level === 'warn' ? ['contract', 'fail'] : null;
  }
  if (r.kind === 'nostr') return ['relays', 'ok'];
  if (r.kind === 'error') return [r.data?.where === 'nostr' ? 'relays' : 'network', 'fail'];
  return null;
}

/** A half of a day: ok (it worked), part (it worked, and failed too), error (it only failed), none. */
const halfOf = (ok, fail) => (ok ? (fail ? 'part' : 'ok') : fail ? 'error' : 'none');

/**
 * The last `n` local days, oldest first: { date, code: full | part | error | closed | before, ran, today, network,
 * contract }. `before`: the day ended before the neuron began, its first session or `since` (the keys' creation, the
 * log's first session) when earlier. network and contract: each a half of the day's cell (halfOf): the Satori
 * Network's scoring off-chain, the Satori contract's on-chain (a batch sent, or the game played by hand).
 */
export function daysOf(rows, now, since = null, n = DAYS) {
  const sessions = sessionsOf(rows, now);
  const known = [since, sessions[0]?.at].filter(Number.isFinite);
  const born = known.length ? Math.min(...known) : -Infinity; // nothing known: no day is before
  const today = new Date(now * 1000);
  today.setHours(0, 0, 0, 0);
  const out = [];
  for (let k = n - 1; k >= 0; k--) {
    const start = new Date(today);
    start.setDate(today.getDate() - k);
    const stop = new Date(start);
    stop.setDate(start.getDate() + 1);
    const [a, b] = [start.getTime() / 1000, stop.getTime() / 1000];
    const ok = new Set();
    const fail = new Set();
    for (const r of rows) {
      const o = outcome(r);
      if (o && r.at < b && end(r) >= a) (o[1] === 'ok' ? ok : fail).add(o[0]);
    }
    const code = ok.size ? ([...fail].every((c) => ok.has(c)) ? 'full' : 'part') : fail.size ? 'error' : b <= born ? 'before' : 'closed';
    const played = rows.some((r) => r.kind === 'wallet' && r.data?.action === 'play' && r.at >= a && r.at < b);
    out.push({ date: isoDay(start), code, ran: sessions.some((s) => s.at < b && s.until >= a), today: k === 0,
      network: halfOf(ok.has('network'), fail.has('network')), contract: halfOf(ok.has('contract') || played, fail.has('contract')) });
  }
  return out;
}

// ── the feed ──

const times = (r) => (r.count > 1 ? ` (×${r.count})` : '');
/**
 * An address change in words: 'Satori Network address changed to https://…', 'Base RPC changed to the default,
 * https://…', 'Reward address set to 0x…' (the whole address: a swap is seen), 'Reward address cleared: …'.
 */
const settingText = (d) => {
  if (d.what === 'reward') return d.to ? `Reward address set to ${d.to}` : 'Reward address cleared: rewards go to your wallet';
  const to = d.to || (d.default ? `the default, ${d.default}` : 'the default');
  return d.what === 'rpc' ? `Base RPC changed to ${to}` : `Satori Network address changed to ${to}`;
};
const games = (n) => `${n} game${n === 1 ? '' : 's'}`;

function feedText(r) {
  const d = r.data ?? {};
  switch (r.kind) {
    case 'open': return d.missed ? `Satori was closed for ${fmtDur(d.gap ?? 0, true)}` : null;
    case 'central':
      if (d.local) return `Saving or forecasting failed: ${d.error}`;
      if (d.login) return `The Satori Network refused the login: ${d.error}`;
      if (d.error) return `${d.sent > 0 ? 'The Satori Network refused the batch' : 'The poll failed'}: ${d.error}`;
      if (d.sent > 0 && !(d.accepted > 0)) return `The Satori Network took none of ${d.sent} predictions`;
      if (d.caughtUp != null) return d.accepted > 0 ? `Caught up: sent ${d.accepted} predictions` : 'Caught up: up to date';
      return d.accepted > 0 ? `Sent ${d.accepted} predictions to the Satori Network` : 'Checked the Satori Network: up to date';
    case 'history': return d.error ? `History not loaded: ${d.error}` : `History loaded for ${d.streams} streams`;
    case 'base':
      if (d.error && d.unused) return `Couldn't reach the Satori contract (not staked): ${d.error}${times(r)}`;
      if (d.error) return `Satori contract batch failed: ${d.error}${times(r)}`;
      if (d.stuck) {
        return `Satori contract batch stuck: ${d.stuck.ceiling ? `a higher fee (${d.stuck.fee} gwei) would pass the max fee`
          : `sent again with a higher fee (${d.stuck.fee} gwei)`}${times(r)}`;
      }
      if (d.skipped) return `Satori contract batch skipped: ${d.skipped.split(':')[0]}${times(r)}`;
      return `Satori contract batch for round ${d.round}: ${games(d.games?.length ?? 0)}`;
    case 'nostr': return `Published ${d.published} forecast${d.published === 1 ? '' : 's'} to the Satori relays`;
    case 'wallet': return d.text;
    case 'setting': return settingText(d);
    case 'config': return `The Satori Network's contract addresses differ from the app's (${(d.keys ?? []).join(', ')}): the app's are used${times(r)}`;
    case 'error': return `${d.where === 'nostr' ? 'A relay forecast failed' : 'Something failed'}: ${d.message}`;
    default: return null;
  }
}

/** The log, newest first (by when each happened: a cycle is logged when it ends, at its start), `n` rows. */
export function feedOf(rows, n = FEED) {
  const out = [];
  const sorted = rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => b.at - a.at || j - i).map(([r]) => r);
  for (const r of sorted) {
    if (out.length >= n) break;
    const text = feedText(r);
    if (text) out.push({ at: r.at, level: r.level, text });
  }
  return out;
}

/**
 * The address changes of the last 24 h, newest first: Home's quiet notes and health().notices (the security review,
 * 2026-10-19: a central or an RPC swapped by Settings or an agent is seen).
 */
export const noticesOf = (rows, now) => rows.filter((r) => r.kind === 'setting' && now - r.at < NOTICE_S)
  .sort((a, b) => b.at - a.at).map((r) => ({ at: r.at, what: r.data?.what, text: settingText(r.data ?? {}) }));

// ── it all ──

/**
 * @param {object} o
 * @param {number} o.now unix seconds
 * @param {object[]} o.rows the activity log, oldest first (db.activity)
 * @param {object} o.central status().central; o.base status().base; o.nostr status().nostr
 * @param {{persisted: boolean}|null} o.storage
 * @param {{installed: boolean, canInstall: boolean, addTo?: string|null}} o.app
 * @param {boolean} [o.installDismissed] the Install card was put away on this device (Not now, Got it)
 * @param {boolean} o.backedUp the wallet's words confirmed (meta.backup_at)
 * @param {number|null} o.since when the neuron began, if earlier than the rows show: the keys' creation, the log's first session
 * @param {{central, base, network}} [o.traffic] each traffic channel's last traffic, ms (src/traffic.js): channels[x].lastTraffic
 * @param {Object<string, object>} [o.work] the work in progress, { [task]: entry } (src/neuron/work.js): the tones, `work`
 * @returns {{status, tone, title, line, action, days, channels, feed, reasons, work, notices}}
 */
export function healthOf({ now, rows = [], central, base, nostr, storage, app, backedUp, installDismissed = false, since = null, traffic, work = {} }) {
  const sessions = sessionsOf(rows, now);
  const c = centralReasons({ now, rows, sessions, central, work });
  const reasons = [...c.out, ...baseReasons({ rows, base }), ...networkReasons({ nostr, now }), ...installReason({ app, installDismissed })];
  if (storage && storage.persisted === false && !backedUp) {
    reasons.push(reason('backup', null, {
      text: 'This browser may clear Satori’s storage, your keys with it. Back up your wallet’s 24 words.', button: 'Back up', act: { do: 'backup' } }));
  }
  reasons.sort((a, b) => PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id));
  const told = reasons.filter((r) => r.status !== 'advice' && r.status !== 'note'); // what the hero says: advice is the card's, a note the chip's
  const status = told[0]?.status ?? 'ok'; // the worst: PRIORITY is by level
  // The title: is the neuron predicting on the channels that pay? Central (Not predicting wins), and Base when it should
  // be predicting: staked with this neuron, or not read (its RPC down) after a batch went out. Nostr never moves it.
  const d = base?.wallet?.staked;
  const baseRed = (d === 'alias' || (d == null && !!base?.lastBatch)) && reasons.some((r) => r.id === 'base-failing'); // the batch fails
  const title = baseRed && c.lastGood && c.title !== 'Not predicting' ? 'Partly predicting' : c.title;
  const top = told[0];
  const centralTop = told.find((r) => r.channel === 'network');

  let line;
  const lg = c.lastGood;
  const next = central?.polling ? 'now…' : fmtIn((central?.nextPoll ?? now) - now);
  if (!top) { // no reason but advice: a good cycle is in the log
    line = lg.data.accepted > 0 ? `Sent ${lg.data.accepted} predictions ${fmtAgo(now - lg.at)} · next ${next}` : sentText(lg, now, next);
  } else {
    line = top.channel === 'network' || centralTop ? top.line : `The Satori Network is fine. ${top.line}`;
  }

  // the card: the highest reason with words for it, most with a button (one without: what to know, nothing to press)
  const a = reasons.find((r) => r.text);
  const action = a ? { id: a.id, text: a.text, ...(a.act ? { button: a.button, ...a.act } : {}), ...(a.dismiss ? { dismiss: a.dismiss } : {}) } : null;
  const doing = leading(work);
  return {
    status, tone: toneOf(status, leading(work, HERO)), title, line, action,
    days: daysOf(rows, now, since),
    channels: chips({ now, next, reasons, lastGood: lg, base, nostr, traffic, work }),
    feed: feedOf(rows),
    reasons: reasons.map((r) => ({ id: r.id, status: r.status, channel: r.channel, text: r.text ?? r.line })),
    work: doing && { ...doing, text: workText(doing) },
    notices: noticesOf(rows, now),
  };
}
