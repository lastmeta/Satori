// The relay client against a fake WebSocket: REQ/EOSE/CLOSE, OK handling,
// kept subscriptions re-sent after a reconnect, backoff.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRelay, backoffMs } from './relay.js';

class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeSocket.all.push(this);
  }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  // test controls
  open() { this.readyState = 1; this.onopen?.({}); }
  msg(x) { this.onmessage?.({ data: JSON.stringify(x) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}
const last = () => FakeSocket.all.at(-1);
const ev = (id) => ({ id, pubkey: 'p', created_at: 1, kind: 34601, tags: [], content: '', sig: '' });

let events;
let opened;
let states;
const make = (opts = {}) => createRelay('ws://relay.test', {
  WebSocket: FakeSocket, random: () => 0.5,
  onEvent: (sub, e) => events.push([sub, e.id]), onOpen: () => opened++, onState: (s) => states.push(s), ...opts,
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  events = [];
  opened = 0;
  states = [];
});
afterEach(() => vi.useRealTimers());

describe('relay', () => {
  test('connect; kept subscriptions are sent on open, replaced, closed; their events are passed on', () => {
    const r = make();
    r.sub('follow', [{ kinds: [34601] }]);
    r.connect();
    r.connect(); // idempotent
    expect(FakeSocket.all).toHaveLength(1);
    expect(r.state).toBe('connecting');
    last().open();
    expect(r.state).toBe('open');
    expect(opened).toBe(1);
    expect(last().sent).toEqual([['REQ', 'follow', { kinds: [34601] }]]);
    r.sub('follow', [{ kinds: [34600] }]);
    expect(last().sent.slice(1)).toEqual([['CLOSE', 'follow'], ['REQ', 'follow', { kinds: [34600] }]]);
    last().msg(['EVENT', 'follow', ev('e1')]);
    last().msg(['EVENT', 'other', ev('e2')]);
    last().msg(['NOTICE', 'hi']);
    last().msg('not an array');
    expect(events).toEqual([['follow', 'e1']]);
    r.unsub('follow');
    expect(last().sent.at(-1)).toEqual(['CLOSE', 'follow']);
    expect(states).toEqual(['connecting', 'open']);
  });

  test('fetch: one REQ until EOSE, then CLOSE; a timeout gives what came; not connected throws', async () => {
    const r = make();
    await expect(r.fetch([{ kinds: [1] }])).rejects.toThrow(/not connected/);
    r.connect();
    last().open();
    const p = r.fetch([{ kinds: [34600], limit: 500 }]);
    const [, id] = last().sent.at(-1);
    expect(last().sent.at(-1)).toEqual(['REQ', id, { kinds: [34600], limit: 500 }]);
    last().msg(['EVENT', id, ev('a')]);
    last().msg(['EVENT', id, ev('b')]);
    last().msg(['EOSE', id]);
    expect((await p).map((e) => e.id)).toEqual(['a', 'b']);
    expect(last().sent.at(-1)).toEqual(['CLOSE', id]);
    expect(events).toEqual([]); // fetched events are not kept-subscription events

    const q = r.fetch([{ kinds: [1] }], { timeoutMs: 500 });
    const [, id2] = last().sent.at(-1);
    expect(id2).not.toBe(id);
    last().msg(['EVENT', id2, ev('c')]);
    vi.advanceTimersByTime(500);
    expect((await q).map((e) => e.id)).toEqual(['c']);

    const c = r.fetch([{ kinds: [1] }]);
    last().msg(['CLOSED', last().sent.at(-1)[1], 'error: too many']);
    expect(await c).toEqual([]);
  });

  test("publish resolves on the relay's OK; false, a timeout or a drop is not ok", async () => {
    const r = make();
    expect(await r.publish(ev('x'))).toEqual({ ok: false, message: 'not connected' });
    r.connect();
    last().open();
    const a = r.publish(ev('x'));
    expect(last().sent.at(-1)).toEqual(['EVENT', ev('x')]);
    last().msg(['OK', 'x', true, '']);
    expect(await a).toEqual({ ok: true, message: '' });
    const b = r.publish(ev('y'));
    last().msg(['OK', 'y', false, 'invalid: bad signature']);
    expect(await b).toEqual({ ok: false, message: 'invalid: bad signature' });
    const c = r.publish(ev('z'));
    vi.advanceTimersByTime(10_000);
    expect(await c).toEqual({ ok: false, message: 'timeout' });
    const d = r.publish(ev('w'));
    const f = r.fetch([{ kinds: [1] }]);
    last().drop();
    expect(await d).toEqual({ ok: false, message: 'disconnected' });
    expect(await f).toEqual([]);
  });

  test('reconnect with backoff (1 s doubling to 5 min, ±20 %); a first EOSE or 30 s open resets it; subscriptions re-sent', () => {
    expect([0, 1, 2, 3, 8, 9, 20].map((n) => backoffMs(n, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 256000, 300000, 300000]);
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(0, () => 1)).toBe(1200);
    const r = make();
    r.sub('follow', [{ kinds: [34601] }]);
    r.connect();
    last().open();
    last().drop();
    expect(r.state).toBe('closed');
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().drop(); // failed again before opening: 2 s
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    last().open();
    expect(opened).toBe(2);
    expect(last().sent).toEqual([['REQ', 'follow', { kinds: [34601] }]]);
    last().drop(); // an open that does not last does not reset the backoff: 4 s
    vi.advanceTimersByTime(3999);
    expect(FakeSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(4);
    last().open();
    last().msg(['EOSE', 'follow']); // the relay answered: a working connection, the backoff starts over
    last().drop();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(5);
    last().open();
    vi.advanceTimersByTime(30_000); // or 30 s open
    last().drop();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(6);
    expect(states.slice(0, 9)).toEqual(['connecting', 'open', 'closed', 'connecting', 'closed', 'connecting', 'open', 'closed', 'connecting']);
  });

  test('a relay that accepts and drops every connection is not hammered (1, 2, 4, 8 s …)', () => {
    const r = make();
    r.connect();
    let t = 0;
    for (const wait of [1000, 2000, 4000, 8000, 16000]) {
      last().open();
      vi.advanceTimersByTime(50);
      last().drop();
      const n = FakeSocket.all.length;
      vi.advanceTimersByTime(wait - 1);
      expect(FakeSocket.all).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all).toHaveLength(n + 1);
      t += wait + 50;
    }
    expect(t).toBe(31_250);
    expect(FakeSocket.all).toHaveLength(6);
  });

  test('close() stops for good; a socket that cannot be made is retried', () => {
    const r = make();
    r.connect();
    last().open();
    r.close();
    expect(r.state).toBe('closed');
    vi.advanceTimersByTime(600_000);
    expect(FakeSocket.all).toHaveLength(1);

    let n = 0;
    const Bad = class extends FakeSocket {
      constructor(url) {
        if (n++ === 0) throw new Error('blocked by CSP');
        super(url);
      }
    };
    const s = make({ WebSocket: Bad });
    s.connect();
    expect(s.state).toBe('closed');
    expect(s.error).toMatch(/blocked by CSP/);
    vi.advanceTimersByTime(1000);
    expect(s.state).toBe('connecting');
    last().open();
    expect(s.error).toBe('');
  });
});
