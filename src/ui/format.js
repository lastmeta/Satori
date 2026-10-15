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
  return `${r.skipped ? 'Not sent' : 'No'}: ${r.error}`;
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

/** A relay observation's value as the provider sent it. */
export function obsText(o) {
  if (!o) return '–';
  return typeof o.raw === 'string' ? o.raw : JSON.stringify(o.raw);
}

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
