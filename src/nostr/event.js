// NIP-01 events and the Nostr key (docs/design/nostr.md), over @noble/curves'
// BIP-340 schnorr, as nostr-sdk makes them for Satori Lite:
//   nostrPubkey(secretHex) / generateNostrSecret() / npub(pubkeyHex) / nsec(secretHex) / nostrSecretOf(nsecOrHex)
//   signEvent({ created_at, kind, tags, content }, secretHex) → event
//   verifyEvent(event, seen?) → id and signature check (seen: the signatures already checked, a Set; SeenSet bounds it)
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import { generateSecret } from '../keys/keys.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** The x-only public key (64 hex) of a secret (64 hex), as nostr-sdk's Keys. */
export function nostrPubkey(secretHex) {
  if (!HEX64.test(String(secretHex))) throw new Error('A Nostr secret is 64 lowercase hex characters.');
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex))); // throws outside 1..n-1
}

/** A random secret (64 hex), independent of the identity and the vault (start.py:136-138). */
export const generateNostrSecret = () => bytesToHex(generateSecret());

/** NIP-19 npub of a pubkey. */
export const npub = (pubkeyHex) => bech32.encode('npub', bech32.toWords(hexToBytes(pubkeyHex)));

/** A Nostr secret (hex) from its backup: an nsec or 64 hex characters. */
export function nostrSecretOf(text) {
  const t = String(text ?? '').trim().toLowerCase();
  try {
    const hex = t.startsWith('nsec1') ? bytesToHex(bech32.fromWords(bech32.decode(t).words)) : t;
    nostrPubkey(hex);
    return hex;
  } catch {
    throw new Error('Not a Nostr key: give its nsec or 64 hex characters.');
  }
}

/** NIP-19 nsec of a secret: the Nostr key's backup, as Nostr apps import it. */
export function nsec(secretHex) {
  nostrPubkey(secretHex); // a valid secret, or a throw
  return bech32.encode('nsec', bech32.toWords(hexToBytes(secretHex)));
}


/** NIP-01 id: sha256 of [0, pubkey, created_at, kind, tags, content]. */
export const eventId = (e) =>
  bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));

/** A signed event from a template. */
export function signEvent({ created_at, kind, tags, content }, secretHex) {
  const e = { pubkey: nostrPubkey(secretHex), created_at, kind, tags, content };
  const id = eventId(e);
  return { id, ...e, sig: bytesToHex(schnorr.sign(id, secretHex)) };
}

/**
 * The signatures already checked (verifyEvent's `seen`), at most `max` (5,000 by default), the least recently used
 * going first: a long-open page that scans the relays' catalog every 6 h doesn't keep every signature it ever saw.
 */
export class SeenSet extends Set {
  constructor(max = 5000) {
    super();
    this.max = max;
  }

  has(key) {
    if (!super.has(key)) return false;
    super.delete(key); // used again: the newest
    super.add(key);
    return true;
  }

  add(key) {
    super.delete(key);
    super.add(key);
    while (this.size > this.max) super.delete(super.values().next().value);
    return this;
  }
}

/**
 * True when the event is well formed, its id is its hash and its signature is its pubkey's. `seen` (a Set) remembers
 * the (id, pubkey, signature) triples that checked: the id is recomputed every time (a sha256), the costly schnorr
 * verify (~4 ms in JS) once.
 */
export function verifyEvent(e, seen) {
  if (!(seen instanceof Set)) seen = null; // as a callback (list.every(verifyEvent)) the second argument is an index
  try {
    const ok = HEX64.test(e.id) && HEX64.test(e.pubkey) && /^[0-9a-f]{128}$/.test(e.sig)
      && Number.isSafeInteger(e.created_at) && Number.isSafeInteger(e.kind) && typeof e.content === 'string'
      && Array.isArray(e.tags) && e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'));
    if (!ok || eventId(e) !== e.id) return false;
    const key = e.id + e.pubkey + e.sig;
    if (seen?.has(key)) return true;
    const good = schnorr.verify(e.sig, e.id, e.pubkey);
    if (good) seen?.add(key);
    return good;
  } catch {
    return false;
  }
}
