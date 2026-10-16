// The Nostr flow (docs/design/nostr.md) with fake relays and a real (in-memory) db:
// relays and the read-only flag, discover, subscribe, intake → forecast → `_pred`,
// announce on open, reconcile, NIP-65, unsubscribe.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb } from '../../test/memory-db.js';
import { signEvent, verifyEvent, nostrPubkey } from '../nostr/event.js';
import { announceEvent, observationEvent, tombstoneEvent, relayUuid } from '../nostr/satori.js';
import { forecast } from '../engine/index.js';
import { createNostr, FOLLOW_ID, MAX_STREAMS } from './nostr.js';

vi.setConfig({ testTimeout: 60_000 });

const ME = 'dd278564ca11c31ffb929b807c65d07a7cb0fddfd26b2d97a91f84ed0b3086e4';
const ME_PUB = nostrPubkey(ME);
const PROV = '3'.repeat(63) + '1';
const PROV_PUB = nostrPubkey(PROV);
const WALLET = '02' + 'ab'.repeat(32);
const CENTRAL_RELAY = 'ws://satorian.test:7777';
const USER_RELAY = 'ws://localhost:7778';
let clock;
const now = () => clock;

/** A relay the test drives: open(), deliver(event), the events published, a fetch responder. */
function fakeRelays() {
  const all = new Map();
  const make = (url, hooks) => {
    const r = {
      url, hooks, state: 'closed', error: '', subs: new Map(), published: [], closed: false, connects: 0,
      stored: [], // what fetch() answers from (filters are matched loosely: kinds, authors, #d, until)
      ok: true,
      connect() { r.connects++; if (r.state === 'closed') r.state = 'connecting'; },
      close() { r.closed = true; r.state = 'closed'; },
      open() { r.state = 'open'; hooks.onState?.('open'); hooks.onOpen?.(r); },
      drop() { r.state = 'closed'; hooks.onState?.('closed'); },
      sub(id, filters) { r.subs.set(id, filters); },
      unsub(id) { r.subs.delete(id); },
      async fetch(filters) {
        if (r.state !== 'open') throw new Error('not connected');
        const [f] = filters;
        return r.stored.filter((e) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey))
          && (!f['#d'] || e.tags.some((t) => t[0] === 'd' && f['#d'].includes(t[1])))
          && (f.until === undefined || e.created_at <= f.until))
          .sort((a, b) => b.created_at - a.created_at).slice(0, f.limit ?? 500);
      },
      mute: false, // never answers OK until release()
      held: [],
      log: null, // an array to record call order in
      async publish(e) {
        if (r.state !== 'open') return { ok: false, message: 'not connected' };
        r.published.push(e);
        r.log?.push(`publish ${e.kind}`);
        if (r.mute) return new Promise((resolve) => r.held.push(() => resolve({ ok: r.ok, message: '' })));
        return { ok: r.ok, message: '' };
      },
      release() { for (const f of r.held.splice(0)) f(); },
      deliver(e) { return hooks.onEvent(FOLLOW_ID, e); },
    };
    all.set(url, r);
    return r;
  };
  return { all, make, get: (url) => all.get(url) };
}

function fakeCentral(relays = [CENTRAL_RELAY]) {
  return {
    relayList: relays.map((relay_url) => ({ relay_url })),
    config: { max_streams: 60 },
    relays: vi.fn(async function relays() { if (this.fail) throw new Error('central down'); return this.relayList; }),
    relayConfig: vi.fn(async function relayConfig() { return this.config; }),
  };
}

const announce = (stream, o = {}, at = clock - 100) => signEvent(announceEvent({ stream_name: stream, nostr_pubkey: PROV_PUB,
  name: o.name ?? stream.toUpperCase(), created_at: 1, cadence_seconds: o.cadence ?? 900, tags: ['t1'], price_per_obs: o.price ?? 0,
  encrypted: o.encrypted ?? false, approval_required: o.approval ?? false }, at), PROV);
const observe = (stream, value, seq, timestamp = clock) =>
  signEvent(observationEvent({ stream, value, seq, timestamp, now: timestamp }), PROV);
const kinds = (r) => r.published.map((e) => [e.kind, e.tags.find((t) => t[0] === 'd')?.[1]]);

let db;
let relays;
let central;
let nostr;
let changes;
async function boot({ https = false, centralWrite = false, user = [USER_RELAY] } = {}) {
  db = await memoryDb();
  relays = fakeRelays();
  central = fakeCentral();
  changes = 0;
  nostr = createNostr({ db, key: { secret: ME, pubkey: ME_PUB }, walletPubkey: WALLET, central: () => central,
    makeRelay: relays.make, now, https, defaults: { relays: user, centralWrite }, onChange: () => changes++,
    setInterval: () => 0, clearInterval: () => {}, openWaitMs: 0 });
  await nostr.start();
}
const openAll = () => { for (const r of relays.all.values()) r.open(); };
const settle = () => nostr.idle();

beforeEach(() => { clock = 1_792_073_160; });

describe('relays', () => {
  test("central's relays (read only on the dev server) and the user's (written to); max_streams from central", async () => {
    await boot();
    expect(central.relayConfig).toHaveBeenCalledTimes(1);
    const s = await nostr.status();
    expect(s).toMatchObject({ pubkey: ME_PUB, maxStreams: 60, centralWrite: false, userRelays: [USER_RELAY] });
    expect(s.relays).toEqual([
      { url: CENTRAL_RELAY, from: ['central'], write: false, state: 'connecting', error: '' },
      { url: USER_RELAY, from: ['user'], write: true, state: 'connecting', error: '' },
    ]);
    expect(s.npub).toMatch(/^npub1/);
  });
  test('an https page cannot open ws:// (mixed content): blocked, except localhost', async () => {
    await boot({ https: true });
    const s = await nostr.status();
    expect(s.relays.map((r) => [r.url, r.state])).toEqual([[CENTRAL_RELAY, 'blocked'], [USER_RELAY, 'connecting']]);
    expect(relays.get(CENTRAL_RELAY)).toBeUndefined();
  });
  test('setRelays: ws/wss only; publish to central relays; a relay listed twice is written to if the user lists it', async () => {
    await boot();
    await expect(nostr.setRelays({ relays: ['https://x.test'] })).rejects.toThrow(/ws:\/\/ or wss:\/\//);
    await expect(nostr.setRelays({ relays: ['nope'] })).rejects.toThrow(/ws:\/\/ or wss:\/\//);
    let s = await nostr.setRelays({ relays: [' wss://r.test ', CENTRAL_RELAY, 'wss://r.test'] });
    expect(relays.get(USER_RELAY).closed).toBe(true);
    expect(s.userRelays).toEqual(['wss://r.test', CENTRAL_RELAY]);
    expect(s.relays.map((r) => [r.url, r.from, r.write])).toEqual([
      [CENTRAL_RELAY, ['central', 'user'], true], ['wss://r.test', ['user'], true]]);
    s = await nostr.setRelays({ relays: [], centralWrite: true });
    expect(s.relays.map((r) => [r.url, r.write])).toEqual([[CENTRAL_RELAY, true]]);
    expect(await db.get('nostr_relays')).toEqual([]);
    expect(await db.get('nostr_central_write')).toBe(true);
  });
  test('max_streams falls back to 100 when central does not say', async () => {
    db = await memoryDb();
    central = fakeCentral();
    central.relayConfig = vi.fn(async () => { throw new Error('down'); });
    nostr = createNostr({ db, key: { secret: ME, pubkey: ME_PUB }, walletPubkey: WALLET, central: () => central,
      makeRelay: fakeRelays().make, now, defaults: { relays: [], centralWrite: false }, setInterval: () => 0 });
    await nostr.start();
    expect((await nostr.status()).maxStreams).toBe(MAX_STREAMS);
    expect(MAX_STREAMS).toBe(100);
  });
});

describe('discover', () => {
  test('pages back with until over every open relay; newest per (author, d); tombstones dropped; _pred and subscribed marked', async () => {
    await boot();
    openAll();
    const c = relays.get(CENTRAL_RELAY);
    const u = relays.get(USER_RELAY);
    // 501 announcements on central's relay: the first page holds 500.
    for (let i = 0; i < 501; i++) c.stored.push(announce(`s${i}`, {}, clock - 1000 + i));
    c.stored.push(signEvent(tombstoneEvent('s5', PROV_PUB, clock), PROV));
    const both = announce('s2', {}, clock - 1000 + 2);
    c.stored.splice(2, 1, both);
    u.stored.push(announce('s1', { name: 'newer' }, clock), announce('s1_pred', {}, clock), both);
    const list = await nostr.discover();
    expect(list).toHaveLength(501); // 501 − s5 + s1_pred
    expect(list.find((s) => s.stream_name === 's1')).toMatchObject({ name: 'newer', pubkey: PROV_PUB, subscribed: false, pred: false });
    expect(list.find((s) => s.stream_name === 's0')).toBeTruthy();
    expect(list.find((s) => s.stream_name === 's5')).toBeUndefined();
    expect(list.find((s) => s.stream_name === 's1_pred').pred).toBe(true);
    expect(list[0].event).toBeUndefined(); // plain values for agents
    // Which relays sent each entry's (newest) announcement: where to find the stream.
    expect(list.find((s) => s.stream_name === 's1').relays).toEqual([USER_RELAY]);
    expect(list.find((s) => s.stream_name === 's0').relays).toEqual([CENTRAL_RELAY]);
    expect(list.find((s) => s.stream_name === 's2').relays.sort()).toEqual([CENTRAL_RELAY, USER_RELAY].sort());
  });
  test('no relay open: an error (right after a load it waits for the first one)', async () => {
    await boot();
    await expect(nostr.discover()).rejects.toThrow(/No relay is connected/);
    const later = createNostr({ db, key: { secret: ME, pubkey: ME_PUB }, walletPubkey: WALLET, central: () => central,
      makeRelay: relays.make, now, defaults: { relays: [USER_RELAY], centralWrite: false }, setInterval: () => 0, openWaitMs: 5000 });
    await later.start();
    relays.get(CENTRAL_RELAY).stored.push(announce('late'));
    const found = later.discover();
    setTimeout(() => relays.get(USER_RELAY).open(), 300); // one relay open is not enough while another connects
    setTimeout(() => relays.get(CENTRAL_RELAY).open(), 600);
    expect((await found).map((s) => s.stream_name)).toEqual(['late']);
  });
});

describe('subscribe → follow → intake → `_pred`', () => {
  async function subscribed(stream = 'btc', o) {
    await boot(o);
    openAll();
    await settle(); // the open's own work (announcements, NIP-65) first
    for (const r of relays.all.values()) r.published = [];
    relays.get(CENTRAL_RELAY).stored.push(announce(stream));
    return nostr.subscribe(PROV_PUB, stream);
  }

  test('subscribe stores the stream, publishes the 34602 and the `_pred` 34600 only where we write, and follows it', async () => {
    const row = await subscribed();
    const uuid = relayUuid(PROV_PUB, 'btc');
    expect(row).toMatchObject({ uuid, stream: 'btc', provider: PROV_PUB, name: 'BTC', cadence_seconds: 900, observation: null, prediction: null });
    expect(relays.get(CENTRAL_RELAY).published).toEqual([]); // read only
    const u = relays.get(USER_RELAY);
    expect(kinds(u)).toEqual([[34602, 'btc'], [34600, 'btc_pred']]);
    expect(u.published.every(verifyEvent)).toBe(true);
    expect(u.published[0].tags).toEqual([['d', 'btc'], ['p', PROV_PUB], ['stream', 'btc'], ['satori', 'subscription']]);
    const meta = JSON.parse(u.published[1].content);
    expect(meta).toMatchObject({ stream_name: 'btc_pred', nostr_pubkey: ME_PUB, name: 'Predictions for BTC', cadence_seconds: 900,
      created_at: clock, metadata: { source_stream_name: 'btc', source_provider_pubkey: PROV_PUB, wallet_pubkey: WALLET } });
    for (const r of relays.all.values()) {
      expect(r.subs.get(FOLLOW_ID)).toEqual([{ kinds: [34601], authors: [PROV_PUB], '#d': ['btc'] }]);
    }
    expect(await nostr.subscribe(PROV_PUB, 'btc')).toMatchObject({ uuid }); // again: no-op
    expect(kinds(u)).toHaveLength(2);
  });

  test('refused: a `_pred` stream, one no relay announces, paid/encrypted/approval streams, a forged announcement, over the cap', async () => {
    await boot();
    openAll();
    const c = relays.get(CENTRAL_RELAY);
    await expect(nostr.subscribe(PROV_PUB, 'x_pred')).rejects.toThrow(/prediction stream/);
    await expect(nostr.subscribe('zz', 'x')).rejects.toThrow(/64 hex/);
    await expect(nostr.subscribe(PROV_PUB, 'nope')).rejects.toThrow(/not announced/);
    c.stored.push(announce('paid', { price: 5 }), announce('enc', { encrypted: true }), announce('gate', { approval: true }));
    for (const s of ['paid', 'enc', 'gate']) await expect(nostr.subscribe(PROV_PUB, s)).rejects.toThrow(/later/);
    c.stored.push({ ...announce('forged'), content: announce('x').content });
    await expect(nostr.subscribe(PROV_PUB, 'forged')).rejects.toThrow(/not announced/); // a bad signature is not taken
    central.config = { max_streams: 2 };
    await nostr.start(); // the cap is read at start, as Lite
    c.stored.push(announce('a'), announce('b'), announce('c'));
    await nostr.subscribe(PROV_PUB, 'a');
    await nostr.subscribe(PROV_PUB, 'b');
    await expect(nostr.subscribe(PROV_PUB, 'c')).rejects.toThrow(/limit of 2/);
  });

  test('a new observation is stored, forecast one cadence ahead (the owner\'s rule) and published as `_pred` (seq + 1) where we write', async () => {
    await subscribed('btc');
    const c = relays.get(CENTRAL_RELAY);
    const u = relays.get(USER_RELAY);
    u.published = [];
    const values = [100, 101, 100, 102, 101, 103, 102, 104, 103, 105];
    const t0 = Math.floor(clock / 900) * 900 - values.length * 900;
    for (const [k, v] of values.entries()) {
      clock = t0 + (k + 1) * 900;
      await c.deliver(observe('btc', String(v), 50 + k, clock));
    }
    await settle();
    expect(u.published).toHaveLength(values.length);
    expect(c.published).toEqual([]);
    const lastPub = u.published.at(-1);
    const points = values.map((value, k) => ({ ts: t0 + (k + 1) * 900, value }));
    const f = forecast(points, { step: 900, horizon: 900 });
    expect(f).toMatchObject({ model: 'bar1', horizon: 900, value: f.t1 });
    expect(f.value).not.toBe(forecast(points, { step: 900 }).t2); // not two cadences ahead (Lite's t2)
    expect(JSON.parse(lastPub.content)).toEqual({ stream_name: 'btc_pred', timestamp: clock, value: String(f.value), seq_num: 10 });
    expect(lastPub.tags).toEqual([['d', 'btc_pred'], ['stream', 'btc_pred'], ['seq', '10'], ['satori', 'observation']]);
    expect(JSON.parse(u.published[0].content)).toMatchObject({ value: '100', seq_num: 1 }); // naive at first
    const [s] = (await nostr.status()).subscriptions;
    expect(s).toMatchObject({ observations: 10, observation: { seq: 59, value: 105, raw: '105', ts: clock },
      prediction: { stream: 'btc_pred', seq: 10, value: String(f.value), model: 'bar1', relays: 1, made_at: clock } });
    expect(changes).toBeGreaterThan(0);
  });

  test('a stream with no cadence is forecast a day ahead, in day steps (the default cadence is a day)', async () => {
    await boot();
    openAll();
    await settle();
    const c = relays.get(CENTRAL_RELAY);
    const u = relays.get(USER_RELAY);
    c.stored.push(announce('slow', { cadence: 0 }));
    await nostr.subscribe(PROV_PUB, 'slow');
    u.published = [];
    const values = [50, 51, 50, 52, 51, 53, 52, 54, 53, 55, 54];
    const t0 = Math.floor(clock / 86_400) * 86_400 - values.length * 86_400;
    for (const [k, v] of values.entries()) await c.deliver(observe('slow', String(v), k + 1, t0 + (k + 1) * 86_400));
    await settle();
    const points = values.map((value, k) => ({ ts: t0 + (k + 1) * 86_400, value }));
    const f = forecast(points, { step: 86_400, horizon: 86_400 });
    expect(f).toMatchObject({ model: 'bar1', horizon: 86_400 });
    expect(f.value).not.toBe(forecast(points, { step: 43_200, horizon: 43_200 }).value);
    expect(JSON.parse(u.published.at(-1).content)).toMatchObject({ stream_name: 'slow_pred', value: String(f.value) });
  });

  test('a 60 s stream is forecast in 60 s steps, 60 s ahead', async () => {
    await boot();
    openAll();
    await settle();
    const c = relays.get(CENTRAL_RELAY);
    const u = relays.get(USER_RELAY);
    c.stored.push(announce('fast', { cadence: 60 }));
    await nostr.subscribe(PROV_PUB, 'fast');
    u.published = [];
    const values = [50, 51, 50, 52, 51, 53, 52, 54, 53, 55, 54];
    const t0 = Math.floor(clock / 60) * 60 - values.length * 60;
    for (const [k, v] of values.entries()) {
      clock = t0 + (k + 1) * 60;
      await c.deliver(observe('fast', String(v), k + 1, clock));
    }
    await settle();
    const points = values.map((value, k) => ({ ts: t0 + (k + 1) * 60, value }));
    const f = forecast(points, { step: 60, horizon: 60 });
    expect(f).toMatchObject({ model: 'bar1', horizon: 60 });
    expect(JSON.parse(u.published.at(-1).content)).toMatchObject({ stream_name: 'fast_pred', value: String(f.value) });
  });

  test('intake skips: the same event from another relay, the same seq again, unsubscribed streams, bad signatures, heartbeats', async () => {
    await subscribed('btc');
    const u = relays.get(USER_RELAY);
    const c = relays.get(CENTRAL_RELAY);
    u.published = [];
    const e = observe('btc', '100', 1);
    await c.deliver(e);
    await u.deliver(e);
    await c.deliver(observe('btc', '101', 1, clock + 1)); // a new event id, the same seq
    await c.deliver(observe('eth', '5', 1)); // not subscribed
    await c.deliver({ ...observe('btc', '9', 2), sig: e.sig }); // forged
    await c.deliver(signEvent({ ...observationEvent({ stream: 'btc', value: '1', seq: 3, timestamp: clock }), content: '' }, PROV));
    await c.deliver(signEvent(observationEvent({ stream: 'btc', value: '7', seq: 4, timestamp: clock }), ME)); // another author
    await settle();
    expect(kinds(u)).toEqual([[34601, 'btc_pred']]);
    expect((await db.relayPredictions(relayUuid(PROV_PUB, 'btc'))).map((p) => [p.seq, p.value, p.obs_seq])).toEqual([[1, '100', 1]]);
  });

  test("a value with no number is echoed as Lite does; Lite's dict values are unwrapped", async () => {
    await subscribed('mix');
    const u = relays.get(USER_RELAY);
    const c = relays.get(CENTRAL_RELAY);
    u.published = [];
    await c.deliver(observe('mix', 'abc', 1));
    await c.deliver(observe('mix', { raw: '213397', unit: 'tick' }, 2));
    await c.deliver(observe('mix', { chainId: 1, raw: '42', unit: 'raw' }, 3));
    await c.deliver(observe('mix', '5', 4, 100)); // a time before 2000: no forecast
    await settle();
    expect(u.published.map((e) => JSON.parse(e.content).value)).toEqual(['abc', '{"raw":"213397","unit":"tick"}', '42', '5']);
    expect((await db.relayPredictions(relayUuid(PROV_PUB, 'mix'))).map((p) => p.model)).toEqual(['echo', 'naive', 'echo', 'echo']);
  });

  test('a publish no relay takes still advances the seq (as Lite) and says 0 relays', async () => {
    await subscribed('btc');
    const u = relays.get(USER_RELAY);
    u.ok = false;
    await relays.get(CENTRAL_RELAY).deliver(observe('btc', '100', 1));
    u.ok = true;
    await relays.get(CENTRAL_RELAY).deliver(observe('btc', '101', 2));
    await settle();
    expect((await db.relayPredictions(relayUuid(PROV_PUB, 'btc'))).map((p) => [p.seq, p.relays])).toEqual([[2, 1], [1, 0]]);
  });

  test('announce on every (re)connect where we write; reconcile re-announces, refetches the relay list and reconnects', async () => {
    await subscribed('btc');
    const u = relays.get(USER_RELAY);
    u.published = [];
    u.drop();
    u.open();
    await settle();
    expect(kinds(u)).toEqual([[34600, 'btc_pred']]);
    expect(relays.get(CENTRAL_RELAY).published).toEqual([]);
    central.relayList = [{ relay_url: 'wss://new.test' }];
    clock += 3600;
    await nostr.reconcile();
    expect(relays.get(CENTRAL_RELAY).closed).toBe(true);
    expect(relays.get('wss://new.test').connects).toBe(1);
    expect(kinds(u).slice(1)).toContainEqual([34600, 'btc_pred']);
    const before = u.connects;
    u.drop();
    await nostr.reconcile();
    expect(u.connects).toBe(before + 1);
    central.fail = true; // central down: the list stays
    await nostr.reconcile();
    expect((await nostr.status()).relays.map((r) => r.url)).toEqual(['wss://new.test', USER_RELAY]);
  });

  test('NIP-65 (10002) of the open relays, at most daily, where we write', async () => {
    await boot();
    openAll();
    const u = relays.get(USER_RELAY);
    const lists = () => u.published.filter((e) => e.kind === 10002);
    await nostr.reconcile();
    expect(lists()).toHaveLength(1);
    expect(lists()[0].tags).toEqual([['r', CENTRAL_RELAY], ['r', USER_RELAY]]);
    expect(relays.get(CENTRAL_RELAY).published).toEqual([]);
    clock += 3600;
    await nostr.reconcile();
    expect(lists()).toHaveLength(1);
    clock += 86400;
    await nostr.reconcile();
    expect(lists()).toHaveLength(2);
  });

  test('unsubscribe: the 34602 unsubscribe and the `_pred` tombstone; unfollowed; a later subscribe keeps the seq', async () => {
    await subscribed('btc');
    const u = relays.get(USER_RELAY);
    const c = relays.get(CENTRAL_RELAY);
    await c.deliver(observe('btc', '100', 1));
    await settle();
    u.published = [];
    const after = await nostr.unsubscribe(PROV_PUB, 'btc'); // → the status, as setRelays
    expect(after).toMatchObject({ pubkey: ME_PUB, subscriptions: [] });
    await settle();
    expect(kinds(u)).toEqual([[34602, 'btc'], [34600, 'btc_pred']]);
    expect(await db.get('nostr_outbox')).toEqual([]); // answered: nothing waits
    expect(u.published[0].tags).toContainEqual(['action', 'unsubscribe']);
    expect(u.published[1].tags).toEqual([['d', 'btc_pred'], ['satori', 'datastream'], ['status', 'deleted']]);
    for (const r of relays.all.values()) expect(r.subs.has(FOLLOW_ID)).toBe(false);
    await c.deliver(observe('btc', '101', 2));
    await settle();
    expect((await nostr.status()).subscriptions).toEqual([]);
    expect((await nostr.discover()).find((s) => s.stream_name === 'btc').subscribed).toBe(false);
    await expect(nostr.unsubscribe(PROV_PUB, 'eth')).rejects.toThrow(/Not subscribed/);
    await nostr.subscribe(PROV_PUB, 'btc');
    await c.deliver(observe('btc', '102', 3));
    await settle();
    expect((await db.relayPredictions(relayUuid(PROV_PUB, 'btc'), 1))[0].seq).toBe(2);
  });

  test('several providers: one #d filter each', async () => {
    await subscribed('btc');
    const OTHER = nostrPubkey('4'.repeat(64));
    relays.get(CENTRAL_RELAY).stored.push(announce('eth'), signEvent(announceEvent({ stream_name: 'x', nostr_pubkey: OTHER,
      created_at: 1, cadence_seconds: 60, tags: [] }, clock - 5), '4'.repeat(64)));
    await nostr.subscribe(PROV_PUB, 'eth');
    await nostr.subscribe(OTHER, 'x');
    const filters = relays.get(USER_RELAY).subs.get(FOLLOW_ID);
    expect(filters).toEqual(expect.arrayContaining([
      { kinds: [34601], authors: [PROV_PUB], '#d': ['btc', 'eth'] }, { kinds: [34601], authors: [OTHER], '#d': ['x'] }]));
    expect(filters).toHaveLength(2);
  });

  test('subscribe trusts only verified announcements by the asked provider with the asked name', async () => {
    await boot();
    openAll();
    const OTHER = '5'.repeat(64);
    const real = announce('btc', { price: 5, cadence: 3600 }, clock - 100); // the real stream is paid
    const other = signEvent(announceEvent({ stream_name: 'btc', nostr_pubkey: nostrPubkey(OTHER), name: 'other', created_at: 1,
      cadence_seconds: 1 }, clock), OTHER);
    const forged = { ...announce('btc', { cadence: 1 }, clock), sig: '00'.repeat(64) };
    const c = relays.get(CENTRAL_RELAY);
    c.fetch = async () => [real, other, forged, { ...announce('eth', {}, clock + 5) }];
    await expect(nostr.subscribe(PROV_PUB, 'btc')).rejects.toThrow(/later/);
    c.fetch = async () => [other, forged];
    await expect(nostr.subscribe(PROV_PUB, 'btc')).rejects.toThrow(/not announced/);
  });

  test("one `<name>_pred` per name: a second provider's stream of the same name is refused", async () => {
    await subscribed('btc');
    const OTHER = '5'.repeat(64);
    relays.get(CENTRAL_RELAY).stored.push(signEvent(announceEvent({ stream_name: 'btc', nostr_pubkey: nostrPubkey(OTHER),
      created_at: 1, cadence_seconds: 60 }, clock), OTHER));
    await expect(nostr.subscribe(nostrPubkey(OTHER), 'btc')).rejects.toThrow(/already predict btc from/);
    await nostr.unsubscribe(PROV_PUB, 'btc');
    expect(await nostr.subscribe(nostrPubkey(OTHER), 'btc')).toMatchObject({ provider: nostrPubkey(OTHER) });
  });

  test('a relay that never answers OK holds up neither subscribing nor intake; the count follows its OK', async () => {
    await boot();
    openAll();
    await settle();
    const u = relays.get(USER_RELAY);
    const c = relays.get(CENTRAL_RELAY);
    u.mute = true;
    c.stored.push(announce('a'), announce('b'));
    await nostr.subscribe(PROV_PUB, 'a');
    await nostr.subscribe(PROV_PUB, 'b');
    void nostr.reconcile(); // its re-announcements wait on the mute relay too
    await c.deliver(observe('a', '1', 1));
    await c.deliver(observe('b', '2', 1));
    await c.deliver(observe('a', '3', 2));
    const preds = async () => (await nostr.status()).subscriptions.map((s) => [s.stream, s.prediction?.seq, s.prediction?.relays]);
    expect((await preds()).sort()).toEqual([['a', 2, 0], ['b', 1, 0]]);
    u.release();
    await settle();
    u.release();
    await settle();
    expect((await preds()).sort()).toEqual([['a', 2, 1], ['b', 1, 1]]);
  });

  test('the seq, the observation and the prediction are checkpointed before the `_pred` is sent (as Lite commits first)', async () => {
    await subscribed('btc');
    const log = [];
    const u = relays.get(USER_RELAY);
    u.log = log;
    const checkpoint = db.checkpoint;
    db.checkpoint = async () => { log.push('checkpoint'); return checkpoint(); };
    await relays.get(CENTRAL_RELAY).deliver(observe('btc', '1', 1));
    await settle();
    expect(log.slice(0, 2)).toEqual(['checkpoint', 'publish 34601']);
  });

  test("central down at load: its last relay list (kept in meta) is used", async () => {
    await boot();
    expect(await db.get('nostr_central_relays')).toEqual([CENTRAL_RELAY]);
    nostr.stop();
    central.fail = true;
    const again = createNostr({ db, key: { secret: ME, pubkey: ME_PUB }, walletPubkey: WALLET, central: () => central,
      makeRelay: relays.make, now, defaults: { relays: [], centralWrite: false }, setInterval: () => 0, openWaitMs: 0 });
    await again.start();
    expect((await again.status()).relays.map((r) => [r.url, r.from])).toEqual([[CENTRAL_RELAY, ['central']]]);
  });

  test('an unsubscribe and its tombstone wait (kept over a reload) for a relay that is not open, and go when it opens', async () => {
    await subscribed('btc');
    const u = relays.get(USER_RELAY);
    u.drop();
    u.published = [];
    await nostr.unsubscribe(PROV_PUB, 'btc');
    expect(u.published).toEqual([]);
    expect((await db.get('nostr_outbox')).map((x) => [x.url, x.event.kind])).toEqual([[USER_RELAY, 34602], [USER_RELAY, 34600]]);
    nostr.stop(); // a reload
    const again = createNostr({ db, key: { secret: ME, pubkey: ME_PUB }, walletPubkey: WALLET, central: () => central,
      makeRelay: relays.make, now, defaults: { relays: [USER_RELAY], centralWrite: false }, setInterval: () => 0, openWaitMs: 0 });
    await again.start();
    relays.get(USER_RELAY).open();
    await again.idle();
    expect(kinds(relays.get(USER_RELAY)).filter(([k]) => k !== 10002)).toEqual([[34602, 'btc'], [34600, 'btc_pred']]);
    expect(await db.get('nostr_outbox')).toEqual([]);
  });
});
