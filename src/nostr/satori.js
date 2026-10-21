// Satori's Nostr protocol as satorilib's client and Satori Lite speak it
// (docs/design/nostr.md): event templates (sign with event.js), the catalog,
// observation parsing, Lite's value unwrapping and the relay model uuid.
import { sha1 } from '@noble/hashes/legacy';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

export const KIND = { ANNOUNCE: 34600, OBSERVATION: 34601, SUBSCRIPTION: 34602, PAYMENT: 34603, RELAY_LIST: 10002 }; // models.py:512-515
export const PRED = '_pred';

const tag = (e, name) => e.tags.find((t) => t[0] === name)?.[1];
/** Tags as NIP-01 has them: an array of arrays of strings (a relay may serve anything). */
const wellTagged = (e) => Array.isArray(e?.tags) && e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'));
const isDeleted = (e) => e.tags.some((t) => t[0] === 'status' && t[1] === 'deleted');

/** A free observation (34601) as publish_observation sends it (client.py:579-610). */
export function observationEvent({ stream, value, seq, timestamp, now = timestamp }) {
  return {
    created_at: now, kind: KIND.OBSERVATION,
    tags: [['d', stream], ['stream', stream], ['seq', String(seq)], ['satori', 'observation']],
    content: JSON.stringify({ stream_name: stream, timestamp, value, seq_num: seq }),
  };
}

/** DatastreamMetadata's fields, every one: satorilib reads them with cls(**data), so none more or fewer (models.py:14-47). */
const metadataJson = (m) => JSON.stringify({
  stream_name: m.stream_name, nostr_pubkey: m.nostr_pubkey, name: m.name ?? '', description: m.description ?? '',
  encrypted: !!m.encrypted, price_per_obs: m.price_per_obs ?? 0, created_at: m.created_at ?? 0,
  cadence_seconds: m.cadence_seconds ?? null, tags: m.tags ?? [], approval_required: !!m.approval_required,
  metadata: m.metadata ?? null,
});

/** A stream announcement (34600) as announce_datastream sends it (client.py:294-356). */
export function announceEvent(m, now) {
  const tags = [['d', m.stream_name], ['satori', 'datastream'], ...(m.tags ?? []).map((t) => ['t', t]),
    ['stream', `satori:stream:${m.stream_name}`]];
  if (m.metadata?.source_stream_name) tags.push(['source_stream', m.metadata.source_stream_name]);
  if (m.metadata?.source_provider_pubkey) tags.push(['source_pubkey', m.metadata.source_provider_pubkey]);
  if (m.approval_required) tags.push(['approval_required', 'true']);
  return { created_at: now, kind: KIND.ANNOUNCE, tags, content: metadataJson(m) };
}

/** The tombstone that replaces an announcement (start.py:3683-3720 with deleted=True). */
export const tombstoneEvent = (stream, pubkey, now) => ({
  created_at: now, kind: KIND.ANNOUNCE, tags: [['d', stream], ['satori', 'datastream'], ['status', 'deleted']],
  content: metadataJson({ stream_name: stream, nostr_pubkey: pubkey }),
});

/**
 * The metadata of `<stream>_pred` as _networkAnnouncePublications builds it
 * (start.py:3442-3482; the publication from routes.py:2700-2711). Priced (`listing`: { price_per_obs, market: { chain,
 * contract, token, payee } }, docs/design/market.md#selling-and-buying-over-the-relays): encrypted, Lite's price_per_obs
 * (satoshis) the one price, and the channel's details in metadata.market.
 * @param {{sub: object, pubkey: string, walletPubkey: string, listing?: object|null}} p sub: a relay_streams row
 */
export const predMetadata = ({ sub, pubkey, walletPubkey, listing = null }) => ({
  stream_name: sub.stream_name + PRED, nostr_pubkey: pubkey, name: `Predictions for ${sub.name || sub.stream_name}`,
  description: '', encrypted: !!listing, price_per_obs: listing?.price_per_obs ?? 0, created_at: sub.pred_created_at,
  cadence_seconds: sub.cadence_seconds ?? null, tags: [],
  metadata: { source_stream_name: sub.stream_name, source_provider_pubkey: sub.provider_pubkey, wallet_pubkey: walletPubkey,
    ...(listing && { market: listing.market }) },
});

/**
 * subscribe_datastream / unsubscribe_datastream (client.py:1102-1154, 1600-1644); a paid stream's subscription names
 * its channel in payment_channel ({ chain, contract, id, binding }).
 */
export function subscriptionEvent({ stream, provider, subscriber, now, unsubscribe = false, paymentChannel = null }) {
  const tags = [['d', stream], ['p', provider], ['stream', stream]];
  tags.push(...(unsubscribe ? [['action', 'unsubscribe'], ['satori', 'unsubscription']] : [['satori', 'subscription']]));
  return {
    created_at: now, kind: KIND.SUBSCRIPTION, tags,
    content: JSON.stringify({ subscriber_pubkey: subscriber, stream_name: stream, nostr_pubkey: provider, timestamp: now,
      payment_channel: unsubscribe ? null : paymentChannel }),
  };
}

/** A 34602 → { subscriber, stream_name, provider, channel (payment_channel, an object, or null), unsubscribe }, or null. */
export function parseSubscription(e) {
  if (e?.kind !== KIND.SUBSCRIPTION || !wellTagged(e)) return null;
  let c;
  try { c = JSON.parse(e.content); } catch { return null; }
  if (!c || typeof c !== 'object' || typeof c.subscriber_pubkey !== 'string' || typeof c.stream_name !== 'string' || !c.stream_name
    || typeof c.nostr_pubkey !== 'string') return null;
  const channel = c.payment_channel && typeof c.payment_channel === 'object' ? c.payment_channel : null;
  return { subscriber: c.subscriber_pubkey, stream_name: c.stream_name, provider: c.nostr_pubkey, channel,
    unsubscribe: e.tags.some((t) => t[0] === 'action' && t[1] === 'unsubscribe') };
}

/**
 * A paid observation for one subscriber (34601), as publish_observation sends it (client.py:621-660): `content` the
 * value encrypted to them (NIP-04), seq and timestamp in tags; d = `<stream>:<subscriber>`, one per subscriber (a relay
 * keeps one event per d: Lite's shared d would leave one subscriber's).
 */
export const deliveryEvent = ({ stream, subscriber, seq, timestamp, content, now }) => ({
  created_at: now, kind: KIND.OBSERVATION, content,
  tags: [['d', `${stream}:${subscriber}`], ['p', subscriber], ['stream', stream], ['seq', String(seq)], ['timestamp', String(timestamp)],
    ['satori', 'observation']],
});

/** A delivery's plain parts → { stream_name, provider, subscriber, seq, timestamp, id }, or null (Lite reads the stream tag, then d). */
export function deliveryOf(e) {
  if (e?.kind !== KIND.OBSERVATION || !wellTagged(e) || !e.content) return null;
  const subscriber = tag(e, 'p');
  const stream = tag(e, 'stream') ?? tag(e, 'd');
  const seq = Number(tag(e, 'seq'));
  const ts = Number(tag(e, 'timestamp'));
  if (!subscriber || !stream || !Number.isSafeInteger(seq)) return null;
  return { stream_name: stream, provider: e.pubkey, subscriber, seq, timestamp: Number.isFinite(ts) ? ts : null, id: e.id };
}

/** A paid stream's public heartbeat (34601, no value: client.py:665-680), on its own d at each observation. */
export const heartbeatEvent = ({ stream, seq, timestamp, now }) => ({
  created_at: now, kind: KIND.OBSERVATION, content: '',
  tags: [['d', stream], ['stream', stream], ['seq', String(seq)], ['timestamp', String(timestamp)], ['satori', 'heartbeat']],
});

/** A payment (34603) as send_payment sends it (client.py:1216-1283): `content` its JSON encrypted to the seller (NIP-04). */
export const paymentEvent = ({ stream, provider, seq, content, now }) => ({
  created_at: now, kind: KIND.PAYMENT, content, tags: [['d', stream], ['p', provider], ['stream', stream], ['seq', String(seq)]],
});

/**
 * PaymentNotification's JSON (models.py:173-205) on Base: amount_sats as Lite's (the price, satoshis), and `voucher` in
 * place of tx_id ({ channel, cumulative, signature }: the identity's cumulative EIP-712 voucher, src/chain/channels.js).
 */
export const paymentJson = ({ from, to, stream, seq, amountSats, timestamp, voucher }) => JSON.stringify({
  from_pubkey: from, to_pubkey: to, stream_name: stream, seq_num: seq, amount_sats: amountSats, timestamp, voucher,
});

/** NIP-65 (client.py:405-428). */
export const relayListEvent = (urls, now) => ({ created_at: now, kind: KIND.RELAY_LIST, tags: urls.map((u) => ['r', u]), content: '' });

/**
 * 34600 events → the catalog, as discover_datastreams (client.py:809-882):
 * newest per (author, d), tombstones dropped, newest first. Each entry is the
 * announcement's content with the author as `pubkey`, the event's time, and
 * `pred` for prediction streams. Signatures are checked before (discover: verifyEvent).
 */
/** The newest 34600 per `pubkey:d` (well formed). */
function newestAnnouncements(events) {
  const newest = new Map();
  for (const e of events) {
    if (e?.kind !== KIND.ANNOUNCE || !wellTagged(e) || typeof e.pubkey !== 'string' || !Number.isFinite(e.created_at)) continue;
    const key = `${e.pubkey}:${tag(e, 'd') ?? ''}`;
    if (!newest.has(key) || e.created_at > newest.get(key).created_at) newest.set(key, e);
  }
  return newest;
}

/** The streams whose newest announcement is a tombstone, as `pubkey:d` (the track record drops a watched one at once). */
export const tombstoned = (events) => new Set([...newestAnnouncements(events)].filter(([, e]) => tag(e, 'd') && isDeleted(e)).map(([k]) => k));

export function catalog(events) {
  const newest = newestAnnouncements(events);
  const out = [];
  for (const e of newest.values()) {
    const d = tag(e, 'd');
    if (!d || isDeleted(e)) continue;
    let m;
    try { m = JSON.parse(e.content); } catch { continue; }
    if (!m || typeof m !== 'object') continue;
    out.push({
      pubkey: e.pubkey, stream_name: d, name: String(m.name ?? ''), description: String(m.description ?? ''),
      cadence_seconds: Number.isFinite(m.cadence_seconds) ? m.cadence_seconds : null,
      price_per_obs: Number(m.price_per_obs) || 0, encrypted: !!m.encrypted, approval_required: !!m.approval_required,
      tags: Array.isArray(m.tags) ? m.tags.map(String) : [], metadata: m.metadata ?? null,
      created_at: e.created_at, pred: d.endsWith(PRED), event: e,
    });
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}

/**
 * A 34601 → { stream_name, provider, timestamp, value, seq, id }, or null: an
 * empty content is a heartbeat, and the content must be DatastreamObservation
 * JSON (client.py:1808-1865; models.py:105-140).
 */
export function parseObservation(e) {
  if (e?.kind !== KIND.OBSERVATION || !e.content) return null;
  let o;
  try { o = JSON.parse(e.content); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.stream_name !== 'string' || !o.stream_name
    || !Number.isSafeInteger(o.seq_num) || !('timestamp' in o) || !('value' in o)) return null;
  const ts = Number(o.timestamp);
  return { stream_name: o.stream_name, provider: e.pubkey, timestamp: Number.isFinite(ts) ? ts : null, value: o.value,
    seq: o.seq_num, id: e.id };
}

const DIGITS = '\\d(?:_?\\d)*';
const FLOAT = new RegExp(`^[+-]?(?:(?:${DIGITS})?\\.${DIGITS}|${DIGITS}\\.?)(?:[eE][+-]?${DIGITS})?$`);
const SPECIAL = /^([+-]?)(inf|infinity|nan)$/i;

/** Python's float() of a string, or null where Python raises. */
export function pyFloat(s) {
  const t = String(s).trim();
  if (FLOAT.test(t)) return Number(t.replaceAll('_', ''));
  const m = SPECIAL.exec(t);
  if (!m) return null;
  return m[2].toLowerCase() === 'nan' ? NaN : m[1] === '-' ? -Infinity : Infinity;
}

const pyFloatOf = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v)
  : typeof v === 'string' ? pyFloat(v) : null);

/**
 * Lite's _numericObservationValue (start.py:1365-1410): a scalar as a float; a
 * dict's `value`, else its `raw` unless `unit` is 'tick'; else null.
 */
export function numericValue(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.value !== null && v.value !== undefined) return pyFloatOf(v.value);
    if (v.unit === 'tick') return null;
    if (v.raw !== null && v.raw !== undefined) return pyFloatOf(v.raw);
    return null;
  }
  return pyFloatOf(v);
}

/**
 * The published value, as text (Lite publishes str; readers take float() of it): the forecast one
 * cadence ahead (`value`, the owner's rule, docs/intent/engine.md; Lite's predictForRelay sends t2,
 * two steps ahead, engine.py:733-735, 1176-1186); or Lite's echo (start.py:1302-1308).
 */
export const predValue = (f, value) => (f ? String(f.value) : typeof value === 'string' ? value : JSON.stringify(value));

const DNS = hexToBytes('6ba7b8109dad11d180b400c04fd430c8');

/** Lite's relay model uuid: uuid5(DNS, 'satori-relay:<lowercase pubkey>:<stream>:') (relay_ids.py). */
export function relayUuid(pubkey, stream) {
  const h = sha1(concatBytes(DNS, utf8ToBytes(`satori-relay:${String(pubkey).trim().toLowerCase()}:${stream}:`))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = bytesToHex(h);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
