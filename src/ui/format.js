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
  if (p.model === 'naive') return 'the last value (fewer than 8 × 12 h of history)';
  return p.model ?? '';
}

/** n distinct sorted random indexes in [0, max). */
export function pickIndexes(n, max, rand = Math.random) {
  const s = new Set();
  while (s.size < n) s.add(Math.floor(rand() * max));
  return [...s].sort((a, b) => a - b);
}
