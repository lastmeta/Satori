// NIP-01 events and the Nostr key, against events made by satorilib's own client
// and nostr-sdk (test/fixtures/nostr-parity.json) and a live relay's (nostr-live.json).
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  nostrPubkey, generateNostrSecret, npub, nsec, nostrSecretOf, eventId, signEvent, verifyEvent, SeenSet,
} from './event.js';

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/nostr-parity.json', import.meta.url)));
const live = JSON.parse(readFileSync(new URL('../../test/fixtures/nostr-live.json', import.meta.url)));
const id = JSON.parse(readFileSync(new URL('../../test/fixtures/alias-parity.json', import.meta.url))).nostr;

describe('the Nostr key', () => {
  test("pubkey from the secret, as nostr_sdk's Keys", () => {
    expect(nostrPubkey(id.secretHex)).toBe(id.pubkeyHex);
    expect(nostrPubkey(fx.secretHex)).toBe(fx.pubkeyHex);
  });
  test('random, 64 lowercase hex, a valid key', () => {
    const a = generateNostrSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateNostrSecret()).not.toBe(a);
    expect(nostrPubkey(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('refuses a secret that is not a key', () => {
    expect(() => nostrPubkey('00'.repeat(32))).toThrow();
    expect(() => nostrPubkey('zz')).toThrow();
  });
  test('nsec (NIP-19): the spec\'s own example', () => {
    expect(nsec('67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa'))
      .toBe('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5');
    expect(() => nsec('00')).toThrow();
  });
  test('a Nostr secret from its backup: nsec or hex, either case, spaces around', () => {
    const hex = '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa';
    expect(nostrSecretOf(' nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5 ')).toBe(hex);
    expect(nostrSecretOf(hex.toUpperCase())).toBe(hex);
    for (const bad of ['', 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe6', npub(id.pubkeyHex), '00'.repeat(32), 'zz']) {
      expect(() => nostrSecretOf(bad), bad).toThrow(/nsec or 64 hex/);
    }
  });
  test('npub (NIP-19)', () => {
    // nostr-sdk's PublicKey.to_bech32() for the fixture key.
    expect(npub(id.pubkeyHex)).toBe('npub1vf6kzy7dj9axtynrat2smg848rvh5h2vhux9wdryzspkf7df3nyqk599tm');
  });
});

describe('events', () => {
  test("every fixture event's id is recomputed and its nostr-sdk signature verifies", () => {
    for (const [name, e] of Object.entries(fx.events)) {
      expect(eventId(e), name).toBe(e.id);
      expect(verifyEvent(e), name).toBe(true);
    }
  });
  test('the brief vectors (compact content) recompute: the id function, not the content', () => {
    const S = 'btc-usd-price_pred';
    const e = { pubkey: fx.pubkeyHex, created_at: 1792073160, kind: 34601,
      tags: [['d', S], ['stream', S], ['seq', '1'], ['satori', 'observation']],
      content: JSON.stringify({ stream_name: S, timestamp: 1792073160, value: '80100.5', seq_num: 1 }) };
    expect(eventId(e)).toBe('345fa77e81095b1f26fbb67e8491e4b88c914fd21dc5c64b575c238e17c2f4ae');
  });
  test('sign → verify; a changed field fails', () => {
    const e = signEvent({ created_at: 1792073160, kind: 1, tags: [['t', 'x']], content: 'hi' }, fx.secretHex);
    expect(e.pubkey).toBe(fx.pubkeyHex);
    expect(e.id).toBe(eventId(e));
    expect(e.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyEvent(e)).toBe(true);
    expect(verifyEvent({ ...e, content: 'ho' })).toBe(false);
    expect(verifyEvent({ ...e, id: fx.events.prediction.id })).toBe(false);
    expect(verifyEvent({ ...e, sig: fx.events.prediction.sig })).toBe(false);
    expect(verifyEvent({ ...e, created_at: '1792073160' })).toBe(false);
    expect(verifyEvent(null)).toBe(false);
  });
  test('events from a live relay verify', () => {
    for (const e of live.events) expect(verifyEvent(e)).toBe(true);
  });
});

test('SeenSet: the signatures checked, at most `max`, the least recently used going first; verifyEvent takes it as its seen set', () => {
  const secret = 'dd278564ca11c31ffb929b807c65d07a7cb0fddfd26b2d97a91f84ed0b3086e4';
  const [a, b, c] = [1, 2, 3].map((n) => signEvent({ created_at: n, kind: 1, tags: [], content: String(n) }, secret));
  const seen = new SeenSet(2);
  expect(seen).toBeInstanceOf(Set);
  for (const e of [a, b]) expect(verifyEvent(e, seen)).toBe(true);
  expect(seen.size).toBe(2);
  expect(verifyEvent(a, seen)).toBe(true); // a used again: b is now the oldest
  expect(verifyEvent(c, seen)).toBe(true);
  expect(seen.size).toBe(2);
  expect([...seen].map((k) => k.slice(0, 64))).toEqual([a.id, c.id]);
  expect(new SeenSet().max).toBe(5000);
});
