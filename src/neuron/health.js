// Home's answer to "is my neuron predicting every day on its own, and is
// anything broken?" (docs/design/health.md): the activity log and the current
// state in, one object out. Pure: the UI and window.satori.health() draw the same.
import { POLL_EVERY_S } from './index.js';

export const CADENCE_S = POLL_EVERY_S; // 11 h, Lite's
export const GRACE_S = 3600;
export const WINDOW_S = CADENCE_S + GRACE_S; // open time a good cycle may take after the last one
export const FIRST_S = GRACE_S; // … and the first one (it polls at once)
export const HEARTBEAT_S = 300;
export const SLEEP_S = 900; // a heartbeat this late: the page did not run (closed, asleep, frozen)
export const KEEP_S = 90 * 86400;
export const DAYS = 30;
export const FEED = 20;

/** The reasons, highest first: the status is the worst, the card the first with an action. */
export const PRIORITY = ['db-error', 'login-refused', 'central-failing', 'central-overdue', 'base-failing', 'relays-down',
  'central-failed', 'backup', 'vault-mismatch', 'not-registered', 'delegate', 'gas-low', 'base-skipped', 'base-unreachable',
  'relay-down', 'asleep', 'starting'];
const RANK = { ok: 0, idle: 1, warn: 2, bad: 3 };
export const FIXABLE_SKIPS = /^(gas above the ceiling|no game passes its simulation)/;

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
/** 'now', 'in 12 min', 'in 9 h' */
export function fmtIn(s) {
  if (s <= 0) return 'now';
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

const go = (tab, section) => (section ? { do: 'go', tab, section } : { do: 'go', tab });
const reason = (id, status, channel, o) => ({ id, status, channel, ...o });

function centralReasons({ now, rows, sessions, central, app }) {
  const out = [];
  const cycles = rows.filter((r) => r.kind === 'central');
  const last = cycles.at(-1);
  const lastGood = cycles.filter(isGood).at(-1);
  let failures = 0;
  for (let i = cycles.length - 1; i >= 0 && isFailed(cycles[i]); i--) failures++;
  const next = fmtIn((central?.nextPoll ?? now) - now);
  const atOnce = !!central?.polling || !(central?.nextPoll > now); // polling, due, or not armed yet (registering first)

  if (failures) {
    const err = last.data.error ?? `central took none of ${last.data.sent} predictions`;
    const batches = last.data.sent > 0;
    if (last.data.local) {
      out.push(reason('db-error', 'bad', 'central', { line: 'The database failed.', chip: 'Database error',
        text: `Saving or forecasting failed: ${err}. Reload Satori; your keys are safe.`, button: 'Reload', act: { do: 'reload' } }));
    } else if (last.data.login) {
      out.push(reason('login-refused', 'bad', 'central', { line: "Central refused this neuron's login.", chip: 'Login refused',
        text: "Central rejects this neuron's login. Check the central address in Settings.", button: 'Open Settings', act: go('settings', 'central') }));
    } else if (failures >= 2) {
      out.push(reason('central-failing', 'bad', 'central', {
        line: batches ? `Central refused the last ${failures} batches.` : `The last ${failures} polls failed.`,
        chip: `${failures} failed in a row`, text: `${err}. Try again now, or check the central address in Settings.`,
        button: 'Try again', act: { do: 'poll' } }));
    } else {
      out.push(reason('central-failed', 'warn', 'central', { line: `The last poll failed; next try ${next}.`,
        chip: 'Last poll failed', text: `${err}. It tries again on its own; try now if something was fixed.`,
        button: 'Try again', act: { do: 'poll' } }));
    }
  }

  const since = lastGood?.at ?? sessions[0]?.at;
  const ran = since == null ? 0 : openTime(sessions, since, now);
  const overdue = ran > (lastGood ? WINDOW_S : FIRST_S);
  if (overdue) {
    out.push(reason('central-overdue', 'bad', 'central', { line: `Nothing sent for ${fmtDur(ran)}.`, chip: `Nothing sent for ${fmtDur(ran)}`,
      text: `No predictions went out for ${fmtDur(ran)} while Satori was open. Try a poll now.`, button: 'Poll now', act: { do: 'poll' } }));
  }

  // register's vault_base_address: 'other' or 'none'; false (it pays this vault) and null (this central does not say) are fine
  const reg = central?.registration;
  if (reg?.ok && reg.vaultMismatch) {
    const other = reg.vaultMismatch === 'other';
    out.push(reason('vault-mismatch', 'warn', 'central', { chip: 'Vault mismatch',
      line: other ? "Central pays this vault's rewards to another address." : 'Central has no vault for this neuron.',
      text: `${other ? `Central pays this vault's rewards to a different Base address, ${reg.vault_base_address}, not this vault's ${reg.vault}.`
        : "Central kept no vault for this identity, so it has no Base address to pay this neuron's rewards to (the vault may be registered to another neuron)."
      } Check the keys in Settings.`,
      button: 'Open Settings', act: go('settings', 'keys') }));
  }
  if (reg && !reg.ok) {
    out.push(reason('not-registered', 'warn', 'central', { line: "Central didn't register this neuron.", chip: 'Not registered',
      text: `Registering with central failed: ${reg.error}. It registers again on the next load.`, button: 'Reload', act: { do: 'reload' } }));
  }

  // was asleep: the latest session that missed work, until the next normal cycle (the second good one after it)
  const woke = rows.filter((r) => r.kind === 'open' && r.data?.missed).at(-1);
  const after = woke ? cycles.filter((r) => isGood(r) && r.at >= woke.at) : [];
  if (woke && after.length < 2) {
    const closed = `Closed for ${fmtDur(woke.data.gap ?? 0)}.`;
    const caught = after[0];
    const install = app?.canInstall && !app?.installed;
    const catching = atOnce ? 'Catching up now…' : `Catching up ${next}`;
    out.push(reason('asleep', 'idle', 'central', {
      line: caught ? `${closed} Caught up ${fmtAgo(now - caught.at)}.` : `${closed} ${catching}${atOnce ? '' : '.'}`,
      chip: caught ? null : catching,
      ...(install ? { text: 'The neuron only runs while Satori is open. Install it so it stays open in its own window.',
        button: 'Install', act: { do: 'install' } } : {}) }));
  }
  if (!lastGood && !failures && !overdue) {
    out.push(reason('starting', 'idle', 'central', { line: atOnce ? 'Getting its first predictions…' : `First predictions ${next}.`,
      chip: atOnce ? 'First poll now…' : `First poll ${next}` }));
  }
  // the title: the truth about central's predictions, from the log, whichever reason leads (failing: a bad one above)
  const title = out.some((r) => r.status === 'bad') ? 'Not predicting' : !lastGood ? 'Starting'
    : woke && !after.length ? 'Was asleep' : 'Predicting';
  return { out, lastGood, title };
}

function baseReasons({ rows, base }) {
  const out = [];
  if (!base) return out;
  const d = base.vault?.delegated;
  const inUse = d === 'identity' || !!base.lastBatch;
  const lastRow = rows.filter((r) => r.kind === 'base').at(-1);
  const repeated = lastRow?.level === 'bad' && lastRow.count >= 2;
  const check = base.lastCheck;
  const failingErr = base.error || check?.error;
  if (failingErr) {
    if (inUse && repeated) {
      out.push(reason('base-failing', 'bad', 'base', { line: `The Base batch failed ${lastRow.count} times.`, chip: `Failed ${lastRow.count} times`,
        text: `${failingErr}. Check the Base RPC in Settings.`, button: 'Open Settings', act: go('settings', 'base') }));
    } else {
      out.push(reason('base-unreachable', 'warn', 'base', { line: base.error ? "Can't reach Base." : 'The Base batch failed.',
        chip: base.error ? 'Unreachable' : 'Batch failed', text: `${failingErr}. Check the Base RPC in Settings.`,
        button: 'Open Settings', act: go('settings', 'base') }));
    }
  }
  if (base.error || !base.config) return out;
  if (d === 'none' && Number(base.vault.satori) > 0) {
    out.push(reason('delegate', 'warn', 'base', { line: 'Base needs one step from you.', chip: 'Not delegated',
      text: 'Base predictions are off. Delegate your vault’s prediction power to this neuron.', button: 'Delegate', act: { do: 'delegate' } }));
  }
  if (d === 'identity' && base.identity?.lowEth) {
    const n = base.identity.batchesLeft;
    out.push(reason('gas-low', 'warn', 'base', { line: "The identity's gas is running low.", chip: `Gas: ${n} batch${n === 1 ? '' : 'es'}`,
      text: `The identity has gas for about ${n} daily batch${n === 1 ? '' : 'es'}. Send it a little Base ETH.`,
      button: 'Add gas', act: go('wallet') }));
  }
  if (d === 'identity' && check?.skipped && FIXABLE_SKIPS.test(check.skipped) && (check.round == null || check.round === base.round)) {
    const why = check.skipped.split(':')[0];
    const gas = why.startsWith('gas');
    out.push(reason('base-skipped', 'warn', 'base', { line: 'The Base batch was skipped.', chip: `Skipped: ${why}`,
      text: `Base batch skipped: ${check.skipped}.`, button: gas ? 'Open Settings' : 'Open Wallet',
      act: gas ? go('settings', 'base') : go('wallet') }));
  }
  return out;
}

function networkReasons({ nostr }) {
  const out = [];
  if (!nostr?.subscriptions?.length) return out;
  const relays = nostr.relays ?? [];
  const down = relays.filter((r) => r.state === 'closed' || r.state === 'blocked');
  if (!relays.length || down.length === relays.length) {
    out.push(reason('relays-down', 'bad', 'network', { line: 'Every relay is down.', chip: 'Relays down',
      text: "No relay is connected, so subscribed streams aren't predicted. Check the relays in Settings.",
      button: 'Open Settings', act: go('settings', 'relays') }));
  } else if (down.length) {
    out.push(reason('relay-down', 'warn', 'network', { line: `${down.length} of ${relays.length} relays down.`,
      chip: `${down.length} of ${relays.length} relays down`,
      text: `${down.map((r) => r.url).join(', ')} not connected; it keeps retrying. Check the relays in Settings.`,
      button: 'Open Settings', act: go('settings', 'relays') }));
  }
  return out;
}

// ── the channels (chips) ──

function chips({ now, reasons, lastGood, base, nostr, traffic }) {
  const top = (channel) => reasons.find((r) => r.channel === channel && r.chip);
  const sent = lastGood ? `${lastGood.data.accepted ?? 0} sent ${fmtAgo(now - lastGood.at)}` : '–';
  const c = top('central');
  const central = c ? { state: c.status, text: c.chip } : { state: lastGood ? 'ok' : 'idle', text: sent };

  const b = top('base');
  let baseChip;
  if (b) baseChip = { state: b.status, text: b.chip };
  else if (!base?.config) baseChip = { state: 'idle', text: 'Connecting…' };
  else if (base.vault?.delegated === 'other') baseChip = { state: 'idle', text: 'Delegated elsewhere' };
  else if (base.vault?.delegated !== 'identity') baseChip = { state: 'idle', text: 'Not delegated' };
  else if (!(Number(base.identity?.power) > 0)) baseChip = { state: 'idle', text: 'No SATORI delegated' };
  else if (base.lastBatch?.round === base.round) baseChip = { state: 'ok', text: `Round ${base.round} sent` };
  else baseChip = { state: 'ok', text: base.checking ? 'Sending…' : `Round ${base.round} due` };

  const n = top('network');
  const network = n ? { state: n.status, text: n.chip }
    : nostr?.subscriptions?.length ? { state: 'ok', text: `${(nostr.relays ?? []).length} relay${(nostr.relays ?? []).length === 1 ? '' : 's'}` }
      : { state: 'idle', text: 'No streams' };
  const live = (key, chip) => (traffic ? { ...chip, lastTraffic: traffic[key] ?? null } : chip); // ms; the glow's
  return { central: live('central', central), base: live('base', baseChip), network: live('network', network) };
}

// ── the day strip ──

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** What a row says about a channel: ['central' | 'base' | 'network', 'ok' | 'fail'], or null. */
function outcome(r) {
  if (r.kind === 'central') return ['central', isGood(r) ? 'ok' : 'fail'];
  if (r.kind === 'base') return r.level === 'ok' ? ['base', 'ok'] : r.level === 'bad' || r.level === 'warn' ? ['base', 'fail'] : null;
  if (r.kind === 'nostr') return ['network', 'ok'];
  if (r.kind === 'error') return [r.data?.where === 'nostr' ? 'network' : 'central', 'fail'];
  return null;
}

/**
 * The last `n` local days, oldest first: { date, code: full | part | error | closed | before, ran, today }. `before`:
 * the day ended before the neuron began, its first session or `since` (the keys' creation, the log's first session)
 * when earlier.
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
    out.push({ date: isoDay(start), code, ran: sessions.some((s) => s.at < b && s.until >= a), today: k === 0 });
  }
  return out;
}

// ── the feed ──

const times = (r) => (r.count > 1 ? ` (×${r.count})` : '');
const games = (n) => `${n} game${n === 1 ? '' : 's'}`;

function feedText(r) {
  const d = r.data ?? {};
  switch (r.kind) {
    case 'open': return d.missed ? `Satori was closed for ${fmtDur(d.gap ?? 0, true)}` : null;
    case 'central':
      if (d.local) return `Saving or forecasting failed: ${d.error}`;
      if (d.login) return `Central refused the login: ${d.error}`;
      if (d.error) return `${d.sent > 0 ? 'Central refused the batch' : 'The poll failed'}: ${d.error}`;
      if (d.sent > 0 && !(d.accepted > 0)) return `Central took none of ${d.sent} predictions`;
      if (d.caughtUp != null) return `Caught up: sent ${d.accepted ?? 0} predictions`;
      return d.accepted > 0 ? `Sent ${d.accepted} predictions to central` : 'Polled central: nothing new';
    case 'history': return d.error ? `History not loaded: ${d.error}` : `History loaded for ${d.streams} streams`;
    case 'base':
      if (d.error) return `Base batch failed: ${d.error}${times(r)}`;
      if (d.skipped) return `Base batch skipped: ${d.skipped.split(':')[0]}${times(r)}`;
      return `Base batch for round ${d.round}: ${games(d.games?.length ?? 0)}`;
    case 'nostr': return `Published ${d.published} forecast${d.published === 1 ? '' : 's'} to the network`;
    case 'wallet': return d.text;
    case 'error': return `${d.where === 'nostr' ? 'A network forecast failed' : 'Something failed'}: ${d.message}`;
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

// ── it all ──

/**
 * @param {object} o
 * @param {number} o.now unix seconds
 * @param {object[]} o.rows the activity log, oldest first (db.activity)
 * @param {object} o.central status().central; o.base status().base; o.nostr status().nostr
 * @param {{persisted: boolean}|null} o.storage
 * @param {{installed: boolean, canInstall: boolean}} o.app
 * @param {boolean} o.backedUp the vault's words confirmed (meta.backup_at)
 * @param {number|null} o.since when the neuron began, if earlier than the rows show: the keys' creation, the log's first session
 * @param {{central, base, network}} [o.traffic] each channel's last traffic, ms (src/traffic.js): channels[x].lastTraffic
 * @returns {{status, title, line, action, days, channels, feed, reasons}}
 */
export function healthOf({ now, rows = [], central, base, nostr, storage, app, backedUp, since = null, traffic }) {
  const sessions = sessionsOf(rows, now);
  const c = centralReasons({ now, rows, sessions, central, app });
  const reasons = [...c.out, ...baseReasons({ rows, base }), ...networkReasons({ nostr })];
  if (storage && storage.persisted === false && !backedUp) {
    reasons.push(reason('backup', 'warn', null, { line: 'Back up your keys.',
      text: 'This browser may clear Satori’s storage, your keys with it. Back up your vault’s 24 words.', button: 'Back up', act: { do: 'backup' } }));
  }
  reasons.sort((a, b) => PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id));
  const status = reasons.reduce((s, r) => (RANK[r.status] > RANK[s] ? r.status : s), 'ok');
  const top = reasons[0];
  const centralTop = reasons.find((r) => r.channel === 'central');

  let line;
  const lg = c.lastGood;
  if (!top) {
    const next = central?.polling ? 'now…' : fmtIn((central?.nextPoll ?? now) - now);
    line = lg?.data.accepted > 0 ? `Sent ${lg.data.accepted} predictions ${fmtAgo(now - lg.at)} · next ${next}`
      : `Polled central ${fmtAgo(now - (lg?.at ?? now))}, nothing new · next ${next}`;
  } else {
    line = top.channel === 'central' || centralTop ? top.line : `Central is fine. ${top.line}`;
  }

  const a = reasons.find((r) => r.act);
  const action = a ? { id: a.id, text: a.text, button: a.button, ...a.act } : null;
  return {
    status, title: c.title, line, action,
    days: daysOf(rows, now, since),
    channels: chips({ now, reasons, lastGood: lg, base, nostr, traffic }),
    feed: feedOf(rows),
    reasons: reasons.map((r) => ({ id: r.id, status: r.status, channel: r.channel, text: r.text ?? r.line })),
  };
}
