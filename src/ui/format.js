// Small display helpers. Times are unix seconds.

export function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumFractionDigits: a >= 1 ? 4 : 6 });
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

/** Why the Satori Network does not pay this vault (register's vault_base_address), or '' (it does, or it does not say). */
export function mismatchText(r) {
  if (!r?.ok || !r.vaultMismatch) return '';
  if (r.vaultMismatch === 'other') {
    return `Vault mismatch: the Satori Network pays this vault's rewards to a different Base address, ${r.vault_base_address}, not this vault's ${r.vault}.`;
  }
  return "Vault mismatch: the Satori Network kept no vault for this identity, so it has no Base address to pay this neuron's rewards to"
    + ' (this vault may be registered to another neuron).';
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

/** A Nostr pubkey, shortened: the first 8 and last 4 hex. */
export const shortKey = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}` : '');

/** A relay's state (nostr status) in a few words. */
export function relayText(r) {
  const ro = r.write ? '' : ' · read only';
  if (r.state === 'open') return `Connected${ro}`;
  if (r.state === 'connecting') return `Connecting…${ro}`;
  if (r.state === 'blocked') return `Blocked: ${r.error}`;
  return `Disconnected${r.error ? ` (${r.error})` : ''}; retrying${ro}`;
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
  'setPredictorFee(0)': 'Identity: fee to 0',
  'setAllowedDelegator(vault)': 'Identity: accepts this vault',
  'delegatePredictionPower(identity)': 'Vault: stakes with this neuron',
  'delegatePredictionPower(0x0)': 'Vault: unstakes',
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
 * What the vault can claim, part by part (base().claimable): its staking rewards, the Satori Network's reward drop
 * ("from the Satori Network"; '–' when this Satori Network does not say), the airdrop.
 */
export const claimParts = (c) => [['rewards', c?.rewards], ['from the Satori Network', c?.drop], ['airdrop', c?.airdrop]];
export function claimableText(c) {
  return claimParts(c).map(([what, x]) => `${amountText(x, 'SATORI')} ${what}`).join(' · ');
}

/** The vault's stake in a few words. */
export function delegationText(v) {
  const d = v?.vault?.staked;
  if (d === 'identity') return `Staked: ${amountText(v.identity.power, 'SATORI')} with this neuron${v.vault.inSync === false ? ' · out of sync' : ''}`;
  if (d === 'none') return 'Not staked';
  if (d === 'other') return `Staked with ${v.vault.stakedWith}, not this neuron`;
  return '–';
}

/** The identity's gas: its ETH and about how many daily batches it pays for. */
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
export function checkText(c, next) {
  const when = next ? `next ${fmtWhen(next)}` : '';
  if (!c) return when || 'Not yet';
  const what = c.sent ? `sent round ${c.round}` : c.skipped ? c.skipped : c.error ? `failed: ${c.error}` : '';
  return [what, when].filter(Boolean).join(' · ');
}

/** A fee in ETH (a decimal string): two significant digits, never an exponent ('0.00000013 ETH'). */
export function ethFeeText(x) {
  if (x == null) return '–';
  return `${Number(x).toLocaleString('en-US', { maximumSignificantDigits: 2, maximumFractionDigits: 20 })} ETH`;
}

/** When the vault locks on its own (ms; null: it is locked), said by Lock: 'Locks in 4 min' (whole minutes, up). */
export function lockInText(lockAt, now) {
  if (lockAt == null) return '';
  const s = (lockAt - now) / 1000;
  return s < 60 ? 'Locks in under a minute' : `Locks in ${Math.ceil(s / 60)} min`;
}

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
 * The Base card's note on who plays (docs/design/base.md): the neuron automatically, or the vault by hand in
 * Satori Daily, never both (the engine refuses a staked vault's own predictions). [before, after] the
 * "Satori Daily" link, or null (staked elsewhere, or not read yet).
 */
export function playNote(staked) {
  if (staked === 'identity') {
    return ["Your SATORI is staked with this neuron, so it can't also play ", ' by hand. Unstake to play manually.'];
  }
  return staked === 'none' ? ['Stake with this neuron to let it predict every round, or play ', ' by hand.'] : null;
}
