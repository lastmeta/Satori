// The daily push's pure parts (docs/design/push.md): VAPID (RFC 8292), the push services we send to, a subscription's
// local day, the chain read. No dependencies: Node's own crypto and fetch. server.mjs is the process around them.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** A new VAPID key pair: { publicKey (the raw 65-byte point, base64url: the app's applicationServerKey), privateJwk }. */
export function newVapid() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicKey: rawPublic(publicKey), privateJwk: privateKey.export({ format: 'jwk' }) };
}

const rawPublic = (key) => {
  const { x, y } = key.export({ format: 'jwk' });
  return b64u(Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]));
};

/** The public key of a stored private JWK (raw, base64url). */
export const publicOf = (privateJwk) => rawPublic(createPublicKey(createPrivateKey({ key: privateJwk, format: 'jwk' })));

/** The Authorization header for a push to `endpoint` (RFC 8292 §2-3): a JWT signed ES256 for the endpoint's origin, 12 h. */
export function vapidHeader({ endpoint, privateJwk, publicKey, subject, now = Date.now() / 1000 }) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now) + 12 * 3600, sub: subject }));
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicKey}`;
}

// The browsers' push services: a subscription elsewhere is refused, so the server never posts to an address a page chose.
const SERVICES = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^web\.push\.apple\.com$/, /(^|\.)push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A subscription as the app sends it, checked → { endpoint, player, tz, minute? }; else it throws. minute: the time of day
 * (0-1439, local) it reminds at, sent when the person turns it on. */
export function checkSubscription(body) {
  const endpoint = body?.subscription?.endpoint;
  let u;
  try { u = new URL(endpoint); } catch { throw new Error('no endpoint'); }
  if (u.protocol !== 'https:' || !SERVICES.some((r) => r.test(u.hostname))) throw new Error('not a push service');
  if (!ADDRESS.test(body.player ?? '')) throw new Error('no player address');
  const tz = body.tz ?? 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new Error('unknown time zone'); }
  const minute = body.minute ?? null;
  if (minute !== null && !(Number.isInteger(minute) && minute >= 0 && minute < 1440)) throw new Error('minute: 0 to 1439');
  return { endpoint: u.href, player: body.player, tz, minute };
}

/** A one-off reminder as the app sends it, checked → { endpoint, at (ms) }; else it throws. at: unix seconds, within 2 days. */
export function checkOnce(body, now) {
  const { endpoint } = checkSubscription({ ...body, player: body?.player ?? '0x' + '0'.repeat(40) });
  const at = body?.at;
  if (!Number.isInteger(at) || at * 1000 > now + 2 * 86_400_000) throw new Error('at: unix seconds, within 2 days');
  return { endpoint, at: at * 1000 };
}

/** The local date (YYYY-MM-DD) and minute of the day (0-1439) in `tz` at `at` (ms). */
export function localTime(tz, at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

/**
 * A subscription as kept, from the one kept before (or none) and the one just sent, at `now` (ms). Its minute: as sent
 * (turned on, or a subscription the browser replaced), else the one kept, else now's. Its time already past today counts
 * as done: turned on now, the first is tomorrow.
 */
export function subscribed(old, s, now) {
  const t = localTime(s.tz, now);
  const minute = s.minute ?? old?.minute ?? t.minute;
  return { ...s, minute, done: old?.done === t.day || t.minute >= minute ? t.day : null, at: now };
}

/** A subscription is due once a local day, from its own minute on (the time the person turned it on). */
export function due(sub, at) {
  const t = localTime(sub.tz, at);
  return t.minute >= sub.minute && sub.done !== t.day ? t.day : null;
}

// Selectors (checked against viem in push.test.js): SatoriToken.getCurrentRound(), SatoriEngine.predictedStreamsCount(address,uint256)
export const GET_CURRENT_ROUND = '0xa32bf597';
export const PREDICTED_STREAMS_COUNT = '0x2f24a085';
const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** How many games each player predicted this round, from one JSON-RPC batch: Map(player lowercased → count). */
export async function predictedCounts({ rpc, token, engine, players, fetch = globalThis.fetch }) {
  const call = async (body) => {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    return r.json();
  };
  const ethCall = (id, to, data) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] });
  const one = await call(ethCall(0, token, GET_CURRENT_ROUND));
  if (!one.result) throw new Error(`round: ${JSON.stringify(one.error)}`);
  const round = BigInt(one.result).toString(16);
  const list = [...new Set(players.map((p) => p.toLowerCase()))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    const answers = await call(part.map((p, k) => ethCall(k, engine, PREDICTED_STREAMS_COUNT + word(p) + word(round))));
    for (const a of answers) if (a.result) out.set(part[a.id], Number(BigInt(a.result)));
  }
  return out;
}

/** Sends one push with no payload (the service worker knows what to do): 'ok', 'gone' (404/410: drop it) or 'failed'. */
export async function sendPush({ endpoint, vapid, subject, fetch = globalThis.fetch }) {
  const r = await fetch(endpoint, { method: 'POST', headers: {
    authorization: vapidHeader({ endpoint, ...vapid, subject }), ttl: '43200', urgency: 'normal', 'content-length': '0' } });
  if (r.status === 404 || r.status === 410) return 'gone';
  return r.ok ? 'ok' : 'failed';
}
