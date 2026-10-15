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

/** The register result (neuron register()) in a few words. */
export function registrationText(r) {
  if (!r) return 'Registering…';
  if (r.ok) return `Yes · peer ${r.peer_id}`;
  return `No: ${r.error}`;
}

/** Why central's vault for this identity is not ours, or ''. */
export function mismatchText(r, vault) {
  if (!r?.ok || !r.vaultMismatch) return '';
  if (r.vault_address) return `Vault mismatch: central has ${r.vault_address} for this identity, not this vault (${vault}).`;
  return `Vault mismatch: central kept no vault for this identity (${vault} may be registered to another neuron).`;
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

/** The engine model of a prediction in a few words (docs/design/engine.md). */
export function modelTitle(p) {
  if (p.model === 'bar1') return `Bayesian AR(1) on 12 h returns · φ ${short(p.phi, 3)} · weight ${short(p.weight, 2)}`;
  if (p.model === 'bar1d') return `Bayesian AR(1) on 12 h changes (a series with values ≤ 0) · φ ${short(p.phi, 3)} · weight ${short(p.weight, 2)}`;
  if (p.model === 'naive') return 'the last value: bar1 needs an observation every 12 h (6 lag pairs of back-to-back 12 h buckets)';
  return p.model ?? '';
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
  'delegatePredictionPower(identity)': 'Vault: delegates to the identity',
  'delegatePredictionPower(0x0)': 'Vault: stops delegating',
};
/** A delegation step (base.delegate() / undelegate()) in plain words. */
export const stepText = (step) => STEPS[step] ?? step;

/** 0x1234…abcd */
export const shortHash = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '');

/** A decimal amount string ('100.5') with its unit, or '–'. */
export function amountText(x, unit) {
  if (x == null) return '–';
  return `${fmtNum(Number(x))} ${unit}`;
}

/** The vault's delegation in a few words. */
export function delegationText(v) {
  const d = v?.vault?.delegated;
  if (d === 'identity') return `Delegated to the identity · ${amountText(v.identity.power, 'SATORI')} of prediction power`;
  if (d === 'none') return 'Not delegated';
  if (d === 'other') return `Delegated to ${v.vault.delegate}, not this identity`;
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

/** One claim's result (base.claim()): claimed, skipped (why) or failed. */
export function claimLine(name, r) {
  if (!r) return '';
  if (r.hash) return `${name}: claimed ${amountText(r.amount, 'SATORI')} (${shortHash(r.hash)})`;
  if (r.skipped) return `${name}: ${r.skipped}`;
  return `${name}: failed: ${r.error}`;
}
