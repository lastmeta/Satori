import { describe, it, expect } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { toFunctionSelector } from 'viem';
import { checkSubscription, due, localTime, subscribed, newVapid, publicOf, vapidHeader, predictedCounts, sendPush,
  GET_CURRENT_ROUND, PREDICTED_STREAMS_COUNT } from './push.mjs';

const PLAYER = '0x91dF4af6C0756efb195CcB1181738Bbdc414AD63';
const FCM = 'https://fcm.googleapis.com/fcm/send/abc:def';

describe('VAPID', () => {
  it('signs an ES256 JWT for the endpoint origin that its public key verifies', () => {
    const v = newVapid();
    expect(publicOf(v.privateJwk)).toBe(v.publicKey);
    expect(Buffer.from(v.publicKey, 'base64url')).toHaveLength(65);
    const h = vapidHeader({ endpoint: FCM, ...v, subject: 'https://app.satorinet.io', now: 1000 });
    const [, t, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(k).toBe(v.publicKey);
    const [head, body, sig] = t.split('.');
    expect(JSON.parse(Buffer.from(body, 'base64url'))).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1000 + 43200, sub: 'https://app.satorinet.io' });
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: v.privateJwk.x, y: v.privateJwk.y }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
  });
});

describe('subscriptions', () => {
  it('takes the browsers\' push services only, a player address and a known time zone', () => {
    expect(checkSubscription({ subscription: { endpoint: FCM }, player: PLAYER, tz: 'Europe/Berlin' })).toEqual({ endpoint: FCM, player: PLAYER, tz: 'Europe/Berlin', minute: null });
    expect(checkSubscription({ subscription: { endpoint: 'https://web.push.apple.com/x' }, player: PLAYER }).tz).toBe('UTC');
    expect(() => checkSubscription({ subscription: { endpoint: 'https://evil.example/x' }, player: PLAYER })).toThrow('not a push service');
    expect(() => checkSubscription({ subscription: { endpoint: 'http://fcm.googleapis.com/x' }, player: PLAYER })).toThrow('not a push service');
    expect(() => checkSubscription({ subscription: { endpoint: FCM }, player: '0x12' })).toThrow('no player');
    expect(() => checkSubscription({ subscription: { endpoint: FCM }, player: PLAYER, tz: 'Mars/Base' })).toThrow('time zone');
  });

  it('is due once a local day, from its own minute on', () => {
    const at = Date.UTC(2026, 9, 27, 8, 30); // 08:30 UTC = 09:30 in Berlin (CET from the 25th), 04:30 in New York
    expect(localTime('Europe/Berlin', at)).toEqual({ day: '2026-10-27', minute: 9 * 60 + 30 });
    expect(due({ tz: 'Europe/Berlin', minute: 9 * 60 + 30, done: null }, at)).toBe('2026-10-27');
    expect(due({ tz: 'Europe/Berlin', minute: 9 * 60 + 31, done: null }, at)).toBe(null);
    expect(due({ tz: 'Europe/Berlin', minute: 0, done: '2026-10-27' }, at)).toBe(null);
    expect(due({ tz: 'America/New_York', minute: 21 * 60 + 15, done: '2026-10-26' }, at)).toBe(null);
    expect(due({ tz: 'America/New_York', minute: 4 * 60, done: '2026-10-26' }, at)).toBe('2026-10-27');
  });

  it('takes the minute it reminds at, the time of day it was turned on', () => {
    const s = { subscription: { endpoint: FCM }, player: PLAYER };
    expect(checkSubscription({ ...s, minute: 581 }).minute).toBe(581);
    expect(checkSubscription(s).minute).toBe(null);
    expect(() => checkSubscription({ ...s, minute: 1440 })).toThrow('minute');
    expect(() => checkSubscription({ ...s, minute: 9.5 })).toThrow('minute');
  });
});

describe('kept', () => {
  const at = Date.UTC(2026, 9, 27, 18, 45); // 18:45 UTC
  const s = { endpoint: FCM, player: PLAYER, tz: 'UTC' };

  it('turned on now: this minute, from tomorrow', () => {
    expect(subscribed(undefined, { ...s, minute: 1125 }, at)).toMatchObject({ minute: 1125, done: '2026-10-27' });
  });

  it('a new player keeps the minute, and today still comes if its time has not', () => {
    expect(subscribed({ ...s, minute: 1200, done: '2026-10-26' }, { ...s, player: '0x' + '2'.repeat(40), minute: null }, at))
      .toMatchObject({ minute: 1200, done: null, player: '0x' + '2'.repeat(40) });
    expect(subscribed({ ...s, minute: 600, done: '2026-10-27' }, { ...s, minute: null }, at)).toMatchObject({ minute: 600, done: '2026-10-27' });
  });

  it('a subscription the browser replaced keeps its minute; one never told any takes now', () => {
    expect(subscribed(undefined, { ...s, minute: 1200 }, at)).toMatchObject({ minute: 1200, done: null });
    expect(subscribed(undefined, { ...s, minute: null }, at)).toMatchObject({ minute: 1125, done: '2026-10-27' });
  });
});

describe('the chain read', () => {
  it('uses the contracts\' selectors', () => {
    expect(GET_CURRENT_ROUND).toBe(toFunctionSelector('getCurrentRound()'));
    expect(PREDICTED_STREAMS_COUNT).toBe(toFunctionSelector('predictedStreamsCount(address,uint256)'));
  });

  it('reads the round, then every player\'s count this round in one batch', async () => {
    const asked = [];
    const fetch = async (_, { body }) => {
      const b = JSON.parse(body);
      asked.push(b);
      const json = Array.isArray(b) ? b.map((c) => ({ id: c.id, result: c.params[0].data.includes('91df4af6') ? '0x2' : '0x0' })) : { id: 0, result: '0x5113' };
      return { ok: true, json: async () => json };
    };
    const m = await predictedCounts({ rpc: 'x', token: '0xT', engine: '0xE', players: [PLAYER, PLAYER.toLowerCase(), '0x' + '1'.repeat(40)], fetch });
    expect(m.get(PLAYER.toLowerCase())).toBe(2);
    expect(m.get('0x' + '1'.repeat(40))).toBe(0);
    expect(asked[1]).toHaveLength(2); // the same player once
    expect(asked[1][0].params[0].data).toBe(`${PREDICTED_STREAMS_COUNT}${'0'.repeat(24)}91df4af6c0756efb195ccb1181738bbdc414ad63${'5113'.padStart(64, '0')}`);
  });
});

describe('sending', () => {
  it('posts an empty push with VAPID; 404 and 410 mean the subscription is gone', async () => {
    const v = newVapid();
    let seen;
    const at = (status) => async (url, o) => { seen = { url, o }; return { status, ok: status < 300 }; };
    expect(await sendPush({ endpoint: FCM, vapid: v, subject: 's', fetch: at(201) })).toBe('ok');
    expect(seen.o.headers.authorization).toMatch(/^vapid t=/);
    expect(seen.o.headers.ttl).toBe('43200');
    expect(await sendPush({ endpoint: FCM, vapid: v, subject: 's', fetch: at(410) })).toBe('gone');
    expect(await sendPush({ endpoint: FCM, vapid: v, subject: 's', fetch: at(500) })).toBe('failed');
  });
});

describe('a one-off reminder (the Game\'s Remind me)', () => {
  it('takes a push service endpoint and a time within 2 days, in unix seconds', async () => {
    const { checkOnce } = await import('./push.mjs');
    const now = 1_800_000_000_000;
    expect(checkOnce({ subscription: { endpoint: FCM }, at: 1_800_003_600 }, now)).toEqual({ endpoint: FCM, at: 1_800_003_600_000 });
    expect(() => checkOnce({ subscription: { endpoint: 'https://evil.example/x' }, at: 1_800_003_600 }, now)).toThrow('not a push service');
    expect(() => checkOnce({ subscription: { endpoint: FCM }, at: 1_800_000_000 + 3 * 86400 }, now)).toThrow('within 2 days');
    expect(() => checkOnce({ subscription: { endpoint: FCM }, at: '1' }, now)).toThrow('unix seconds');
  });
});
