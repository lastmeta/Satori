import { describe, it, expect } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { toFunctionSelector } from 'viem';
import { checkSubscription, due, localTime, newVapid, publicOf, vapidHeader, predictedCounts, sendPush,
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
    expect(checkSubscription({ subscription: { endpoint: FCM }, player: PLAYER, tz: 'Europe/Berlin' })).toEqual({ endpoint: FCM, player: PLAYER, tz: 'Europe/Berlin' });
    expect(checkSubscription({ subscription: { endpoint: 'https://web.push.apple.com/x' }, player: PLAYER }).tz).toBe('UTC');
    expect(() => checkSubscription({ subscription: { endpoint: 'https://evil.example/x' }, player: PLAYER })).toThrow('not a push service');
    expect(() => checkSubscription({ subscription: { endpoint: 'http://fcm.googleapis.com/x' }, player: PLAYER })).toThrow('not a push service');
    expect(() => checkSubscription({ subscription: { endpoint: FCM }, player: '0x12' })).toThrow('no player');
    expect(() => checkSubscription({ subscription: { endpoint: FCM }, player: PLAYER, tz: 'Mars/Base' })).toThrow('time zone');
  });

  it('is due once a local day, from the hour on', () => {
    const at = Date.UTC(2026, 9, 27, 8, 30); // 08:30 UTC = 09:30 in Berlin (CET from the 25th), 04:30 in New York
    expect(localTime('Europe/Berlin', at)).toEqual({ day: '2026-10-27', hour: 9 });
    expect(due({ tz: 'Europe/Berlin', done: null }, at, 9)).toBe('2026-10-27');
    expect(due({ tz: 'Europe/Berlin', done: '2026-10-27' }, at, 9)).toBe(null);
    expect(due({ tz: 'America/New_York', done: null }, at, 9)).toBe(null);
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
