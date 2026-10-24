// Small display helpers. Times are unix seconds.
import { skipText } from '../neuron/health.js';

export function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumFractionDigits: a >= 1 ? 4 : 6 });
}

/**
 * A trend line of values (oldest first) in a w × h box (70 × 20 by default), on its own scale or on `range` ([lo, hi]:
 * two lines on one scale, as the track record's actual and predicted).
 */
export function sparkPath(values = [], w = 70, h = 20, range = null) {
  if (values.length < 2) return '';
  const [lo, hi] = range ?? [Math.min(...values), Math.max(...values)];
  const y = (v) => (hi === lo ? h / 2 : h - 2 - ((v - lo) / (hi - lo)) * (h - 4));
  return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
}

export function fmtWhen(s) {
  if (s == null) return '–';
  return new Date(s * 1000).toLocaleString('en-US',
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/**
 * The day strip's summary (health().days, the days shown): '12 of 14 full days'. A neuron younger than the strip
 * counts only its own days: '1 full day' on its first, then '2 of 3 full days'.
 */
export function daysText(days) {
  const mine = days.filter((d) => d.code !== 'before');
  const full = mine.filter((d) => d.code === 'full').length;
  if (!days.length) return '';
  return mine.length > 1 ? `${full} of ${mine.length} full days` : `${full} full day${full === 1 ? '' : 's'}`;
}

/** The register result (neuron register()) in a few words. */
export function registrationText(r) {
  if (!r) return 'Registering…';
  if (r.ok) return `Yes · peer ${r.peer_id}`;
  return `No: ${r.error}`;
}

/** Why the Satori Network does not pay this wallet (register's wallet_address), or '' (it does, or it does not say). */
export function mismatchText(r) {
  if (!r?.ok || !r.walletMismatch) return '';
  const refused = r.walletLinkError ? ` It refused the wallet's link: ${r.walletLinkError}.` : '';
  if (r.walletMismatch === 'other') {
    return `Wallet mismatch: the Satori Network pays this wallet's rewards to a different Base address, ${r.wallet_address}, not this wallet's ${r.wallet}.${refused}`;
  }
  return `Wallet not linked: the Satori Network has no wallet linked to this app, so it has no Base address to pay its rewards to.${refused}`
    + ' Unlock the wallet: the app links it.';
}

export function pollText(p) {
  if (!p) return 'Not yet';
  if (p.error) return `${fmtWhen(p.at)} · failed: ${p.error}`;
  return `${fmtWhen(p.at)} · ${p.streams} streams, ${p.new} new, ${p.predicted} predicted`;
}

export function submitText(s) {
  if (!s) return 'Not yet';
  const kept = '; kept for the next poll';
  if (s.error) return `${fmtWhen(s.at)} · failed: ${s.error}${kept}`;
  return `${fmtWhen(s.at)} · ${s.successful} of ${s.total_submitted} accepted${s.successful > 0 ? '' : kept}`;
}

const short = (x, digits) => String(Number(x.toFixed(digits))).replace('-', '−');

/** A stream row's spec (JSON text, as stored), or null. */
const specOf = (r) => {
  try { return r?.spec ? JSON.parse(r.spec) : null; } catch { return null; }
};
const nameOf = (names, u) => names?.get(u) ?? u;

/** The Model column: the model, and its spec's companions by name (docs/design/engine.md). */
export function modelText(r, names) {
  if (!r.model) return '–';
  const spec = specOf(r);
  if (!spec?.companions?.length) return r.model;
  const plus = spec.companions.map((u) => `+${nameOf(names, u)}`).join(' ');
  return r.model === 'bvar' ? `bvar · ${plus}` : `${r.model} · spec ${plus}`;
}

/** The engine model of a prediction in a few words (docs/design/engine.md), with its stream's spec. */
export function modelTitle(p, names) {
  const spec = specOf(p);
  const with_ = spec?.companions?.map((u) => nameOf(names, u)).join(', ');
  if (p.model === 'bvar') {
    return `Bayesian VAR(1) on 12 h steps of this stream with ${with_} · λ1 ${spec.lambda1} · λ2 ${spec.lambda2}`
      + ` · own φ ${short(p.phi, 3)} · weight ${short(p.weight, 2)} · generation ${p.generation}, ${p.accepted} kept`
      + ` · score ${p.score == null ? '–' : `${short(p.score * 100, 2)}%`} (median 24 h error, last 28 origins)`;
  }
  let t = p.model ?? '';
  if (p.model === 'bar1') t = `Bayesian AR(1) on 12 h returns · φ ${short(p.phi, 3)} · weight ${short(p.weight, 2)}`;
  if (p.model === 'bar1d') t = `Bayesian AR(1) on 12 h changes (a series with values ≤ 0) · φ ${short(p.phi, 3)} · weight ${short(p.weight, 2)}`;
  if (p.model === 'naive') t = 'the last value: bar1 needs an observation every 12 h (6 lag pairs of back-to-back 12 h buckets)';
  if (p.model && spec?.companions?.length) {
    t += ` · its spec: bvar with ${with_}, λ1 ${spec.lambda1}, λ2 ${spec.lambda2}, generation ${p.generation},`
      + ` until it has ${spec.companions.length + 6} aligned 12 h rows`;
  }
  return t;
}

/** Central's history for our streams (neuron/history.js) in a few words: status().central.history. */
export function historyText(h) {
  if (!h) return 'Not yet';
  const wait = h.needed ? `${h.needed} streams wait for the next poll` : '';
  if (h.at == null) return wait || 'Not yet';
  if (h.retryAt) return `No history from the Satori Network yet (${h.error}); next try ${fmtWhen(h.retryAt)}`;
  const done = `${fmtWhen(h.at)} · ${h.streams} streams, ${h.rows.toLocaleString('en-US')} rows`;
  if (h.error) return `${done} · failed: ${h.error}${wait ? `; ${wait}` : ''}`;
  return wait ? `${done} · ${wait}` : done;
}

/** n distinct sorted random indexes in [0, max). */
export function pickIndexes(n, max, rand = Math.random) {
  const s = new Set();
  while (s.size < n) s.add(Math.floor(rand() * max));
  return [...s].sort((a, b) => a - b);
}

/** A stream's cadence in a word or two. */
export function fmtCadence(s) {
  if (!(s > 0)) return 'irregular';
  for (const [unit, n] of [['d', 86400], ['h', 3600], ['min', 60]]) if (s % n === 0) return `${s / n} ${unit}`;
  return `${s} s`;
}

/** One of our streams for sale (nostr().market.selling's entry), or Free (docs/design/market.md). */
export function saleText(sale) {
  if (!sale) return 'Free';
  const n = sale.buyers.filter((b) => !b.closing).length;
  return `${sale.price} SATORI each${n ? ` · ${n} buying` : ''}`;
}

/** A stream we buy (nostr().market.bought's entry): the deposit left, or, stopped, when the rest comes back to the wallet. */
export const boughtText = (b) => (b.status === 'open' ? `${b.left} of ${b.deposit} SATORI left`
  : `Stopped: ${b.left} SATORI back to the wallet after ${b.closeAt ? fmtWhen(b.closeAt) : '7 days'}`);

/** A Nostr pubkey, shortened: the first 8 and last 4 hex. */
export const shortKey = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}` : '');

/** A relay's state (nostr status) in a few words; a blocked one (ws:// on an https page, or in a build) is said once, BLOCKED_NOTE. */
export function relayText(r) {
  const ro = r.write ? '' : ' · read only';
  if (r.state === 'open') return `Connected${ro}`;
  if (r.state === 'connecting') return `Connecting…${ro}`;
  if (r.state === 'blocked') return 'Not reachable here';
  return `Disconnected${r.error ? ` (${r.error})` : ''}; retrying${ro}`;
}

/** Under the relays, once, when one is blocked (docs/design/nostr.md#relays-and-the-read-only-flag). */
export const BLOCKED_NOTE = "A ws:// relay can't be reached from this page (only wss:// can), so it is left out: it doesn't count as down.";

/** The relays in a few words: those that count (not blocked), connected of them. */
export function relaysText(relays) {
  const usable = relays.filter((r) => r.state !== 'blocked');
  const up = usable.filter((r) => r.state === 'open').length;
  return usable.length ? `${up} of ${usable.length} relay${usable.length === 1 ? '' : 's'} connected` : 'no relay';
}

/** A relay observation's value as sent (a dict as JSON): the hover title of obsText. */
export const rawText = (o) => (!o ? '' : typeof o.raw === 'string' ? o.raw : JSON.stringify(o.raw));

/** A relay observation's value: as a number when it has one, the same as our `_pred` (predText); else as sent. */
export const obsText = (o) => (!o ? '–' : o.value != null ? fmtNum(o.value) : rawText(o));

/** A published `_pred` value: as a number when it is one (Python's float text), else as sent. */
export function predText(v) {
  if (v == null) return '–';
  const n = /^-?\d+(\.\d+)?(e[+-]\d+)?$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? fmtNum(n) : v;
}

/** Whether a catalog entry matches the search words (all of them, any case). */
export function catalogMatch(s, q) {
  const text = `${s.stream_name} ${s.name} ${s.description} ${s.tags.join(' ')}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.includes(w));
}

// ── Base (docs/design/base.md) ──

export { fmtUtc, lockText } from '../chain/index.js'; // the transfer lock's text lives with its rule

/** The Base RPC in plain words: the local test chain, or the hosts in failover order. */
export function rpcText(b) {
  if (!b.rpc.length) return '–';
  if (b.localFork) return 'Local test chain (a fork of Base Sepolia)';
  const hosts = b.rpc.map((u) => { try { return new URL(u).host; } catch { return u; } });
  return `${hosts.join(', then ')}${b.rpcSetting ? '' : ' (the default)'}`;
}

/** …and in full, for its hover title. */
export const rpcTitle = (b) => `${b.rpc.join(', ')}${b.localFork ? ' → 127.0.0.1:8545 (node scripts/fork.mjs start)' : ''}`;

const STEPS = {
  'setPredictorFee(0)': 'Alias: fee to 0',
  'setAllowedDelegator(wallet)': 'Alias: accepts this wallet',
  'setReferral(referrer)': 'Wallet: registers who invited you',
  'delegatePredictionPower(alias)': 'Wallet: stakes with this app',
  'delegatePredictionPower(0x0)': 'Wallet: unstakes',
};
/** A step of Stake or Unstake (satori.stake() / unstake()) in plain words. */
export const stepText = (step) => STEPS[step] ?? step;

/** 0x1234…abcd */
export const shortHash = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '');

/** A decimal amount string ('100.5') with its unit, or '–'. */
export function amountText(x, unit) {
  if (x == null) return '–';
  return `${fmtNum(Number(x))} ${unit}`;
}

/**
 * What the wallet can claim, part by part (base().claimable): its staking rewards, the Satori Network's reward drop
 * ("from the Satori Network"; '–' when this Satori Network does not say), the airdrop.
 */
export const claimParts = (c) => [['rewards', c?.rewards], ['from the Satori Network', c?.drop], ['airdrop', c?.airdrop]];
export function claimableText(c) {
  return claimParts(c).map(([what, x]) => `${amountText(x, 'SATORI')} ${what}`).join(' · ');
}

/** The wallet's stake in a few words. */
export function delegationText(v) {
  const d = v?.wallet?.staked;
  if (d === 'alias') return `Staked: ${amountText(v.alias.power, 'SATORI')} with this app${v.wallet.inSync === false ? ' · out of sync' : ''}`;
  if (d === 'none') return 'Not staked';
  if (d === 'other') return `Staked with ${v.wallet.stakedWith}, not this app`;
  return '–';
}

/** The referral cut: `REFERRAL_BPS = 500` in SatoriRewards.sol (internal, so it cannot be read). */
export const REFERRAL_PCT = 5;

/** Who invited this wallet: registered on the contract, held until Stake, or no one. */
export function referralText(b) {
  if (b?.wallet?.referral) return shortHash(b.wallet.referral);
  if (b?.pendingReferrer) return `Invited by ${shortHash(b.pendingReferrer)}, registered when you stake`;
  return 'None';
}

/** What Stake also does when an invite is held, said before it does it. */
export const referralNote = (ref) => `Invited by ${ref}. Staking registers them as your referral, once and for good: ${REFERRAL_PCT}% of the rewards your wallet earns goes to them instead of to the project, and you earn the same either way.`;

/** The alias's gas: its ETH and about how many daily batches it pays for. */
export function gasText(id) {
  if (id?.eth == null) return '–';
  const n = id.batchesLeft;
  return `${amountText(id.eth, 'ETH')}${n == null ? '' : ` · about ${n >= 1000 ? '1,000+' : n} daily batch${n === 1 ? '' : 'es'}`}`;
}

const arrow = (d) => (d === 1 ? '↑' : '↓');

/** The last batch sent: round, time, each game's direction, what was left out. */
export function batchText(b) {
  if (!b) return 'None yet';
  const games = b.games.map((g) => `game ${g.gameId} ${arrow(g.direction)}`).join(', ');
  const out = b.dropped?.length ? ` · left out: ${b.dropped.map((g) => `game ${g.gameId} (${g.error})`).join(', ')}` : '';
  return `Round ${b.round} · ${fmtWhen(b.at)} · ${games}${out}`;
}

/** The last check of the batch and when the next one runs. */
/** A balance's figure for a big number: '1,000.00', '0.002' (a decimal string; '–' while not read). */
export const figure = (x) => (x == null ? '–' : fmtNum(Number(x)));

export function checkText(c, next) {
  const when = next ? `next ${fmtWhen(next)}` : '';
  if (!c) return when || 'Not yet';
  const what = c.sent ? `sent round ${c.round}` : c.skipped ? skipText(c) : c.error ? `failed: ${c.error}` : '';
  return [what, when].filter(Boolean).join(' · ');
}

/** A fee in ETH (a decimal string): two significant digits, never an exponent ('0.00000013 ETH'). */
export function ethFeeText(x) {
  if (x == null) return '–';
  return `${Number(x).toLocaleString('en-US', { maximumSignificantDigits: 2, maximumFractionDigits: 20 })} ETH`;
}

/** When the wallet locks on its own (ms; null: it is locked), said by Lock: 'Locks in 4 min' (whole minutes, up). */
export function lockInText(lockAt, now) {
  if (lockAt == null) return '';
  const s = (lockAt - now) / 1000;
  return s < 60 ? 'Locks in under a minute' : `Locks in ${Math.ceil(s / 60)} min`;
}

/**
 * DuckDB's download ({ bytesLoaded, bytesTotal }, its instantiate progress) in the bytes that cross the network
 * (docs/design/storage.md#the-first-visit): it counts the decoded wasm against the Content-Length, which is the
 * compressed size when the host compresses it (gzip, brotli), so the count is scaled by `raw` (the decoded size).
 * → { loaded, total } (total null: unknown)
 */
export function transferProgress({ bytesLoaded = 0, bytesTotal = 0 } = {}, raw = null) {
  if (!(bytesTotal > 0)) return { loaded: bytesLoaded, total: raw };
  const loaded = raw > bytesTotal ? Math.round((bytesLoaded * bytesTotal) / raw) : bytesLoaded;
  return { loaded: Math.min(loaded, bytesTotal), total: bytesTotal };
}

const mb = (n) => (n / 1e6).toFixed(1);
/** The engine's step while Setup or Home waits for it ({ step: download | start | open | ready, loaded, total }). */
export function engineText(e) {
  if (!e || e.step === 'ready') return '';
  if (e.step === 'download') {
    if (e.total) return `downloading the engine, ${mb(e.loaded)} of ${mb(e.total)} MB`;
    return e.loaded > 0 ? `downloading the engine, ${mb(e.loaded)} MB` : 'downloading the engine…';
  }
  return e.step === 'start' ? 'starting the engine…' : 'opening the database…';
}

/** What a revisit waits for (the last visit's Home, or "Opening…"): the engine's step, then the neuron's start. */
export const openingText = (e) => (e ? `Opening… ${engineText(e) || 'starting the app…'}` : 'Opening…');

/** One claim's result (base.claim()): claimed, skipped (why) or failed. */
export function claimLine(name, r) {
  if (!r) return '';
  if (r.hash) return `${name}: claimed ${amountText(r.amount, 'SATORI')} (${shortHash(r.hash)})`;
  if (r.skipped) return `${name}: ${r.skipped}`;
  return `${name}: failed: ${r.error}`;
}

const bytes = (n) => (n >= 1e9 ? `${short(n / 1e9, n >= 1e10 ? 0 : 1)} GB` : `${short(n / 1e6, n >= 1e7 ? 0 : 1)} MB`);

/** Home's storage line (docs/design/pwa.md): kept (persistent) or not, and how much is used. */
export function storageText(s) {
  if (!s) return 'Storage: …';
  const kept = s.persisted ? 'Storage: kept' : 'Storage: the browser may clear it; install Satori or back up your words';
  return s.usage == null ? kept : `${kept} · ${bytes(s.usage)} of ${bytes(s.quota)} used`;
}

/**
 * The Base card's note on who plays (docs/design/base.md): the neuron automatically, or the wallet by hand in
 * Satori Daily, never both (the engine refuses a staked wallet's own predictions). [before, after] the
 * "Satori Daily" link, or null (staked elsewhere, or not read yet).
 */
export function playNote(staked) {
  if (staked === 'alias') {
    return ["Your SATORI is staked with this app, so it can't also play ", ' by hand. Unstake to play manually.'];
  }
  return staked === 'none' ? ['Stake with this app to let it predict every round, or play ', ' by hand.'] : null;
}
