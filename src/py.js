// Python's text for values, byte for byte, where satorilib's and Lite's
// payloads depend on it: str(float) (central's predictions batch, `_pred`)
// and json.dumps (every Nostr event's content).

/**
 * Python `str(float)` / `str(numpy.float64)`: shortest round-trip digits,
 * positional for 1e-4 <= |x| < 1e16, else `d.ddde±XX`. Checked against
 * test/fixtures/central-parity.json (made in the Docker image).
 * @param {number} x
 */
export function pyFloatStr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [m, e] = x.toExponential().split('e'); // shortest digits, like repr
  const exp = Number(e);
  const sign = x < 0 ? '-' : '';
  const digits = m.replace(/[-.]/g, '');
  if (exp < -4 || exp >= 16) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${mant}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return `${sign}${digits}${'0'.repeat(exp + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

const ESC = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
// ensure_ascii: outside ' '..'~', anything without a short escape is \uXXXX (Python's json ESCAPE_ASCII).
const pyStr = (s) => `"${s.replace(/[^ -~]|["\\]/g,
  (c) => ESC[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

/**
 * Python's json.dumps with its defaults (", " and ": ", ensure_ascii), which
 * satorilib uses for every event's content (models.py to_json). A safe integer
 * prints as an int, any other number as Python's float.
 */
export function pyJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return pyStr(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    return Number.isSafeInteger(v) ? String(v) : pyFloatStr(v);
  }
  if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyStr(k)}: ${pyJson(x)}`).join(', ')}}`;
}
