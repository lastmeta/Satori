#!/usr/bin/env node
// An in-memory Nostr relay (NIP-01) for development and tests; nothing is kept
// on disk. Usage: node scripts/test-relay.mjs [port…]   (default 7778; listens on 127.0.0.1,
// or HOST=0.0.0.0 to open it to the network)
//   EVENT: id and signature checked (OK true/false), created_at at most 900 s
//          ahead (as strfry); kinds 0, 3 and 10000-19999 replaced per (pubkey,
//          kind), 30000-39999 per (pubkey, kind, d); 20000-29999 not stored.
//   REQ/EOSE/CLOSE: ids, authors, kinds, #<tag>, since, until, limit (500 at
//          most per filter, as strfry); then live events; 20 per connection.
import { WebSocketServer } from 'ws';
import { verifyEvent } from '../src/nostr/event.js';

const MAX_LIMIT = 500;
const MAX_SUBS = 20;
const FUTURE_S = 900;

const replaceKey = (e) => {
  if (e.kind === 0 || e.kind === 3 || (e.kind >= 10000 && e.kind < 20000)) return `${e.pubkey}:${e.kind}`;
  if (e.kind >= 30000 && e.kind < 40000) return `${e.pubkey}:${e.kind}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`;
  return null;
};

const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const ints = (v) => Array.isArray(v) && v.every(Number.isSafeInteger);

/** A NIP-01 filter of the right types, or null. */
export function validFilter(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  for (const [k, v] of Object.entries(f)) {
    const ok = k === 'ids' || k === 'authors' || (k[0] === '#' && k.length === 2) ? strings(v)
      : k === 'kinds' ? ints(v)
        : k === 'since' || k === 'until' || k === 'limit' ? Number.isSafeInteger(v) && v >= 0
          : true; // unknown keys are ignored, as relays do
    if (!ok) return null;
  }
  return f;
}

export function matches(f, e) {
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const [k, want] of Object.entries(f)) {
    if (k[0] !== '#' || k.length !== 2) continue;
    if (!e.tags.some((t) => t[0] === k[1] && want.includes(t[1]))) return false;
  }
  return true;
}

/** Start one relay on `port` (0 = any free port). → { port, close(), events() } */
export function startRelay({ port = 7778, host = '127.0.0.1', log = () => {} } = {}) {
  const byId = new Map();
  const latest = new Map(); // replace key → id
  const subs = new Map(); // ws → Map(subId → filters)
  const wss = new WebSocketServer({ port, host });
  const out = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

  function store(e) {
    const key = replaceKey(e);
    if (key) {
      const old = byId.get(latest.get(key));
      if (old && (old.created_at > e.created_at || (old.created_at === e.created_at && old.id < e.id))) {
        return 'replaced: have a newer event';
      }
      if (old) byId.delete(old.id);
      latest.set(key, e.id);
    }
    byId.set(e.id, e);
    return '';
  }

  function onEvent(ws, e) {
    if (!verifyEvent(e)) return out(ws, ['OK', typeof e?.id === 'string' ? e.id : '', false, 'invalid: bad id or signature']);
    if (e.created_at > Date.now() / 1000 + FUTURE_S) return out(ws, ['OK', e.id, false, 'invalid: created_at too far in the future']);
    if (byId.has(e.id)) return out(ws, ['OK', e.id, true, 'duplicate: have this event']);
    if (!(e.kind >= 20000 && e.kind < 30000)) {
      const refused = store(e);
      if (refused) return out(ws, ['OK', e.id, false, refused]);
    }
    out(ws, ['OK', e.id, true, '']);
    log(`EVENT ${e.kind} ${e.pubkey.slice(0, 8)} ${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`);
    for (const [client, mine] of subs) {
      for (const [id, filters] of mine) if (filters.some((f) => matches(f, e))) out(client, ['EVENT', id, e]);
    }
  }

  function onReq(ws, id, raw) {
    const filters = raw.map(validFilter);
    if (!filters.length || filters.includes(null)) return out(ws, ['CLOSED', id, 'invalid: a filter of the wrong shape']);
    const mine = subs.get(ws);
    if (!mine.has(id) && mine.size >= MAX_SUBS) return out(ws, ['CLOSED', id, 'error: too many subscriptions']);
    mine.set(id, filters);
    const sent = new Set();
    const all = [...byId.values()].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
    for (const f of filters) {
      const limit = Math.min(f.limit ?? MAX_LIMIT, MAX_LIMIT);
      let n = 0;
      for (const e of all) {
        if (n >= limit) break;
        if (!matches(f, e)) continue;
        n++;
        if (!sent.has(e.id)) {
          sent.add(e.id);
          out(ws, ['EVENT', id, e]);
        }
      }
    }
    out(ws, ['EOSE', id]);
  }

  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (data) => {
      try {
        let m;
        try { m = JSON.parse(data); } catch { return out(ws, ['NOTICE', 'error: not JSON']); }
        if (!Array.isArray(m)) return out(ws, ['NOTICE', 'error: not an array']);
        const [type, a, ...rest] = m;
        if (type === 'EVENT') onEvent(ws, a);
        else if (type === 'REQ' && typeof a === 'string') onReq(ws, a, rest);
        else if (type === 'CLOSE' && typeof a === 'string') subs.get(ws)?.delete(a);
        else out(ws, ['NOTICE', `error: bad message ${String(type)}`]);
      } catch (err) { // one bad message never takes the relay down
        out(ws, ['NOTICE', `error: ${err?.message ?? err}`]);
      }
    });
  });

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => resolve({
      port: wss.address().port,
      events: () => [...byId.values()],
      close: () => new Promise((done) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => done());
      }),
    }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ports = process.argv.slice(2).map(Number);
  for (const port of ports.length ? ports : [7778]) {
    const host = process.env.HOST ?? '127.0.0.1';
    const r = await startRelay({ port, host, log: (s) => console.log(`[${port}] ${s}`) });
    console.log(`test relay on ws://${host}:${r.port} (in memory)`);
  }
}
