// The daily push server (docs/design/push.md), behind the app's own nginx at https://app.satorinet.io/push/.
//   GET  /push/key          → { key }: the VAPID public key, the app's applicationServerKey
//   POST /push/subscribe    { subscription, player, tz }  (kept by endpoint)
//   POST /push/unsubscribe  { endpoint }
// Every minute: each subscription whose local time has reached its own minute of the day (the time the person turned it
// on: people get theirs at different times, and at a time they are awake) and that has had nothing today is checked on
// the chain; a player who has not predicted this round gets one push (no payload: the service worker decides what to do).
// The subscriptions and the VAPID key are one JSON file each in DATA. Env: PORT, DATA, RPC_URL, TOKEN, ENGINE, SUBJECT.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { checkSubscription, due, localTime, newVapid, predictedCounts, publicOf, sendPush } from './push.mjs';

const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const DATA = env.DATA ?? '/data';
const SUBJECT = env.SUBJECT ?? 'https://app.satorinet.io';
const TICK_MS = 60_000;
const MAX_SUBS = 100_000;
const MAX_BODY = 4096;
for (const k of ['RPC_URL', 'TOKEN', 'ENGINE']) if (!env[k]) throw new Error(`${k} is not set`);

mkdirSync(DATA, { recursive: true });
const read = (f, init) => (existsSync(`${DATA}/${f}`) ? JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8')) : init());
const write = (f, v) => { writeFileSync(`${DATA}/${f}.tmp`, JSON.stringify(v)); renameSync(`${DATA}/${f}.tmp`, `${DATA}/${f}`); };

const stored = read('vapid.json', () => { const v = newVapid(); write('vapid.json', { privateJwk: v.privateJwk }); return v; });
const vapid = { privateJwk: stored.privateJwk, publicKey: publicOf(stored.privateJwk) };
const subs = new Map(read('subscriptions.json', () => []).map((s) => [s.endpoint, s]));
const save = () => write('subscriptions.json', [...subs.values()]);

function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new Error('not JSON')); } });
    req.on('error', reject);
  });
}

const answer = (res, code, value) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/push/key') return answer(res, 200, { key: vapid.publicKey });
    if (req.method === 'POST' && req.url === '/push/subscribe') {
      const s = checkSubscription(await body(req));
      if (!subs.has(s.endpoint) && subs.size >= MAX_SUBS) return answer(res, 503, { error: 'full' });
      const old = subs.get(s.endpoint);
      const now = Date.now();
      // the minute: as sent when turned on; else the one kept; else now's (local). Today counts as done: the first is tomorrow
      const minute = s.minute ?? old?.minute ?? localTime(s.tz, now).minute;
      const done = s.minute != null || !old ? localTime(s.tz, now).day : old.done;
      subs.set(s.endpoint, { ...s, minute, done, at: now });
      save();
      return answer(res, 200, { ok: true, minute });
    }
    if (req.method === 'POST' && req.url === '/push/unsubscribe') {
      const { endpoint } = await body(req);
      if (subs.delete(String(endpoint))) save();
      return answer(res, 200, { ok: true });
    }
    return answer(res, 404, { error: 'not found' });
  } catch (err) {
    return answer(res, 400, { error: err.message });
  }
}).listen(PORT, () => console.log(`[push] on :${PORT}, ${subs.size} subscriptions`));

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const list = [...subs.values()].map((s) => ({ s, day: due(s, now) })).filter((x) => x.day);
    if (!list.length) return;
    const counts = await predictedCounts({ rpc: env.RPC_URL, token: env.TOKEN, engine: env.ENGINE, players: list.map((x) => x.s.player) });
    let sent = 0;
    for (const { s, day } of list) {
      const n = counts.get(s.player.toLowerCase());
      if (n == null) continue; // not read: tried again next tick
      if (n === 0) {
        const r = await sendPush({ endpoint: s.endpoint, vapid, subject: SUBJECT }).catch(() => 'failed');
        if (r === 'gone') { subs.delete(s.endpoint); continue; }
        if (r === 'failed') continue;
        sent += 1;
      }
      s.done = day;
    }
    save();
    console.log(`[push] ${list.length} due, ${sent} sent`);
  } catch (err) {
    console.warn('[push] tick', err.message);
  } finally {
    busy = false;
  }
}
setInterval(tick, TICK_MS);
setTimeout(tick, 10_000);
