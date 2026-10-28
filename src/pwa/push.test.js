// The daily reminder's switch (docs/design/push.md): On means both the browser's subscription and the server told.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map();
vi.mock('../wallets.js', () => ({ appGet: async (k) => store.get(k) ?? null, appPut: async (k, v) => { store.set(k, v); } }));
vi.mock('../ui/view.js', () => ({ state: { reminder: {}, app: {} } }));

let sub; // the browser's subscription, or null
let answer; // the push server's answer to /push/subscribe
const fakeSub = () => ({ endpoint: 'https://push.example/1', toJSON: () => ({ endpoint: 'https://push.example/1' }),
  unsubscribe: vi.fn(async () => { sub = null; }) });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('PROD', true);
  store.clear();
  sub = null;
  answer = { ok: true, status: 200, json: async () => ({ minute: 600 }) };
  const pushManager = { getSubscription: async () => sub, subscribe: async () => { sub = fakeSub(); return sub; } };
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager }) } });
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('Notification', { requestPermission: async () => 'granted' });
  vi.stubGlobal('fetch', async (url) => (String(url).endsWith('/push/key') ? { ok: true, json: async () => ({ key: 'k' }) } : answer));
});

describe('the reminder switch', () => {
  it('On only once the server took it: a refused subscribe is undone, and the switch stays Off after a reload', async () => {
    const { turnReminder, startReminder } = await import('./push.js');
    const { state } = await import('../ui/view.js');
    answer = { ok: false, status: 503, json: async () => ({}) };
    await expect(turnReminder(true, '0xabc')).rejects.toThrow('The reminder server answered 503.');
    expect(sub).toBe(null); // the browser's subscription dropped: nothing claims to be On
    await startReminder();
    expect(state.reminder.on).toBe(false);
    answer = { ok: true, status: 200, json: async () => ({ minute: 600 }) };
    await turnReminder(true, '0xabc');
    await startReminder();
    expect([state.reminder.on, state.reminder.minute]).toEqual([true, 600]);
  });

  it("a subscription the server was never told of is not On", async () => {
    const { startReminder } = await import('./push.js');
    const { state } = await import('../ui/view.js');
    sub = fakeSub(); // an earlier version's, say: subscribed, never told
    await startReminder();
    expect(state.reminder.on).toBe(false);
  });

  it("Remind me: one push at a time, set only once the server took it; turning the daily reminder off drops it", async () => {
    const { remindOnce, turnReminder, startReminder } = await import('./push.js');
    const { state } = await import('../ui/view.js');
    answer = { ok: false, status: 503, json: async () => ({}) };
    await expect(remindOnce(1_800_000_000)).rejects.toThrow('503');
    expect(sub).toBe(null);
    answer = { ok: true, status: 200, json: async () => ({ ok: true, minute: 600 }) };
    await remindOnce(1_800_000_000);
    await startReminder();
    expect([state.reminder.once, state.reminder.on]).toEqual([1_800_000_000, false]); // the daily reminder still off
    await turnReminder(true, '0xabc');
    await turnReminder(false, '0xabc');
    await startReminder();
    expect(state.reminder.once).toBe(null);
  });
});
