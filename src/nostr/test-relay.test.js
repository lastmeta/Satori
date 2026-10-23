// The dev/test relay (scripts/test-relay.mjs) with this app's relay client over
// real sockets: what the e2e relies on.
import { afterAll, beforeAll, expect, test } from 'vitest';
import WebSocket from 'ws';
import { startRelay } from '../../scripts/test-relay.mjs';
import { connectProvider, PRODUCTION } from '../../scripts/provider.mjs';
import { createRelay } from './relay.js';
import { signEvent } from './event.js';
import { announceEvent, observationEvent, tombstoneEvent } from './satori.js';

const SECRET = 'dd278564ca11c31ffb929b807c65d07a7cb0fddfd26b2d97a91f84ed0b3086e4';
const PUB = '62756113cd917a659263ead50da0f538d97a5d4cbf0c573464140364f9a98cc8';
const now = Math.floor(Date.now() / 1000);
let server;
let relay;
const live = [];

beforeAll(async () => {
  server = await startRelay({ port: 0, host: '127.0.0.1' });
  relay = createRelay(`ws://127.0.0.1:${server.port}`, { WebSocket, onEvent: (id, e) => live.push([id, e.id]) });
  const opened = new Promise((resolve) => { relay.connect(); const t = setInterval(() => relay.state === 'open' && (clearInterval(t), resolve())); });
  await opened;
});
afterAll(async () => {
  relay.close();
  await server.close();
});

const sign = (t) => signEvent(t, SECRET);
const meta = (name, created_at = 1) => ({ stream_name: name, nostr_pubkey: PUB, created_at, cadence_seconds: 60, tags: ['x'] });

test('EVENT: OK true; bad signature, the far future refused; duplicates', async () => {
  const e = sign(announceEvent(meta('s1'), now - 10));
  expect(await relay.publish(e)).toEqual({ ok: true, message: '' });
  expect(await relay.publish(e)).toMatchObject({ ok: true, message: expect.stringMatching(/^duplicate/) });
  expect((await relay.publish({ ...e, content: 'x' })).ok).toBe(false);
  expect(await relay.publish(sign(announceEvent(meta('s9'), now + 1000)))).toMatchObject({ ok: false, message: expect.stringMatching(/future/) });
});

test('replaceable by (pubkey, kind, d): the newest stays; an older one is refused', async () => {
  const a = sign(observationEvent({ stream: 'obs', value: '1', seq: 1, timestamp: now - 5 }));
  const b = sign(observationEvent({ stream: 'obs', value: '2', seq: 2, timestamp: now - 4 }));
  expect((await relay.publish(a)).ok).toBe(true);
  expect((await relay.publish(b)).ok).toBe(true);
  expect((await relay.publish(sign(observationEvent({ stream: 'obs', value: '0', seq: 0, timestamp: now - 9 })))).ok).toBe(false);
  const got = await relay.fetch([{ kinds: [34601], authors: [PUB], '#d': ['obs'] }]);
  expect(got.map((e) => e.id)).toEqual([b.id]);
  // a tombstone replaces the announcement
  expect((await relay.publish(sign(tombstoneEvent('s1', PUB, now)))).ok).toBe(true);
  const ann = await relay.fetch([{ kinds: [34600], '#d': ['s1'] }]);
  expect(ann).toHaveLength(1);
  expect(ann[0].tags).toContainEqual(['status', 'deleted']);
});

test('REQ filters, limit and until; kept subscriptions get live events', async () => {
  for (let i = 0; i < 3; i++) await relay.publish(sign(announceEvent(meta(`p${i}`), now - 100 + i)));
  const newest2 = await relay.fetch([{ kinds: [34600], '#d': ['p0', 'p1', 'p2'], limit: 2 }]);
  expect(newest2.map((e) => e.created_at)).toEqual([now - 98, now - 99]);
  const older = await relay.fetch([{ kinds: [34600], '#d': ['p0', 'p1', 'p2'], until: now - 99 }]);
  expect(older.map((e) => e.created_at)).toEqual([now - 99, now - 100]);
  expect(await relay.fetch([{ kinds: [34600], authors: ['b'.repeat(64)] }])).toEqual([]);

  relay.sub('follow', [{ kinds: [34601], authors: [PUB], '#d': ['live'] }]);
  await new Promise((r) => setTimeout(r, 50));
  const e = sign(observationEvent({ stream: 'live', value: '5', seq: 1, timestamp: now }));
  await relay.publish(e);
  await relay.publish(sign(observationEvent({ stream: 'other', value: '5', seq: 1, timestamp: now })));
  await new Promise((r) => setTimeout(r, 50));
  expect(live).toEqual([['follow', e.id]]);
});

test('a malformed REQ or EVENT is refused, and the relay lives on', async () => {
  const raw = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const got = [];
  raw.on('message', (m) => got.push(JSON.parse(m)));
  await new Promise((r) => raw.once('open', r));
  for (const bad of [['REQ', 'x', { ids: 5 }], ['REQ', 'y', { kinds: 'a' }], ['REQ', 'z', { '#d': 'x' }], ['REQ', 'w', { since: 'x' }],
    ['EVENT', { id: 5 }], ['EVENT', null], ['CLOSE', 5]]) raw.send(JSON.stringify(bad));
  await new Promise((r) => setTimeout(r, 100));
  expect(got.filter((m) => m[0] === 'CLOSED').map((m) => m[1])).toEqual(['x', 'y', 'z', 'w']);
  expect(got.filter((m) => m[0] === 'OK').every((m) => m[2] === false)).toBe(true);
  expect(raw.readyState).toBe(1);
  expect((await relay.fetch([{ kinds: [34600], limit: 1 }])).length).toBe(1);
  raw.close();
});

test("scripts/provider.mjs refuses the production relays: satorian, its wss front, and Central's relay", async () => {
  for (const url of ['ws://satorian.satorinet.io:7777', 'wss://relay.satorinet.io', 'wss://relay.satorinet.io/',
    'wss://nostr.satorinet.io', 'WSS://Relay.Satorinet.io']) {
    expect(PRODUCTION.test(url)).toBe(true);
    await expect(connectProvider({ url })).rejects.toThrow(/Not on the production relay/);
  }
  for (const url of ['ws://localhost:7778', 'ws://127.0.0.1:7781']) expect(PRODUCTION.test(url)).toBe(false);
});
