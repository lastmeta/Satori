// The Nostr flow, as Satori Lite runs it (docs/design/nostr.md):
//   relays = central's /peer/relays + the user's; each relay: REQ follow, announce `<stream>_pred`
//   34601 in ─▶ subscribed? ─▶ verify ─▶ store once ─▶ forecast (one cadence ahead) ─▶ publish `<stream>_pred`
//   hourly: refetch the relay list, reconnect, re-announce; NIP-65 daily
//   the track record (docs/design/track-record.md): once relays are open, then hourly at most every 6 h, the catalog is
//   scanned for prediction streams; they and their sources are followed with the subscriptions, and a watched stream's
//   34601 is kept (src/neuron/records.js): never forecast, never published
//   paid streams (src/neuron/market.js, docs/design/market.md): a priced `_pred` is delivered encrypted to its buyers and
//   its public 34601 is a heartbeat; 34602/34603 addressed to us go to the market; a bought stream's delivery is
//   decrypted, paid and lands as a watched stream's; the hourly pass settles and withdraws
// Relay streams are apart from central's: own tables, and nothing goes to central.
// Intake runs one event at a time; sending (which waits for each relay's OK)
// runs beside it, so a slow or mute relay holds nothing up.
import { signEvent, verifyEvent, npub, SeenSet } from '../nostr/event.js';
import { createRelay } from '../nostr/relay.js';
import {
  KIND, PRED, observationEvent, announceEvent, tombstoneEvent, subscriptionEvent, relayListEvent, predMetadata,
  catalog, tombstoned, parseObservation, numericValue, predValue, relayUuid, heartbeatEvent,
} from '../nostr/satori.js';
import { createMarket, listingOf, amountOf } from './market.js';
import { AHEAD_S } from '../db/index.js';
import { explainForecast as engineForecast } from '../engine/index.js';
import { createWork } from './work.js';
import { createWatch, followFilters, WATCH_SCAN_S } from './records.js';
import { isRelayUrl, serial } from '../util.js';
import { EPOCH } from '../central/index.js';

export const MAX_STREAMS = 100; // network_db.py:14-36, until central says (relay-config)
export const DEFAULT_CADENCE_S = 86_400; // a stream that announces none: a day, the owner's default (docs/intent/engine.md)
/**
 * The engine's window for a relay stream, in its cadences (docs/design/nostr.md#data-growth): the intake, the training
 * pass and the Models tab read only this much back from the stream's newest observation, and the daily prune keeps no
 * more (a daily stream ~400 days; a 1-minute one ~7 h). The engine needs 6 lag pairs and 28 backtest origins.
 */
export const RELAY_WINDOW = 400;
export const RECONCILE_S = 3600; // start.py:292
export const RELAY_LIST_S = 86_400; // start.py:291
export const FOLLOW_ID = 'satori-follow'; // client.py:76
export const MARKET_ID = 'satori-market'; // 34602 and 34603 addressed to us (Lite's personal filter, client.py:1716-1733)
const PAGE = 500; // strfry's maxFilterLimit (client.py:72-75)
const MAX_FILTERS = 200; // strfry's maxReqFilterSize
const MAX_PAGES = 100;
const OUTBOX_MAX = 100; // unsubscribes and tombstones waiting for a relay
const VERIFY_SLICE = 20; // catalog events checked between yields (~4 ms each): the page stays responsive

const HEX64 = /^[0-9a-f]{64}$/;
const isLocal = (u) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname);
const safeEpoch = (t) => (Number.isFinite(t) && t > EPOCH[0] && t < EPOCH[1] ? Math.floor(t) : null);
const parseRaw = (raw) => {
  try { return JSON.parse(raw); } catch { return raw; }
};

/**
 * @param {object} o
 * @param {object} o.db the app's db
 * @param {{secret: string, pubkey: string}} o.key the Nostr key
 * (onPublished(relays): a `_pred` the relays took; onError(err): an intake that failed: both for Home's activity log)
 * @param {string} o.walletPubkey the identity's compressed pubkey (the announcement's wallet_pubkey)
 * @param {() => object} o.central the current central client (relays(), relayConfig())
 * @param {{relays: string[], centralWrite: boolean, wss?: Record<string, string>}} o.defaults Settings before the user
 * changes them, and `wss`: a ws:// relay → the wss:// address of the same relay, its stand-in where ws:// can't open (src/config.js)
 * @param {object} [o.work] what the neuron is doing (src/neuron/work.js): discover and subscribe say their steps
 * @param {boolean} [o.ws] whether the page's CSP allows ws:// (the dev server's does; a build's does not: csp.js)
 * @param {() => void} [o.onRecords] a watched stream's observation kept: the track records changed (records())
 * @param {object} [o.identity] our signer (the market's vouchers, binding, settle, close, withdraw); o.vaultAddress the
 * seller's payee; o.vault() the vault while unlocked (a Buy); o.chain() the channel client (src/neuron/base.js channels())
 */
export function createNostr({ db, key, walletPubkey, central, defaults, makeRelay = createRelay, identity = null, vaultAddress = null,
  vault = () => null, chain = async () => { throw new Error('No Base chain.'); },
  forecast = engineForecast, now = () => Date.now() / 1000, https = globalThis.location?.protocol === 'https:', ws = true,
  onChange = () => {}, onPublished = () => {}, onError = () => {}, onRecords = () => {}, setInterval: si = setInterval,
  clearInterval: ci = clearInterval, openWaitMs = 10_000, work: progress = createWork() }) {
  let maxStreams = MAX_STREAMS;
  let userRelays = defaults.relays;
  let centralWrite = defaults.centralWrite;
  let centralUrls = [];
  const standIns = defaults.wss ?? {};
  let relays = new Map(); // url → { url, from: Set, for: the ws:// address it stands in for, or null, relay, blocked, chunks }
  let timer = null;
  let lastReconcile = -Infinity; // when the last hourly pass began (s)
  let reconciling = null;
  const intakeLine = serial();
  const checked = new SeenSet(5000); // catalog signatures checked this page load (verifyEvent's seen), the 5,000 last used
  let prunedAt = -Infinity; // the last prune of the relay streams' observations (s)
  const sending = new Set();
  const log = (err) => console.error('[satori] nostr', err);
  // the track record: the watched prediction streams and their sources (src/neuron/records.js)
  const watch = createWatch({ db, me: key.pubkey, now, onChange: onRecords });
  // paid streams (src/neuron/market.js): what we sell and buy
  const market = createMarket({ db, key, identity, vaultAddress, vault, chain, now, onChange: () => onChange(),
    publish: (ev) => background(publish(ev)), sendKept: (events) => background(sendKept(events)) }); // idle() waits for them
  const marketLine = serial(); // the seller's 34602/34603, in order, beside the intake (each may read the chain)
  let watchedAt = -Infinity; // when the last scan for prediction streams worked (s)
  let watchInfo = { found: 0, left: 0, error: null };
  let watching = null; // the scan in flight
  let reached = new Set(); // the relays whose catalog the last scan that worked got
  const missed = new Set(); // relays that opened while a scan ran: scanned right after it when it did not reach them

  /** Intake runs one event at a time, in order; one that fails (the database, the engine) is reported (onError). */
  const work = (fn) => intakeLine(fn).catch((err) => {
    log(err);
    onError(err);
  });
  /** Sends run beside the intake queue: a relay that is slow to say OK (or never does) holds nothing up. */
  function background(p) {
    const q = Promise.resolve(p).catch(log).finally(() => sending.delete(q));
    sending.add(q);
    return q;
  }
  /** Resolves when the queued intake and every send so far are done. */
  async function idle() {
    for (;;) {
      const t0 = intakeLine.idle();
      await t0;
      if (sending.size) await Promise.all([...sending]);
      else if (t0 === intakeLine.idle()) return;
    }
  }
  const sign = (template) => signEvent(template, key.secret);
  const t = () => Math.floor(now());
  const writes = (e) => e.from.has('user') || (e.from.has('central') && centralWrite);
  const open = () => [...relays.values()].filter((e) => e.relay?.state === 'open');
  const writable = () => open().filter(writes);

  /** Publish to every open relay we write to, at once → how many said OK. */
  async function publish(event, targets = writable()) {
    const results = await Promise.all(targets.map((e) => e.relay.publish(event)));
    return results.filter((r) => r.ok).length;
  }

  /** Our `_pred` announcements, to the given relays, all at once (start.py:3442-3482). */
  async function announce(targets = writable()) {
    if (!targets.length) return;
    const events = await announcements(t());
    await Promise.all(events.map((ev) => publish(ev, targets)));
  }

  /** The follow REQ's filters: one per author over the subscriptions and the watched streams (followFilters). */
  async function filters() {
    const subs = (await db.relayStreams({ active: true })).map((s) => [s.provider_pubkey, s.stream_name]);
    return followFilters([...subs, ...watch.pairs(), ...market.pairs()]);
  }

  /** The follow REQ: one #d filter per provider, ≤ 200 filters per REQ (client.py:944-983). */
  function follow(e, list) {
    const id = (i) => (i ? `${FOLLOW_ID}-${i + 1}` : FOLLOW_ID);
    let i = 0;
    for (; i * MAX_FILTERS < list.length; i++) e.relay.sub(id(i), list.slice(i * MAX_FILTERS, (i + 1) * MAX_FILTERS));
    for (let j = i; j < (e.chunks ?? 0); j++) e.relay.unsub(id(j));
    e.chunks = i;
  }
  async function refollow() {
    const list = await filters();
    for (const e of relays.values()) if (e.relay) follow(e, list);
  }

  /** A `_pred`'s announcement: priced, with its listing (market.listing). */
  const announcementOf = (sub, at) => sign(announceEvent(predMetadata({ sub, pubkey: key.pubkey, walletPubkey,
    market: market.listing(sub.stream_name + PRED) }), at));
  const announcements = async (at) => (await db.relayStreams({ active: true })).map((sub) => announcementOf(sub, at));

  /** NIP-65 of the open relays, when the last one is a day old (start.py:370-389); one at a time. */
  let listing = null;
  const relayList = () => (listing ??= (async () => {
    const at = t();
    if (at - ((await db.get('nostr_relay_list_at')) ?? 0) < RELAY_LIST_S) return;
    if (!writable().length) return;
    if (!(await publish(sign(relayListEvent(open().map((e) => e.url), at))))) return;
    await db.set('nostr_relay_list_at', at);
    await db.checkpoint(); // OPFS keeps what is checkpointed: a reload must not send it again
  })().finally(() => { listing = null; }));

  // The outbox (meta.nostr_outbox): unsubscribes and tombstones for relays we
  // write to that were not open or did not answer; sent when they open.
  const outbox = serial();
  const editOutbox = (fn) => outbox(async () => {
    await db.set('nostr_outbox', fn((await db.get('nostr_outbox')) ?? []).slice(-OUTBOX_MAX));
    await db.checkpoint();
  });
  /** An answer, OK or not, means the relay has seen it; nothing to resend. */
  const answered = (r) => !['not connected', 'timeout', 'disconnected'].includes(r.message) || r.ok;
  async function flushOutbox(e) {
    await outbox.idle();
    const mine = ((await db.get('nostr_outbox')) ?? []).filter((x) => x.url === e.url);
    if (!mine.length || e.relay?.state !== 'open' || !writes(e)) return;
    const results = await Promise.all(mine.map((x) => e.relay.publish(x.event)));
    const done = new Set(mine.filter((x, i) => answered(results[i])).map((x) => x.event.id));
    await editOutbox((box) => box.filter((x) => !(x.url === e.url && done.has(x.event.id))));
  }
  /** Keep events for every relay we write to, then send them where it is open. */
  async function sendKept(events) {
    const targets = [...relays.values()].filter((e) => e.relay && writes(e));
    await editOutbox((box) => [...box, ...targets.flatMap((e) => events.map((event) => ({ url: e.url, event })))]);
    for (const e of targets) background(flushOutbox(e));
  }

  /**
   * A relay (re)connected: announce our `_pred` streams there (start.py:326-328), send what waits for it; the scan for
   * prediction streams, when none has worked in 6 h (the first open after a load starts it).
   */
  function opened(url, relay) {
    const e = relays.get(url);
    if (e?.relay !== relay) return;
    if (writes(e)) background(announce([e]));
    background(flushOutbox(e));
    background(relayList());
    scanDue(url);
    onChange();
  }

  // ws:// can't open from an https page (mixed content; localhost aside), nor anywhere under a build's CSP (csp.js)
  const blockedWhy = (url) => (!url.startsWith('ws://') ? null : !ws ? 'ws:// relays are not allowed in a build: use wss://'
    : https && !isLocal(url) ? 'ws:// cannot be opened from an https page' : null);

  /**
   * Central's relays and the user's, each with its roles (`from`). A ws:// relay this page can't open is reached at its
   * wss stand-in when it has one, as that same relay: its roles, and `for` the address it stands in for; the stand-in
   * also listed is one entry with both roles. Without one it is blocked (docs/design/nostr.md#relays-and-the-read-only-flag).
   */
  function applyRelays() {
    const want = new Map(); // url → { from: Set, for }
    for (const [from, list] of [['central', centralUrls], ['user', userRelays]]) {
      for (const listed of list) {
        const standIn = blockedWhy(listed) ? standIns[listed] : undefined;
        const url = standIn ?? listed;
        const w = want.get(url) ?? { from: new Set(), for: null };
        w.from.add(from);
        if (standIn) w.for = listed;
        want.set(url, w);
      }
    }
    for (const [url, e] of relays) if (!want.has(url)) e.relay?.close();
    const next = new Map();
    for (const [url, w] of want) {
      let e = relays.get(url);
      if (!e) {
        const why = blockedWhy(url);
        e = { url, blocked: !!why, why, relay: null, chunks: 0 };
        if (!e.blocked) {
          e.relay = makeRelay(url, {
            onOpen: (r) => opened(url, r),
            onEvent: (_id, ev) => { const at = now(); return work(() => intake(ev, at)); }, // when it arrived: before the queue
            onState: () => onChange(),
            onRefused: () => onChange(), // a follow chunk closed, or a NOTICE: status() says it
          });
        }
      }
      e.from = w.from;
      e.for = w.for;
      next.set(url, e);
    }
    const added = [...next.values()].filter((e) => e.relay && !relays.has(e.url));
    relays = next;
    return added;
  }

  async function connectNew(added) {
    const list = await filters();
    for (const e of added) {
      follow(e, list);
      e.relay.sub(MARKET_ID, [{ kinds: [KIND.SUBSCRIPTION, KIND.PAYMENT], '#p': [key.pubkey] }]);
      e.relay.connect();
    }
  }

  /**
   * The hourly pass (start.py:200-292): central's relay list again (kept when
   * central fails), connect new and dropped relays, re-announce, NIP-65.
   */
  function reconcile() {
    lastReconcile = now();
    reconciling ??= reconcileOnce().finally(() => { reconciling = null; });
    return reconciling;
  }
  async function reconcileOnce() {
    try {
      const list = await central().relays();
      const urls = [...new Set((Array.isArray(list) ? list : []).map((r) => String(r?.relay_url ?? '').trim()).filter(isRelayUrl))];
      if (JSON.stringify(urls) !== JSON.stringify(centralUrls)) await db.set('nostr_central_relays', urls);
      centralUrls = urls;
    } catch (err) {
      console.warn('[satori] relay list from central (the last one is kept)', err?.message ?? err);
    }
    const added = applyRelays();
    for (const e of relays.values()) if (e.relay?.state === 'closed' && !added.includes(e)) e.relay.connect();
    await connectNew(added);
    onChange();
    scanDue(); // not awaited: it waits for relays still connecting, and the pass need not
    await Promise.all([background(announce()), background(relayList()), background(prune()), background(market.pass())]);
  }

  /**
   * At most daily, in the hourly pass: each stream's observations older than its window go (db.pruneRelay, batched),
   * the watched streams' too (db.pruneWatch).
   */
  async function prune() {
    if (now() - prunedAt < RELAY_LIST_S) return;
    prunedAt = now();
    const n = await db.pruneRelay({ buckets: RELAY_WINDOW, now: now() });
    if (n) console.info(`[satori] relay observations pruned to each stream's window: ${n}`);
    const w = await watch.prune();
    if (w) console.info(`[satori] watched streams' observations pruned to each stream's window: ${w}`);
  }

  // ── the track record (docs/design/track-record.md) ──
  /**
   * A scan's catalog: the watched set kept from it, the follow REQ sent again when that changed; one at a time (a
   * Discover's and the scan's). Gone at once: what the scan saw tombstoned, and our own `_pred` of a stream we
   * unsubscribed from (a relay may still hold its announcement until our tombstone reaches it).
   */
  const applyLine = serial();
  const applyWatch = ({ list, gone = new Set(), reached: got = [] }) => applyLine(async () => {
    const all = await db.relayStreams();
    const live = new Set(all.filter((r) => r.active).map((r) => r.stream_name)); // one `<name>_pred` per name: another provider's may be live
    const retired = all.filter((r) => !r.active && !live.has(r.stream_name)).map((r) => `${key.pubkey}:${r.stream_name}${PRED}`);
    const r = await watch.apply(list, { gone: new Set([...gone, ...retired]), bought: market.bought() });
    watchedAt = now();
    reached = new Set(got);
    watchInfo = { found: r.found, left: r.left, error: null };
    if (r.changed) await refollow();
    onChange();
  });
  /** The scan for prediction streams (the work list's `watch`), one at a time; a failure is kept for status() and tried again. */
  function scanWatch() {
    watching ??= progress.run('watch', async (step) => {
      try {
        await applyWatch(await scan(step));
      } catch (err) {
        watchInfo = { ...watchInfo, error: err?.message ?? String(err) };
        // no relay open is expected now and then (it is tried again at the next relay open or hourly pass); anything else is worth a warning
        console[/No relay is connected/.test(watchInfo.error) ? 'info' : 'warn']('[satori] scan for prediction streams: tried again at the next relay open or hourly pass;', watchInfo.error);
      }
    }).finally(() => {
      watching = null;
      // a relay that opened while it ran and that it did not reach: once more now (one that keeps failing waits for its next open)
      const again = [...missed].some((u) => relays.get(u)?.relay?.state === 'open' && !reached.has(u));
      missed.clear();
      if (again) background(scanWatch());
    });
    return watching;
  }
  /**
   * The scan, in the background, when none has worked in 6 h and none is running; or when relay `url` opens and the
   * last scan that worked did not reach it (a partial scan does not count as done for that relay). One opening while a
   * scan runs is looked at when it ends.
   */
  function scanDue(url) {
    if (watching) {
      if (url) missed.add(url);
      return;
    }
    if (now() - watchedAt >= WATCH_SCAN_S || (url && Number.isFinite(watchedAt) && !reached.has(url))) background(scanWatch());
  }

  /**
   * A 34601 from a relay, routed by (stream_name, author) and verified once: a subscription's goes the existing way
   * (start.py:1112-1137, 621-667); a watched stream's (a prediction stream or its source) is kept for the track record,
   * never forecast or published; one that is both, both (docs/design/track-record.md#following).
   */
  async function intake(e, at = now()) {
    if (e?.kind === KIND.SUBSCRIPTION || e?.kind === KIND.PAYMENT) { // to us, as a seller
      if (verifyEvent(e)) background(marketLine(() => market.onEvent(e)));
      return;
    }
    const o = parseObservation(e) ?? (await market.received(e)); // a bought stream's delivery: verified, decrypted and paid
    if (!o) return;
    const uuid = relayUuid(o.provider, o.stream_name);
    const watched = watch.has(uuid);
    const sub = await db.relayStream(uuid);
    if ((!sub?.active && !watched) || !verifyEvent(e)) return;
    if (watched) await watch.intake(uuid, o, e, at);
    if (sub?.active) await predict(e, o, uuid, sub, at);
  }

  /**
   * A subscription's verified 34601 that arrived `at`: stored once; a new one is forecast and published as
   * `<stream>_pred` (start.py:1276-1327, 3549-3617). One stamped more than max(its cadence, AHEAD_S) ahead of its
   * arrival is neither kept nor forecast (it would move the engine's window and the prune's past the whole history).
   */
  async function predict(e, o, uuid, sub, at = now()) {
    const ts = safeEpoch(o.timestamp);
    const cadence = sub.cadence_seconds > 0 ? sub.cadence_seconds : DEFAULT_CADENCE_S;
    const windowS = cadence * RELAY_WINDOW;
    if (ts !== null && ts > at + Math.max(cadence, AHEAD_S)) return; // far ahead of its arrival: never kept
    if (ts !== null && sub.obs_ts != null && ts < sub.obs_ts - windowS) return; // older than the window: a replay, never kept
    const n = numericValue(o.value);
    const value = ts !== null && Number.isFinite(n) ? n : null;
    const fresh = await db.addRelayObservation({ stream_uuid: uuid, seq: o.seq, ts, value,
      raw: JSON.stringify(o.value) ?? 'null', event_id: e.id, received_at: t() });
    if (!fresh) return;
    // one cadence ahead (docs/intent/engine.md): steps of the cadence, one of them; from the engine's window
    const f = value === null ? null : forecast(await db.relayHistory(uuid, windowS), { step: cadence, horizon: cadence });
    const pub = predValue(f, o.value);
    const seq = await db.nextPredSeq(uuid);
    const made = t();
    const stream = sub.stream_name + PRED;
    const priced = market.priced(stream); // sold: a heartbeat in public, the value encrypted to each buyer in good standing
    const ev = sign(priced ? heartbeatEvent({ stream, seq, timestamp: made, now: made })
      : observationEvent({ stream, value: pub, seq, timestamp: made }));
    // with its backtest (the forecast's, kept for the Models tab: scoring is part of training)
    await db.addRelayPrediction({ stream_uuid: uuid, seq, value: pub, model: f?.model ?? 'echo', obs_seq: o.seq,
      made_at: made, event_id: ev.id, relays: 0, score: f?.score ?? null, persist: f?.persist ?? null, tests: f?.tests ?? null });
    await db.checkpoint(); // the seq, the observation and the prediction are kept before anything is sent, as Lite commits first
    onChange();
    background(publish(ev).then(async (n) => {
      if (!n) return;
      onPublished(n); // Home's activity log
      await db.setPredictionRelays(uuid, seq, n);
      onChange();
    }));
    if (priced) background(market.deliver(stream, { seq, timestamp: made, value: pub }));
  }

  /** Every open relay's 34600s, paged back with `until` as discover_datastreams (client.py:809-882). */
  async function pages(relay) {
    const seen = new Set();
    const out = [];
    let until;
    let stepped = false;
    for (let i = 0; i < MAX_PAGES; i++) {
      const f = { kinds: [KIND.ANNOUNCE], limit: PAGE };
      if (until !== undefined) f.until = until;
      const fresh = (await relay.fetch([f])).filter((e) => e?.id && !seen.has(e.id));
      if (!fresh.length) {
        if (until === undefined || stepped) break;
        until -= 1;
        stepped = true;
        continue;
      }
      stepped = false;
      for (const e of fresh) {
        seen.add(e.id);
        out.push(e);
      }
      until = Math.min(...fresh.map((e) => e.created_at));
    }
    return out;
  }

  /**
   * The relays' catalog, for discover() and the scan for prediction streams: one run at a time, shared by whoever asks
   * while it runs (each one's step(step, done, total) told as it goes). → { list: catalog() entries with their events,
   * gone: the streams tombstoned (`pubkey:d`), from: event id → the relays that sent it, reached: the relays whose
   * catalog came back }
   */
  let scanning = null;
  const scanSteps = new Set();
  function scan(step) {
    scanSteps.add(step);
    scanning ??= (async () => {
      const tell = (...a) => { for (const f of scanSteps) f(...a); };
      const from = new Map(); // event id → the relays that sent it
      const asked = await readable();
      const got = []; // the relays whose catalog came back whole
      let answered = 0;
      tell('ask', 0, asked.length);
      const events = (await Promise.all(asked.map(async (e) => {
        const list = await pages(e.relay).then((x) => (got.push(e.url), x), () => []);
        for (const ev of list) from.set(ev.id, [...(from.get(ev.id) ?? []), e.url]);
        tell('ask', ++answered, asked.length);
        return list;
      }))).flat();
      const signed = await genuine(events, (done, total) => tell('verify', done, total));
      return { list: catalog(signed), gone: tombstoned(signed), from, reached: got };
    })().finally(() => {
      scanning = null;
      scanSteps.clear();
    });
    return scanning;
  }

  /**
   * The events whose id and signature check (verifyEvent), each id once, in slices with a yield between them (a
   * catalog of ~1,000 is seconds of schnorr): a relay can forge any provider's announcement, and agents read what
   * discover() returns (the security review, 2026-10-19). step(done, total) as it goes.
   */
  async function genuine(events, step) {
    const unique = [...new Map(events.filter((e) => typeof e?.id === 'string').map((e) => [`${e.id}:${e.sig}`, e])).values()];
    const out = [];
    step(0, unique.length);
    for (let i = 0; i < unique.length; i++) {
      if (verifyEvent(unique[i], checked)) out.push(unique[i]);
      if ((i + 1) % VERIFY_SLICE === 0 || i + 1 === unique.length) {
        step(i + 1, unique.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return out;
  }

  /** The open relays; right after a load, waits up to 10 s for the ones still connecting. */
  async function readable() {
    const connecting = () => [...relays.values()].some((e) => e.relay?.state === 'connecting');
    for (const end = Date.now() + openWaitMs; (connecting() || !open().length) && Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!open().length) throw new Error('No relay is connected. Check the relays under Settings.');
    return open();
  }

  const view = (r) => ({
    uuid: r.uuid, stream: r.stream_name, provider: r.provider_pubkey, name: r.name, cadence_seconds: r.cadence_seconds,
    subscribed_at: r.subscribed_at, observations: r.observations,
    observation: r.obs_seq == null ? null
      : { seq: r.obs_seq, ts: r.obs_ts, value: r.obs_value, raw: parseRaw(r.obs_raw), received_at: r.obs_received_at },
    prediction: r.p_seq == null ? null
      : { stream: r.stream_name + PRED, seq: r.p_seq, value: r.p_value, model: r.p_model, made_at: r.p_made_at, relays: r.p_relays,
        score: r.p_score ?? null, persist: r.p_persist ?? null, tests: r.p_tests ?? null }, // tests null: no backtest kept yet
  });
  const viewOf = async (uuid) => view((await db.relayStreams()).find((r) => r.uuid === uuid));

  function checkStream(pubkey, stream) {
    const p = String(pubkey ?? '').trim().toLowerCase();
    if (!HEX64.test(p)) throw new Error('The provider is a Nostr pubkey: 64 hex characters.');
    const s = String(stream ?? '');
    if (!s) throw new Error('Name the stream.');
    return [p, s];
  }

  /** One of our `_pred` streams (an active subscription's), by its name. */
  async function ownPred(stream) {
    const sub = (await db.relayStreams({ active: true })).find((r) => r.stream_name + PRED === String(stream ?? ''));
    if (!sub) throw new Error(`${stream} is not a stream this neuron publishes (one of its <stream>${PRED}).`);
    return sub;
  }

  return {
    /** Central's max_streams once (start.py:236-246), the relay settings, then a reconcile and the hourly timer. */
    async start() {
      await watch.load(); // the watched streams are followed from the first REQ
      await market.load(); // and the streams we buy
      const cfg = await Promise.resolve().then(() => central().relayConfig()).catch(() => null);
      maxStreams = Number(cfg?.max_streams) > 0 ? Number(cfg.max_streams) : MAX_STREAMS;
      centralUrls = (await db.get('nostr_central_relays')) ?? []; // used when central is down now
      userRelays = (await db.get('nostr_relays')) ?? defaults.relays;
      centralWrite = (await db.get('nostr_central_write')) ?? defaults.centralWrite;
      await reconcile();
      // hourly, unless the catch-up pass ran it within the hour (a minute's slack for the timer)
      if (timer === null) {
        timer = si(() => void (now() - lastReconcile >= RECONCILE_S - 60 ? reconcile() : Promise.resolve())
          .catch((err) => console.error('[satori] reconcile', err)), RECONCILE_S * 1000);
      }
    },
    stop() {
      ci(timer);
      timer = null;
      for (const e of relays.values()) e.relay?.close();
      relays = new Map();
    },
    reconcile,
    /**
     * The catch-up pass (the device slept, so timers fired late or not at all): each relay whose reconnect is due
     * connects now, and the hourly pass runs once an hour has gone by since the last. → a promise when it did
     * something, else null (also before start()).
     */
    catchUp() {
      if (timer === null) return null;
      let connected = false;
      for (const e of relays.values()) {
        if (e.relay?.state === 'closed' && e.relay.retryAt != null && Date.now() >= e.relay.retryAt) {
          e.relay.connect();
          connected = true;
        }
      }
      if (!reconciling && now() - lastReconcile >= RECONCILE_S) return reconcile();
      return connected ? Promise.resolve() : null;
    },
    idle,

    async status() {
      return {
        pubkey: key.pubkey, npub: npub(key.pubkey), maxStreams, centralWrite, userRelays: [...userRelays],
        relays: [...relays.values()].map((e) => ({
          url: e.url, from: [...e.from], write: writes(e), state: e.blocked ? 'blocked' : e.relay.state,
          error: e.blocked ? e.why : e.relay.error,
          downSince: e.blocked ? null : e.relay.downSince ?? null, // ms: Home's reconnect grace (docs/design/health.md)
          for: e.for, // the ws:// relay this wss stand-in is reached for, or null
          refused: e.blocked ? [] : e.relay.refused ?? [], // the subscriptions it closed ([{ id, message }]: a follow chunk it would not take)
          notice: e.blocked ? null : e.relay.notice ?? null, // its last NOTICE
        })),
        subscriptions: (await db.relayStreams({ active: true })).map(view),
        // the track record: the watched prediction streams and sources, the last scan's finds (left: past the cap), when it worked
        watching: { ...watch.count(), found: watchInfo.found, left: watchInfo.left, at: Number.isFinite(watchedAt) ? Math.floor(watchedAt) : null,
          error: watchInfo.error },
        market: market.status(), // what we sell and buy (docs/design/market.md)
      };
    },

    /**
     * The relays' catalog: only announcements whose signature checks, newest per (provider, stream), no tombstones;
     * `pred` and `subscribed` marked, and `relays`: the ones that sent it.
     */
    discover: () => progress.run('discover', async (step) => {
      const scanned = await scan(step);
      const { list, from } = scanned;
      background(applyWatch(scanned)); // the watched set, from the same catalog
      const active = new Set((await db.relayStreams({ active: true })).map((r) => r.uuid));
      return list.map(({ event, ...s }) => ({ ...s, relays: from.get(event.id),
        subscribed: active.has(relayUuid(s.pubkey, s.stream_name)) }));
    }),

    /** The track record: every watched prediction stream's record, best first (docs/design/track-record.md#api-windowsatori-llmstxt). */
    records: () => watch.list(),
    /** One watched prediction stream's record with its last 28 scored pairs, or null. */
    record: (pubkey, stream) => watch.one(pubkey, stream),
    /** The scan for prediction streams, now (also at the first relay open and hourly at most every 6 h). */
    scanWatch,

    /**
     * Subscribe and predict: the announcement is looked up and verified, the
     * 34602 and the `_pred` 34600 published, and the stream followed.
     */
    subscribe: (pubkey, stream) => progress.run('subscribe', async (step) => {
      const [p, s] = checkStream(pubkey, stream);
      if (s.endsWith(PRED)) throw new Error('That is a prediction stream (…_pred); subscribe to its source.');
      const uuid = relayUuid(p, s);
      if ((await db.relayStream(uuid))?.active) return viewOf(uuid);
      if ((await db.countActiveRelay()) >= maxStreams) {
        throw new Error(`The limit of ${maxStreams} streams is reached (central's max_streams). Unsubscribe from one first.`);
      }
      const clash = (await db.relayStreams({ active: true })).find((r) => r.stream_name === s);
      if (clash) {
        throw new Error(`You already predict ${s} from ${clash.provider_pubkey.slice(0, 8)}…: there is one ${s}${PRED} per name `
          + '(Lite keeps its publications unique by name). Unsubscribe from that one first.');
      }
      const filter = [{ kinds: [KIND.ANNOUNCE], authors: [p], '#d': [s] }];
      step('find');
      const events = (await Promise.all((await readable()).map((e) => e.relay.fetch(filter).catch(() => [])))).flat();
      // Only what the asked provider signed, with the asked name: a relay may send anything.
      const mine = events.filter((e) => e?.kind === KIND.ANNOUNCE && e.pubkey === p
        && Array.isArray(e.tags) && e.tags.some((x) => Array.isArray(x) && x[0] === 'd' && x[1] === s) && verifyEvent(e));
      const [found] = catalog(mine);
      if (!found) throw new Error(`${s} is not announced by ${p.slice(0, 8)}… on the connected relays.`);
      if (found.price_per_obs > 0 || found.encrypted || found.approval_required) {
        throw new Error('Paid, encrypted and approval-gated streams come later; this one is not free and open.');
      }
      const at = t();
      const sub = await db.subscribeRelay({ uuid, stream_name: s, provider_pubkey: p, name: found.name,
        cadence_seconds: found.cadence_seconds, now: at });
      await refollow();
      await db.checkpoint();
      background(publish(sign(subscriptionEvent({ stream: s, provider: p, subscriber: key.pubkey, now: at }))));
      background(publish(announcementOf(sub, at)));
      onChange();
      return viewOf(uuid);
    }),

    /** Sell one of our `_pred` streams at `price` SATORI per observation (as typed), announced at once with its listing. → status() */
    async sell(stream, price) {
      const sub = await ownPred(stream);
      await market.sell(sub.stream_name + PRED, amountOf(price));
      background(publish(announcementOf(sub, t())));
      return this.status();
    },
    /** Free again: announced without a price, published in the clear. → status() */
    async unsell(stream) {
      const sub = await ownPred(stream);
      await market.unsell(sub.stream_name + PRED);
      background(publish(announcementOf(sub, t())));
      return this.status();
    },
    /**
     * Buy a stream sold on the Satori contract: its announcement looked up and verified, the vault (unlocked) opens a
     * channel with `deposit` SATORI (100 observations by default), the 34602 names it; followed, and watched. → its view
     */
    async buy(pubkey, stream, deposit) {
      const [p, s] = checkStream(pubkey, stream);
      if (p === key.pubkey) throw new Error('That is your own stream.');
      const wei = deposit == null || deposit === '' ? undefined : amountOf(deposit, 'The deposit');
      const filter = [{ kinds: [KIND.ANNOUNCE], authors: [p], '#d': [s] }];
      const events = (await Promise.all((await readable()).map((e) => e.relay.fetch(filter).catch(() => [])))).flat();
      const [found] = catalog(events.filter((e) => e?.kind === KIND.ANNOUNCE && e.pubkey === p && verifyEvent(e)
        && e.tags.some((x) => Array.isArray(x) && x[0] === 'd' && x[1] === s)));
      if (!found) throw new Error(`${s} is not announced by ${p.slice(0, 8)}… on the connected relays.`);
      if (!listingOf(found)) throw new Error(`${s} is not for sale on the Satori contract.`);
      const v = await market.buy(found, wei);
      await refollow();
      if (!watch.has(relayUuid(p, s))) background(scanWatch()); // watched as ours are, so what it delivers lands
      onChange();
      return v;
    },
    /** Stop buying (window.satori.stop): the identity asks to close the channel, the unsubscribe is sent; the refund after the 7-day grace period. → its view */
    async stopBuying(pubkey, stream) {
      const [p, s] = checkStream(pubkey, stream);
      const v = await market.stop(p, s);
      await refollow();
      onChange();
      return v;
    },

    /** Unsubscribe (routes.py:2673-2688): the 34602 unsubscribe, the `_pred` tombstone, unfollow. → status() */
    async unsubscribe(pubkey, stream) {
      const [p, s] = checkStream(pubkey, stream);
      const uuid = relayUuid(p, s);
      if (!(await db.relayStream(uuid))?.active) throw new Error(`Not subscribed to ${s} from ${p.slice(0, 8)}….`);
      const at = t();
      await db.unsubscribeRelay(uuid);
      await watch.drop([[key.pubkey, s + PRED]]); // our `_pred` leaves the track record with its tombstone
      await refollow();
      await db.checkpoint();
      await sendKept([sign(subscriptionEvent({ stream: s, provider: p, subscriber: key.pubkey, now: at, unsubscribe: true })),
        sign(tombstoneEvent(s + PRED, key.pubkey, at))]);
      onChange();
      return this.status();
    },

    /** Settings: the user's relays (ws:// or wss://) and whether central's relays are written to. */
    async setRelays({ relays: list, centralWrite: cw } = {}) {
      if (list !== undefined) {
        const urls = [...new Set(list.map((u) => String(u).trim()).filter(Boolean))];
        const bad = urls.find((u) => !isRelayUrl(u));
        if (bad) throw new Error(`A relay is a ws:// or wss:// address: ${bad}`);
        userRelays = urls;
        await db.set('nostr_relays', urls);
      }
      if (cw !== undefined) {
        centralWrite = !!cw;
        await db.set('nostr_central_write', centralWrite);
      }
      await db.checkpoint();
      await connectNew(applyRelays());
      background(announce()); // a relay we now write to gets our announcements
      onChange();
      return this.status();
    },
  };
}
