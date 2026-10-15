// Satori's Nostr protocol as satorilib's client and Satori Lite speak it
// (docs/design/nostr.md): event templates (sign with event.js), the catalog,
// observation parsing, Lite's value unwrapping and the relay model uuid.
import { sha1 } from '@noble/hashes/legacy';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { pyJson } from './event.js';
import { pyFloatStr } from '../central/index.js';

export const KIND = { ANNOUNCE: 34600, OBSERVATION: 34601, SUBSCRIPTION: 34602, RELAY_LIST: 10002 }; // models.py:512-514
export const PRED = '_pred';

const tag = (e, name) => e.tags.find((t) => t[0] === name)?.[1];
const isDeleted = (e) => e.tags.some((t) => t[0] === 'status' && t[1] === 'deleted');

/** A free observation (34601) as publish_observation sends it (client.py:579-610). */
export function observationEvent({ stream, value, seq, timestamp, now = timestamp }) {
  return {
    created_at: now, kind: KIND.OBSERVATION,
    tags: [['d', stream], ['stream', stream], ['seq', String(seq)], ['satori', 'observation']],
    content: pyJson({ stream_name: stream, timestamp, value, seq_num: seq }),
  };
}

/** DatastreamMetadata.to_json(): every field, in the dataclass's order (models.py:14-40). */
const metadataJson = (m) => pyJson({
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
 * (start.py:3442-3482; the publication from routes.py:2700-2711).
 * @param {{sub: object, pubkey: string, walletPubkey: string}} p sub: a relay_streams row
 */
export const predMetadata = ({ sub, pubkey, walletPubkey }) => ({
  stream_name: sub.stream_name + PRED, nostr_pubkey: pubkey, name: `Predictions for ${sub.name || sub.stream_name}`,
  description: '', encrypted: false, price_per_obs: 0, created_at: sub.pred_created_at,
  cadence_seconds: sub.cadence_seconds ?? null, tags: [],
  metadata: { source_stream_name: sub.stream_name, source_provider_pubkey: sub.provider_pubkey, wallet_pubkey: walletPubkey },
});

/** subscribe_datastream / unsubscribe_datastream (client.py:1102-1154, 1600-1644). */
export function subscriptionEvent({ stream, provider, subscriber, now, unsubscribe = false }) {
  const tags = [['d', stream], ['p', provider], ['stream', stream]];
  tags.push(...(unsubscribe ? [['action', 'unsubscribe'], ['satori', 'unsubscription']] : [['satori', 'subscription']]));
  return {
    created_at: now, kind: KIND.SUBSCRIPTION, tags,
    content: pyJson({ subscriber_pubkey: subscriber, stream_name: stream, nostr_pubkey: provider, timestamp: now,
      payment_channel: null }),
  };
}

/** NIP-65 (client.py:405-428). */
export const relayListEvent = (urls, now) => ({ created_at: now, kind: KIND.RELAY_LIST, tags: urls.map((u) => ['r', u]), content: '' });

/**
 * 34600 events → the catalog, as discover_datastreams (client.py:809-882):
 * newest per (author, d), tombstones dropped, newest first. Each entry is the
 * announcement's content with the author as `pubkey`, the event's time, and
 * `pred` for prediction streams. Signatures are not checked here.
 */
export function catalog(events) {
  const newest = new Map();
  for (const e of events) {
    if (e?.kind !== KIND.ANNOUNCE || !Array.isArray(e.tags)) continue;
    const key = `${e.pubkey}:${tag(e, 'd') ?? ''}`;
    if (!newest.has(key) || e.created_at > newest.get(key).created_at) newest.set(key, e);
  }
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
 * The published value: str(t2) as Python prints it, Lite's predictForRelay
 * returning the first row of _runForecast's second, autoregressed forecast
 * (engine.py:733-735, 1176-1186); or Lite's echo (start.py:1302-1308).
 */
export const predValue = (f, value) => (f ? pyFloatStr(f.t2) : typeof value === 'string' ? value : pyJson(value));

const DNS = hexToBytes('6ba7b8109dad11d180b400c04fd430c8');

/** Lite's relay model uuid: uuid5(DNS, 'satori-relay:<lowercase pubkey>:<stream>:') (relay_ids.py). */
export function relayUuid(pubkey, stream) {
  const h = sha1(concatBytes(DNS, utf8ToBytes(`satori-relay:${String(pubkey).trim().toLowerCase()}:${stream}:`))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = bytesToHex(h);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
