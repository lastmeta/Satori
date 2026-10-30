// The Nostr outbox (src/neuron/outbox.js): kept across reloads, sent when a relay opens, dropped once answered.
import { expect, test } from 'vitest';
import { createOutbox, capEach, answered } from './outbox.js';

const kv = () => {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, structuredClone(v)); }, checkpoint: async () => {} };
};
const relayEntry = (url, state, reply) => {
  const sent = [];
  return { url, sent, relay: { state, publish: async (ev) => { sent.push(ev.id); return reply(ev); } } };
};

test('kept for each relay; sent where open; what it answered (or refused for good) dropped, the rest kept for the next open', async () => {
  const db = kv();
  const box = createOutbox({ db, writes: () => true });
  const a = relayEntry('wss://a', 'open', (ev) => (ev.id === '2' ? { ok: false, message: 'timeout' } : { ok: false, message: 'duplicate: have it' }));
  const b = relayEntry('wss://b', 'closed', () => ({ ok: true }));
  await box.keep([{ id: '1' }, { id: '2' }], [a, b]);
  expect(db.m.get('nostr_outbox').map((x) => `${x.url} ${x.event.id}`)).toEqual(['wss://a 1', 'wss://a 2', 'wss://b 1', 'wss://b 2']);
  await box.flush(a);
  await box.flush(b); // not open: nothing sent
  expect([a.sent, b.sent]).toEqual([['1', '2'], []]);
  expect(db.m.get('nostr_outbox').map((x) => `${x.url} ${x.event.id}`)).toEqual(['wss://a 2', 'wss://b 1', 'wss://b 2']);
});

test('a relay we do not write to is sent nothing; the newest 100 kept per relay; what counts as answered', async () => {
  const db = kv();
  const box = createOutbox({ db, writes: () => false });
  const a = relayEntry('wss://a', 'open', () => ({ ok: true }));
  await box.keep([{ id: '1' }], [a]);
  await box.flush(a);
  expect(a.sent).toEqual([]);
  const many = Array.from({ length: 105 }, (_, i) => ({ url: i % 2 ? 'wss://x' : 'wss://y', event: { id: String(i) } }));
  const kept = capEach([...many, ...Array.from({ length: 150 }, (_, i) => ({ url: 'wss://y', event: { id: `y${i}` } }))]);
  expect(kept.filter((x) => x.url === 'wss://x')).toHaveLength(52);
  expect(kept.filter((x) => x.url === 'wss://y').map((x) => x.event.id)).toEqual(Array.from({ length: 100 }, (_, i) => `y${i + 50}`));
  expect([{ ok: true }, { ok: false, message: 'blocked: no' }, { ok: false, message: 'timeout' }, { ok: false, message: 'rate-limited: slow' },
    { ok: false, message: 'error: x' }, { ok: false, message: 'disconnected' }].map(answered)).toEqual([true, true, false, false, false, false]);
});
