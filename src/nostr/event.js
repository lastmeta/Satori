// NIP-01 events and the Nostr key (docs/design/nostr.md), over @noble/curves'
// BIP-340 schnorr, as nostr-sdk makes them for Satori Lite:
//   nostrPubkey(secretHex) / generateNostrSecret() / npub(pubkeyHex)
//   signEvent({ created_at, kind, tags, content }, secretHex) → event
//   verifyEvent(event) → id and signature check
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import { generateEntropy } from '../keys/keys.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** The x-only public key (64 hex) of a secret (64 hex), as nostr-sdk's Keys. */
export function nostrPubkey(secretHex) {
  if (!HEX64.test(String(secretHex))) throw new Error('A Nostr secret is 64 lowercase hex characters.');
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex))); // throws outside 1..n-1
}

/** A random secret (64 hex), independent of the identity and the vault (start.py:136-138). */
export const generateNostrSecret = () => bytesToHex(generateEntropy());

/** NIP-19 npub of a pubkey. */
export const npub = (pubkeyHex) => bech32.encode('npub', bech32.toWords(hexToBytes(pubkeyHex)));


/** NIP-01 id: sha256 of [0, pubkey, created_at, kind, tags, content]. */
export const eventId = (e) =>
  bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));

/** A signed event from a template. */
export function signEvent({ created_at, kind, tags, content }, secretHex) {
  const e = { pubkey: nostrPubkey(secretHex), created_at, kind, tags, content };
  const id = eventId(e);
  return { id, ...e, sig: bytesToHex(schnorr.sign(id, secretHex)) };
}

/** True when the event is well formed, its id is its hash and its signature is its pubkey's. */
export function verifyEvent(e) {
  try {
    const ok = HEX64.test(e.id) && HEX64.test(e.pubkey) && /^[0-9a-f]{128}$/.test(e.sig)
      && Number.isSafeInteger(e.created_at) && Number.isSafeInteger(e.kind) && typeof e.content === 'string'
      && Array.isArray(e.tags) && e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'));
    return ok && eventId(e) === e.id && schnorr.verify(e.sig, e.id, e.pubkey);
  } catch {
    return false;
  }
}
