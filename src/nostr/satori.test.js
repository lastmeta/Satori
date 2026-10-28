// Satori's events and parsing against satorilib's client (test/fixtures/nostr-parity.json)
// and Lite's own value unwrapping. The content is compact JSON (JSON.stringify), not
// Python's json.dumps text: satorilib reads it with json.loads and takes the fields by
// name (docs/design/nostr.md#the-protocol-audit), so the same fields and values are what count.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { signEvent, verifyEvent } from './event.js';
import {
  KIND, observationEvent, announceEvent, tombstoneEvent, subscriptionEvent, relayListEvent, predMetadata,
  catalog, tombstoned, parseObservation, numericValue, pyFloat, relayUuid, predValue,
  deliveryEvent, heartbeatEvent, paymentEvent, paymentJson, deliveryOf, parseSubscription,
} from './satori.js';

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/nostr-parity.json', import.meta.url)));
const live = JSON.parse(readFileSync(new URL('../../test/fixtures/nostr-live.json', import.meta.url)));
const PROVIDER = 'e5e6ce948344b1e0178f9ccf49fcb499b4b4f00fc09c7637535ee82fc7bf503d';
const now = fx.now;
const sub = { stream_name: 'btc-usd-price', provider_pubkey: PROVIDER, name: 'Bitcoin USD Price', cadence_seconds: 900,
  pred_created_at: 1792000000 };
const sign = (t) => signEvent(t, fx.secretHex);
const same = (made, want) => {
  expect(made.kind).toBe(want.kind);
  expect(made.tags).toEqual(want.tags);
  const parsed = (e) => (e.content === '' ? '' : JSON.parse(e.content));
  expect(parsed(made)).toStrictEqual(parsed(want)); // the same fields, no more or fewer, the same values
  if (made.content) expect(made.content).toBe(JSON.stringify(JSON.parse(made.content))); // compact
  expect(made.created_at).toBe(want.created_at);
  expect(verifyEvent(made)).toBe(true);
};

describe("the events, as satorilib's client makes them", () => {
  test('_pred observation (34601)', () => {
    same(sign(observationEvent({ stream: 'btc-usd-price_pred', value: '80100.5', seq: 1, timestamp: now, now })),
      fx.events.prediction);
  });
  test('_pred announcement (34600), metadata as start.py builds it', () => {
    const meta = predMetadata({ sub, pubkey: fx.pubkeyHex, aliasPubkey: '02' + '11'.repeat(32) });
    // Lite's, plus the source's address as NIP-01's indexed `a` tag (the owner, 2026-10-28): a relay answers
    // {"#a": ["34600:<provider>:<stream>"]} with that stream's predictions; Lite reads source_* and ignores it
    const e = announceEvent(meta, now);
    expect(e.tags.at(-1)).toEqual(['a', `34600:${sub.provider_pubkey}:${sub.stream_name}`]);
    same(sign({ ...e, tags: e.tags.slice(0, -1) }), fx.events.announce);
  });
  test('_pred tombstone (34600, status=deleted)', () => {
    same(sign(tombstoneEvent('btc-usd-price_pred', fx.pubkeyHex, now)), fx.events.tombstone);
  });
  test('subscribe and unsubscribe (34602)', () => {
    const s = { stream: 'btc-usd-price', provider: PROVIDER, subscriber: fx.pubkeyHex, now };
    same(sign(subscriptionEvent(s)), fx.events.subscribe);
    same(sign(subscriptionEvent({ ...s, unsubscribe: true })), fx.events.unsubscribe);
  });
  test('NIP-65 relay list (10002)', () => {
    same(sign(relayListEvent(['ws://satorian.satorinet.io:7777'], now)), fx.events.relayList);
  });
  test('kinds', () => {
    expect(KIND).toEqual({ ANNOUNCE: 34600, OBSERVATION: 34601, SUBSCRIPTION: 34602, PAYMENT: 34603, RELAY_LIST: 10002 });
  });
  test('a name falls back to the stream; no cadence is null', () => {
    const meta = predMetadata({ sub: { ...sub, name: '', cadence_seconds: null }, pubkey: fx.pubkeyHex, aliasPubkey: '02ab' });
    expect(meta).toMatchObject({ stream_name: 'btc-usd-price_pred', name: 'Predictions for btc-usd-price', cadence_seconds: null });
  });
});

describe("the paid stream's events (docs/design/market.md#selling-and-buying-over-the-relays), as satorilib's", () => {
  const SUB = 'ab'.repeat(32);
  const market = { chain: 84532, contract: '0xa6DCa52936EAb8DD1EC9f8AD98e75D1Afb0DC16c', token: '0x4dee947383d5C9c8E421F55Fe3518a29324aE469',
    payee: '0x' + '12'.repeat(20) };
  test("a priced `_pred` announcement: encrypted, Lite's price_per_obs (satoshis) the one price, the channel in metadata.market; free again without one", () => {
    const meta = predMetadata({ sub, pubkey: fx.pubkeyHex, aliasPubkey: '02ab', listing: { price_per_obs: 100000, market } });
    expect(meta).toMatchObject({ encrypted: true, price_per_obs: 100000,
      metadata: { source_stream_name: 'btc-usd-price', source_provider_pubkey: PROVIDER, alias_pubkey: '02ab', market } });
    const e = sign(announceEvent(meta, now));
    expect(Object.keys(JSON.parse(e.content))).toEqual(Object.keys(JSON.parse(fx.events.announce.content))); // Lite's fields, no more
    expect(catalog([e])[0]).toMatchObject({ encrypted: true, price_per_obs: 100000, metadata: { market } });
    const free = predMetadata({ sub, pubkey: fx.pubkeyHex, aliasPubkey: '02ab', listing: null });
    expect(free).toMatchObject({ encrypted: false, price_per_obs: 0 });
    expect(free.metadata).not.toHaveProperty('market');
  });
  test("a delivery (34601) as publish_observation's per subscriber (client.py:621-660), its d the stream and the subscriber; read back", () => {
    const e = sign(deliveryEvent({ stream: 'x_pred', subscriber: SUB, seq: 7, timestamp: 1792000100, content: 'abc?iv=def', now }));
    expect(e).toMatchObject({ kind: 34601, created_at: now, content: 'abc?iv=def', tags: [['d', `x_pred:${SUB}`], ['p', SUB], ['stream', 'x_pred'],
      ['seq', '7'], ['timestamp', '1792000100'], ['satori', 'observation']] });
    expect(deliveryOf(e)).toEqual({ stream_name: 'x_pred', provider: fx.pubkeyHex, subscriber: SUB, seq: 7, timestamp: 1792000100, id: e.id });
    expect(parseObservation(e)).toBeNull(); // not JSON: never read as a free observation
    expect(deliveryOf(sign(observationEvent({ stream: 'x_pred', value: '1', seq: 1, timestamp: now, now })))).toBeNull(); // no p
    expect(deliveryOf({ ...e, tags: e.tags.filter((t) => t[0] !== 'seq') })).toBeNull();
  });
  test("the heartbeat (34601, no value: client.py:665-680) on the stream's own d; never an observation", () => {
    const e = sign(heartbeatEvent({ stream: 'x_pred', seq: 7, timestamp: 1792000100, now }));
    expect(e).toMatchObject({ kind: 34601, content: '', tags: [['d', 'x_pred'], ['stream', 'x_pred'], ['seq', '7'], ['timestamp', '1792000100'],
      ['satori', 'heartbeat']] });
    expect(parseObservation(e)).toBeNull();
  });
  test("a payment (34603) as send_payment's (client.py:1216-1283): Lite's amount_sats, the voucher in place of tx_id", () => {
    const e = sign(paymentEvent({ stream: 'x_pred', provider: SUB, seq: 8, content: 'c?iv=d', now }));
    expect(e).toMatchObject({ kind: 34603, content: 'c?iv=d', tags: [['d', 'x_pred'], ['p', SUB], ['stream', 'x_pred'], ['seq', '8']] });
    const voucher = { channel: '0x' + '9'.repeat(64), cumulative: '2000', signature: '0x' + '1'.repeat(130) };
    expect(JSON.parse(paymentJson({ from: fx.pubkeyHex, to: SUB, stream: 'x_pred', seq: 8, amountSats: 1000, timestamp: now, voucher })))
      .toStrictEqual({ from_pubkey: fx.pubkeyHex, to_pubkey: SUB, stream_name: 'x_pred', seq_num: 8, amount_sats: 1000, timestamp: now, voucher });
  });
  test('a subscription with its payment channel (34602), and an unsubscribe, read back', () => {
    const channel = { chain: 84532, contract: market.contract, id: '0x' + '9'.repeat(64), binding: '0x' + '2'.repeat(130) };
    const e = sign(subscriptionEvent({ stream: 'x_pred', provider: SUB, subscriber: fx.pubkeyHex, now, paymentChannel: channel }));
    expect(JSON.parse(e.content)).toStrictEqual({ subscriber_pubkey: fx.pubkeyHex, stream_name: 'x_pred', nostr_pubkey: SUB, timestamp: now,
      payment_channel: channel });
    expect(parseSubscription(e)).toEqual({ subscriber: fx.pubkeyHex, stream_name: 'x_pred', provider: SUB, channel, unsubscribe: false });
    const u = sign(subscriptionEvent({ stream: 'x_pred', provider: SUB, subscriber: fx.pubkeyHex, now, unsubscribe: true }));
    expect(parseSubscription(u)).toEqual({ subscriber: fx.pubkeyHex, stream_name: 'x_pred', provider: SUB, channel: null, unsubscribe: true });
    expect(parseSubscription({ ...e, content: 'nope' })).toBeNull();
    expect(parseSubscription({ ...e, content: JSON.stringify({ stream_name: 'x' }) })).toBeNull();
  });
});

describe("the value: Lite's _numericObservationValue", () => {
  test('every case Lite ran (start.py)', () => {
    for (const { value, float } of fx.numericValue) {
      expect(numericValue(value), JSON.stringify(value)).toBe(float === null ? null : pyFloat(float));
    }
  });
  test("Python's float() of a string", () => {
    expect(pyFloat(' 12 ')).toBe(12);
    expect(pyFloat('1_000.5')).toBe(1000.5);
    expect(pyFloat('.5')).toBe(0.5);
    expect(pyFloat('5.')).toBe(5);
    expect(pyFloat('-1e-3')).toBe(-0.001);
    expect(pyFloat('-Infinity')).toBe(-Infinity);
    expect(pyFloat('nan')).toBeNaN();
    for (const bad of ['', ' ', '0x10', '1__0', '_1', '1e', 'e5', '.', '1,5', '12abc']) expect(pyFloat(bad), bad).toBeNull();
  });
  test('the published value: the forecast one cadence ahead as text (not Lite\'s t2), else an echo as Lite', () => {
    expect(predValue({ t1: 80050.5, t2: 80100.5, value: 80050.5 }, '80000')).toBe('80050.5');
    expect(predValue({ t1: 82234, t2: 82234, value: 82234 }, '82234')).toBe('82234'); // Lite prints 82234.0; float() reads both
    expect(predValue(null, 'abc')).toBe('abc');
    expect(predValue(null, { raw: '1', unit: 'tick' })).toBe('{"raw":"1","unit":"tick"}');
    expect(predValue(null, 7)).toBe('7');
    expect(predValue(null, null)).toBe('null');
  });
});

test("the relay model uuid, pinned in Lite's tests (relay_ids.py)", () => {
  const { provider, stream, uuid, predUuid } = fx.relayUuid;
  expect(relayUuid(provider, stream)).toBe('e6673aad-177a-5f82-b16a-f045d2bc246b');
  expect(relayUuid(provider, stream)).toBe(uuid);
  expect(relayUuid(provider, `${stream}_pred`)).toBe(predUuid);
  expect(relayUuid(`  ${provider.toUpperCase()} `, stream)).toBe(uuid);
});

describe('intake parsing', () => {
  test('live events', () => {
    const [btc, bridge] = live.events;
    expect(parseObservation(btc)).toEqual({ stream_name: 'btc-usd-price', provider: PROVIDER, timestamp: 1792078200,
      value: '82234', seq: 10600, id: btc.id });
    expect(parseObservation(bridge)).toMatchObject({ stream_name: 'satori-84532-1', seq: 2,
      value: { raw: '59058240589371161', unit: 'raw', round: 20741 } });
  });
  test('skipped: empty content (a heartbeat), not JSON, no stream or seq', () => {
    const e = live.events[0];
    expect(parseObservation({ ...e, content: '' })).toBeNull();
    expect(parseObservation({ ...e, content: 'x' })).toBeNull();
    expect(parseObservation({ ...e, content: '[1]' })).toBeNull();
    expect(parseObservation({ ...e, content: '{"stream_name": "a", "timestamp": 1, "value": "1"}' })).toBeNull();
    expect(parseObservation({ ...e, content: '{"timestamp": 1, "value": "1", "seq_num": 1}' })).toBeNull();
    expect(parseObservation({ ...e, kind: 34600 })).toBeNull();
  });
});

describe('the catalog (discover)', () => {
  const ann = (pubkey, d, at, extra = {}, tags = []) => ({
    id: `${pubkey}${d}${at}`, pubkey, created_at: at, kind: 34600, sig: '',
    tags: [['d', d], ['satori', 'datastream'], ...tags],
    content: JSON.stringify({ stream_name: d, nostr_pubkey: pubkey, name: d.toUpperCase(), description: '', encrypted: false,
      price_per_obs: 0, created_at: 1, cadence_seconds: 900, tags: ['x'], approval_required: false, metadata: null, ...extra }),
  });
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  test('newest per (author, d); tombstones dropped; _pred marked; bad content skipped', () => {
    const list = catalog([
      ann(A, 's1', 10), ann(A, 's1', 20, { name: 'newer' }),
      ann(A, 's2', 30), ann(A, 's2', 40, {}, [['status', 'deleted']]),
      ann(A, 's3', 50, {}, [['status', 'deleted']]), ann(A, 's3', 60),
      ann(B, 's1', 5), ann(B, 's1_pred', 6),
      { ...ann(B, 'bad', 7), content: 'nope' },
    ]);
    expect(list.map((s) => [s.pubkey[0], s.stream_name, s.name, s.pred])).toEqual([
      ['a', 's3', 'S3', false], ['a', 's1', 'newer', false], ['b', 's1_pred', 'S1_PRED', true], ['b', 's1', 'S1', false],
    ]);
    expect(list[1]).toMatchObject({ cadence_seconds: 900, price_per_obs: 0, tags: ['x'], created_at: 20 });
  });
  test('tombstoned: the (author, d) whose newest announcement is a tombstone, as `pubkey:d`', () => {
    expect(tombstoned([
      ann(A, 's1', 10), ann(A, 's2', 30), ann(A, 's2', 40, {}, [['status', 'deleted']]),
      ann(A, 's3', 50, {}, [['status', 'deleted']]), ann(A, 's3', 60), ann(B, 's1_pred', 6, {}, [['status', 'deleted']]), null,
    ])).toEqual(new Set([`${A}:s2`, `${B}:s1_pred`]));
  });
  test('a malformed event is skipped, not a crash: tags not arrays of strings, a d that is not a string', () => {
    const good = ann(A, 'ok', 5);
    for (const bad of [{ ...ann(B, 'x', 9), tags: [null] }, { ...ann(B, 'x', 9), tags: [['d', 5]] },
      { ...ann(B, 'x', 9), tags: 'd' }, { ...ann(B, 'x', 9), tags: [['d', 'x'], ['t', null]] }, null, 7]) {
      expect(catalog([good, bad]).map((e) => e.stream_name)).toEqual(['ok']);
    }
  });
  test('events are not mutated and the source event is kept for the subscribe check', () => {
    const e = sign(announceEvent(predMetadata({ sub, pubkey: fx.pubkeyHex, aliasPubkey: '02' }), now));
    const [s] = catalog([e]);
    expect(s.event).toBe(e);
    expect(verifyEvent(s.event)).toBe(true);
  });
});
