// The Nostr flow, as Satori Lite runs it (docs/design/nostr.md):
//   relays = central's /peer/relays + the user's; each relay: REQ follow, announce `<stream>_pred`
//   34601 in ─▶ subscribed? ─▶ verify ─▶ store once ─▶ forecast (step = cadence) ─▶ publish `<stream>_pred`
//   hourly: refetch the relay list, reconnect, re-announce; NIP-65 daily
// Relay streams are apart from central's: own tables, and nothing goes to central.
import { signEvent, verifyEvent, npub } from '../nostr/event.js';
import { createRelay } from '../nostr/relay.js';
import {
  KIND, PRED, observationEvent, announceEvent, tombstoneEvent, subscriptionEvent, relayListEvent, predMetadata,
  catalog, parseObservation, numericValue, predValue, relayUuid,
} from '../nostr/satori.js';
import { forecast as engineForecast, STEP_S } from '../engine/index.js';

export const MAX_STREAMS = 100; // network_db.py:14-36, until central says (relay-config)
export const RECONCILE_S = 3600; // start.py:292
export const RELAY_LIST_S = 86_400; // start.py:291
export const FOLLOW_ID = 'satori-follow'; // client.py:76
const PAGE = 500; // strfry's maxFilterLimit (client.py:72-75)
const MAX_FILTERS = 200; // strfry's maxReqFilterSize
const MAX_PAGES = 100;
const EPOCH = [946_684_800, 4_102_444_800]; // 2000–2100 (start.py:1413-1424)

const HEX64 = /^[0-9a-f]{64}$/;
const isRelayUrl = (u) => {
  try { return ['ws:', 'wss:'].includes(new URL(u).protocol); } catch { return false; }
};
const isLocal = (u) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname);
const safeEpoch = (t) => (Number.isFinite(t) && t > EPOCH[0] && t < EPOCH[1] ? Math.floor(t) : null);
const parseRaw = (raw) => {
  try { return JSON.parse(raw); } catch { return raw; }
};

/**
 * @param {object} o
 * @param {object} o.db the app's db
 * @param {{secret: string, pubkey: string}} o.key the Nostr key
 * @param {string} o.walletPubkey the identity's compressed pubkey (the announcement's wallet_pubkey)
 * @param {() => object} o.central the current central client (relays(), relayConfig())
 * @param {{relays: string[], centralWrite: boolean}} o.defaults Settings before the user changes them
 */
export function createNostr({ db, key, walletPubkey, central, defaults, makeRelay = createRelay,
  forecast = engineForecast, now = () => Date.now() / 1000, https = globalThis.location?.protocol === 'https:',
  onChange = () => {}, setInterval: si = setInterval, clearInterval: ci = clearInterval, openWaitMs = 10_000 }) {
  let maxStreams = MAX_STREAMS;
  let userRelays = defaults.relays;
  let centralWrite = defaults.centralWrite;
  let centralUrls = [];
  let relays = new Map(); // url → { url, from: Set, relay, blocked, chunks }
  let timer = null;
  let tail = Promise.resolve();

  /** Background work (intake, a relay's open, announcements) runs one at a time, in order. */
  const work = (fn) => (tail = tail.then(fn).catch((err) => console.error('[satori] nostr', err)));
  const sign = (template) => signEvent(template, key.secret);
  const t = () => Math.floor(now());
  const writes = (e) => e.from.has('user') || (e.from.has('central') && centralWrite);
  const open = () => [...relays.values()].filter((e) => e.relay?.state === 'open');

  /** Publish to every open relay we write to → how many said OK. */
  async function publish(event, targets = open().filter(writes)) {
    const results = await Promise.all(targets.map((e) => e.relay.publish(event)));
    return results.filter((r) => r.ok).length;
  }

  async function filters() {
    const by = new Map();
    for (const s of await db.relayStreams({ active: true })) {
      by.set(s.provider_pubkey, [...(by.get(s.provider_pubkey) ?? []), s.stream_name]);
    }
    return [...by.keys()].sort().map((p) => ({ kinds: [KIND.OBSERVATION], authors: [p], '#d': by.get(p).sort() }));
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

  const announcements = async (at) => (await db.relayStreams({ active: true }))
    .map((sub) => sign(announceEvent(predMetadata({ sub, pubkey: key.pubkey, walletPubkey }), at)));

  /** NIP-65 of the open relays, when the last one is a day old (start.py:370-389). */
  async function relayList() {
    const at = t();
    if (at - ((await db.get('nostr_relay_list_at')) ?? 0) < RELAY_LIST_S) return;
    if (!open().some(writes)) return;
    if (!(await publish(sign(relayListEvent(open().map((e) => e.url), at))))) return;
    await db.set('nostr_relay_list_at', at);
    await db.checkpoint(); // OPFS keeps what is checkpointed: a reload must not send it again
  }

  /** A relay (re)connected: announce our `_pred` streams there (start.py:326-328). */
  async function opened(url, relay) {
    const e = relays.get(url);
    if (e?.relay !== relay) return;
    if (writes(e)) for (const ev of await announcements(t())) await publish(ev, [e]);
    await relayList();
    onChange();
  }

  function applyRelays() {
    const want = new Map();
    for (const [from, list] of [['central', centralUrls], ['user', userRelays]]) {
      for (const url of list) want.set(url, new Set([...(want.get(url) ?? []), from]));
    }
    for (const [url, e] of relays) if (!want.has(url)) e.relay?.close();
    const next = new Map();
    for (const [url, from] of want) {
      let e = relays.get(url);
      if (!e) {
        e = { url, blocked: https && url.startsWith('ws://') && !isLocal(url), relay: null, chunks: 0 };
        if (!e.blocked) {
          e.relay = makeRelay(url, {
            onOpen: (r) => work(() => opened(url, r)),
            onEvent: (_id, ev) => work(() => intake(ev)),
            onState: () => onChange(),
          });
        }
      }
      e.from = from;
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
      e.relay.connect();
    }
  }

  /**
   * The hourly pass (start.py:200-292): central's relay list again (kept when
   * central fails), connect new and dropped relays, re-announce, NIP-65.
   */
  async function reconcile() {
    try {
      const list = await central().relays();
      centralUrls = [...new Set((Array.isArray(list) ? list : []).map((r) => String(r?.relay_url ?? '').trim()).filter(isRelayUrl))];
    } catch (err) {
      console.warn('[satori] relay list from central', err?.message ?? err);
    }
    const added = applyRelays();
    for (const e of relays.values()) if (e.relay?.state === 'closed' && !added.includes(e)) e.relay.connect();
    await connectNew(added);
    await work(async () => {
      for (const ev of await announcements(t())) await publish(ev);
      await relayList();
    });
    onChange();
  }

  /**
   * A 34601 from a relay (start.py:1112-1137, 621-667): subscribed by
   * (stream_name, author), verified, stored once; a new one is forecast and
   * published as `<stream>_pred` (start.py:1276-1327, 3549-3617).
   */
  async function intake(e) {
    const o = parseObservation(e);
    if (!o) return;
    const uuid = relayUuid(o.provider, o.stream_name);
    const sub = await db.relayStream(uuid);
    if (!sub?.active || !verifyEvent(e)) return;
    const ts = safeEpoch(o.timestamp);
    const n = numericValue(o.value);
    const value = ts !== null && Number.isFinite(n) ? n : null;
    const fresh = await db.addRelayObservation({ stream_uuid: uuid, seq: o.seq, ts, value,
      raw: JSON.stringify(o.value) ?? 'null', event_id: e.id, received_at: t() });
    if (!fresh) return;
    const f = value === null ? null
      : forecast(await db.relayHistory(uuid), { step: sub.cadence_seconds > 0 ? sub.cadence_seconds : STEP_S });
    const pub = predValue(f, o.value);
    const seq = await db.nextPredSeq(uuid);
    const at = t();
    const ev = sign(observationEvent({ stream: sub.stream_name + PRED, value: pub, seq, timestamp: at }));
    const took = await publish(ev);
    await db.addRelayPrediction({ stream_uuid: uuid, seq, value: pub, model: f?.model ?? 'echo', obs_seq: o.seq,
      made_at: at, event_id: ev.id, relays: took });
    await db.checkpoint();
    onChange();
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

  /** The open relays; right after a load, waits up to 10 s for the first one. */
  async function readable() {
    for (const end = Date.now() + openWaitMs; !open().length && Date.now() < end;) {
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
      : { stream: r.stream_name + PRED, seq: r.p_seq, value: r.p_value, model: r.p_model, made_at: r.p_made_at, relays: r.p_relays },
  });
  const viewOf = async (uuid) => view((await db.relayStreams()).find((r) => r.uuid === uuid));

  function checkStream(pubkey, stream) {
    const p = String(pubkey ?? '').trim().toLowerCase();
    if (!HEX64.test(p)) throw new Error('The provider is a Nostr pubkey: 64 hex characters.');
    const s = String(stream ?? '');
    if (!s) throw new Error('Name the stream.');
    return [p, s];
  }

  return {
    /** Central's max_streams once (start.py:236-246), the relay settings, then a reconcile and the hourly timer. */
    async start() {
      const cfg = await Promise.resolve().then(() => central().relayConfig()).catch(() => null);
      maxStreams = Number(cfg?.max_streams) > 0 ? Number(cfg.max_streams) : MAX_STREAMS;
      userRelays = (await db.get('nostr_relays')) ?? defaults.relays;
      centralWrite = (await db.get('nostr_central_write')) ?? defaults.centralWrite;
      await reconcile();
      if (timer === null) timer = si(() => void reconcile().catch((err) => console.error('[satori] reconcile', err)), RECONCILE_S * 1000);
    },
    stop() {
      ci(timer);
      timer = null;
      for (const e of relays.values()) e.relay?.close();
      relays = new Map();
    },
    reconcile,
    /** Resolves when the background work queued so far is done. */
    idle: () => tail,

    async status() {
      return {
        pubkey: key.pubkey, npub: npub(key.pubkey), maxStreams, centralWrite, userRelays: [...userRelays],
        relays: [...relays.values()].map((e) => ({
          url: e.url, from: [...e.from], write: writes(e), state: e.blocked ? 'blocked' : e.relay.state,
          error: e.blocked ? 'ws:// cannot be opened from an https page' : e.relay.error,
        })),
        subscriptions: (await db.relayStreams({ active: true })).map(view),
      };
    },

    /** The relays' catalog: newest per (provider, stream), no tombstones; `pred` and `subscribed` marked. */
    async discover() {
      const events = (await Promise.all((await readable()).map((e) => pages(e.relay).catch(() => [])))).flat();
      const active = new Set((await db.relayStreams({ active: true })).map((r) => r.uuid));
      return catalog(events).map(({ event, ...s }) => ({ ...s, subscribed: active.has(relayUuid(s.pubkey, s.stream_name)) }));
    },

    /**
     * Subscribe and predict: the announcement is looked up and verified, the
     * 34602 and the `_pred` 34600 published, and the stream followed.
     */
    async subscribe(pubkey, stream) {
      const [p, s] = checkStream(pubkey, stream);
      if (s.endsWith(PRED)) throw new Error('That is a prediction stream (…_pred); subscribe to its source.');
      const uuid = relayUuid(p, s);
      if ((await db.relayStream(uuid))?.active) return viewOf(uuid);
      if ((await db.countActiveRelay()) >= maxStreams) {
        throw new Error(`The limit of ${maxStreams} streams is reached (central's max_streams). Unsubscribe from one first.`);
      }
      const filter = [{ kinds: [KIND.ANNOUNCE], authors: [p], '#d': [s] }];
      const events = (await Promise.all((await readable()).map((e) => e.relay.fetch(filter).catch(() => [])))).flat();
      const [found] = catalog(events);
      if (!found) throw new Error(`${s} is not announced by ${p.slice(0, 8)}… on the connected relays.`);
      if (!verifyEvent(found.event)) throw new Error('The announcement has a bad signature.');
      if (found.price_per_obs > 0 || found.encrypted || found.approval_required) {
        throw new Error('Paid, encrypted and approval-gated streams come later; this one is not free and open.');
      }
      const at = t();
      const sub = await db.subscribeRelay({ uuid, stream_name: s, provider_pubkey: p, name: found.name,
        cadence_seconds: found.cadence_seconds, meta: found.event.content, now: at });
      await publish(sign(subscriptionEvent({ stream: s, provider: p, subscriber: key.pubkey, now: at })));
      await publish(sign(announceEvent(predMetadata({ sub, pubkey: key.pubkey, walletPubkey }), at)));
      await refollow();
      await db.checkpoint();
      onChange();
      return viewOf(uuid);
    },

    /** Unsubscribe (routes.py:2673-2688): the 34602 unsubscribe, the `_pred` tombstone, unfollow. */
    async unsubscribe(pubkey, stream) {
      const [p, s] = checkStream(pubkey, stream);
      const uuid = relayUuid(p, s);
      if (!(await db.relayStream(uuid))?.active) throw new Error(`Not subscribed to ${s} from ${p.slice(0, 8)}….`);
      const at = t();
      await db.unsubscribeRelay(uuid, at);
      await publish(sign(subscriptionEvent({ stream: s, provider: p, subscriber: key.pubkey, now: at, unsubscribe: true })));
      await publish(sign(tombstoneEvent(s + PRED, key.pubkey, at)));
      await refollow();
      await db.checkpoint();
      onChange();
      return true;
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
      await work(async () => { // a relay we now write to gets our announcements
        for (const ev of await announcements(t())) await publish(ev);
      });
      onChange();
      return this.status();
    },
  };
}
