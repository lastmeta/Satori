// One relay over a WebSocket (NIP-01), as much of a client as Satori needs
// (docs/design/nostr.md#relays-and-the-read-only-flag):
//   const r = createRelay(url, { onEvent(subId, event), onOpen(r), onState(state) })
//   r.connect()                    // and reconnect with backoff until r.close()
//   r.sub(id, filters) / r.unsub(id)   // kept: re-sent after every reconnect
//   await r.fetch(filters)         // one REQ until EOSE (10 s at most) → events
//   await r.publish(event)         // → { ok, message } from the relay's OK
// state: 'connecting' | 'open' | 'closed'. Events are passed on unchecked.
// The backoff starts over only once a connection has worked (an EOSE, or 30 s open).
// onTraffic(): each message sent or received (Home's glow, src/traffic.js).
import { emit } from '../traffic.js';

export const TIMEOUT_MS = 10_000; // satorilib's fetch_events (client.py:847)
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 300_000;
const STABLE_MS = 30_000; // an open socket counts as working after this, or after the relay's first EOSE

/** The wait before reconnect attempt n (0-based): 1 s doubling to 5 min, ±20 %. */
export const backoffMs = (n, random = Math.random) =>
  Math.round(Math.min(BACKOFF_MIN_MS * 2 ** n, BACKOFF_MAX_MS) * (0.8 + 0.4 * random()));

export function createRelay(url, { WebSocket = globalThis.WebSocket, onEvent = () => {}, onOpen = () => {},
  onState = () => {}, random = Math.random, onTraffic = () => emit('network') } = {}) {
  let ws = null;
  let state = 'closed';
  let error = '';
  let stopped = true;
  let attempt = 0;
  let timer = null;
  let stable = null; // resets the backoff once the connection has proved itself
  let n = 0;
  const kept = new Map(); // id → filters
  const fetches = new Map(); // id → { events, done }
  const publishes = new Map(); // event id → [resolve]

  const setState = (s) => {
    if (s !== state) {
      state = s;
      onState(s);
    }
  };
  const send = (msg) => {
    if (state !== 'open') return false;
    try {
      ws.send(JSON.stringify(msg));
      onTraffic();
      return true;
    } catch {
      return false;
    }
  };
  const settle = (id, result) => {
    for (const resolve of publishes.get(id) ?? []) resolve(result);
    publishes.delete(id);
  };

  function retry() {
    clearTimeout(timer);
    timer = setTimeout(open, backoffMs(attempt++, random));
  }

  const proven = () => {
    clearTimeout(stable);
    attempt = 0;
  };

  function lost(why) {
    clearTimeout(stable);
    ws = null;
    for (const f of [...fetches.values()]) f.done();
    for (const id of [...publishes.keys()]) settle(id, { ok: false, message: 'disconnected' });
    setState('closed');
    if (why) error = why;
    if (!stopped) retry();
  }

  function onMessage({ data }) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!Array.isArray(m)) return;
    const [type, a, b, c] = m;
    if (type === 'EVENT') {
      if (fetches.has(a)) fetches.get(a).events.push(b);
      else if (kept.has(a)) onEvent(a, b);
    } else if (type === 'EOSE' || type === 'CLOSED') {
      if (type === 'EOSE') proven();
      fetches.get(a)?.done();
    } else if (type === 'OK') {
      settle(a, { ok: b === true, message: String(c ?? '') });
    }
  }

  function open() {
    if (stopped || ws) return;
    setState('connecting');
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      return lost(String(err?.message ?? err));
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      // Not attempt = 0 here: a relay (or proxy) that accepts and drops every
      // connection would be reconnected to every second.
      stable = setTimeout(proven, STABLE_MS);
      error = '';
      setState('open');
      for (const [id, filters] of kept) send(['REQ', id, ...filters]);
      onOpen(relay);
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      onTraffic();
      onMessage(e);
    };
    sock.onclose = (e) => ws === sock && lost(e?.code && e.code !== 1000 ? `closed (${e.code})` : '');
    sock.onerror = () => {}; // a close follows
  }

  const relay = {
    url,
    get state() { return state; },
    get error() { return error; },
    /** Connect now (a pending retry is brought forward); no-op while connected or connecting. */
    connect() {
      stopped = false;
      if (ws) return;
      clearTimeout(timer);
      open();
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      const sock = ws;
      if (sock) {
        lost('');
        try { sock.close(); } catch { /* already closed */ }
      }
    },
    sub(id, filters) {
      if (kept.has(id)) send(['CLOSE', id]);
      kept.set(id, filters);
      send(['REQ', id, ...filters]);
    },
    unsub(id) {
      if (kept.delete(id)) send(['CLOSE', id]);
    },
    fetch(filters, { timeoutMs = TIMEOUT_MS } = {}) {
      if (state !== 'open') return Promise.reject(new Error(`${url}: not connected`));
      const id = `f${++n}`;
      return new Promise((resolve) => {
        const f = { events: [], done: () => {
          clearTimeout(t);
          fetches.delete(id);
          send(['CLOSE', id]);
          resolve(f.events);
        } };
        const t = setTimeout(f.done, timeoutMs);
        fetches.set(id, f);
        send(['REQ', id, ...filters]);
      });
    },
    publish(event, { timeoutMs = TIMEOUT_MS } = {}) {
      if (state !== 'open') return Promise.resolve({ ok: false, message: 'not connected' });
      return new Promise((resolve) => {
        const t = setTimeout(() => settle(event.id, { ok: false, message: 'timeout' }), timeoutMs);
        const list = publishes.get(event.id) ?? [];
        list.push((r) => {
          clearTimeout(t);
          resolve(r);
        });
        publishes.set(event.id, list);
        if (!send(['EVENT', event])) settle(event.id, { ok: false, message: 'not connected' });
      });
    },
  };
  return relay;
}
