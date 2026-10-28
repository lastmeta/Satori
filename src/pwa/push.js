// The daily reminder (docs/design/push.md): Settings › This device's switch. On, this browser subscribes to the push
// server (/push/, the push/ folder) with the player's address, its time zone and the time of day it was turned on (each
// person's own time, one they are awake at); once a day at that time, if that player hasn't predicted this round, the
// server wakes the service worker (src/pwa/wake.js), which sends the day's batch or reminds. On means both: the
// browser's subscription, and what the server was told (IndexedDB REMINDER), written only once it said yes; a
// subscription the server never took is not On. The server is told only what changes: the player (followPlayer), and a subscription the
// browser replaces (the service worker's pushsubscriptionchange, src/pwa/sw.js). What it was told is kept in IndexedDB.
import { state } from '../ui/view.js';
import { appGet, appPut } from '../wallets.js';
import { REMINDER } from './handoff.js';

const ONCE = 'push-once'; // the Game's Remind me: the time it was set for (unix seconds)

export const BLOCKED = "Notifications are blocked for this site: allow them in the browser's settings, then turn this on.";
export const NO_PUSH = "This browser can't wake Satori with a notification.";
export const IOS_FIRST = 'On iPhone and iPad, add Satori to the Home Screen first, then turn this on there.';

const setReminder = (o) => { state.reminder = { ...state.reminder, ...o }; };
const supported = () => !!(import.meta.env.PROD && navigator.serviceWorker && globalThis.PushManager && globalThis.Notification);
const registration = () => navigator.serviceWorker.ready;

async function post(path, body) {
  const r = await fetch(`/push/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`The reminder server answered ${r.status}${r.status === 400 ? `: ${(await r.json().catch(() => ({}))).error}` : ''}.`);
  return r.json();
}

/** The switch's state at start, from the browser's subscription and what the server was told: no request. */
export async function startReminder() {
  if (!supported()) return setReminder({ supported: false, on: false, note: state.app.addTo === 'ios' && !state.app.installed ? IOS_FIRST : NO_PUSH });
  const [sub, told, once] = await Promise.all([registration().then((reg) => reg.pushManager.getSubscription()), appGet(REMINDER), appGet(ONCE)]);
  const on = !!sub && !!told;
  setReminder({ supported: true, note: '', on, minute: on ? told.minute ?? null : null, once: sub ? once : null });
}

/**
 * Another player (Stake, Unstake, Automatic or By hand): the server told, if the reminder is on and it was told another.
 * One at a time: refreshes that overlap tell it once.
 */
let following = Promise.resolve();
export function followPlayer(player) {
  following = following.catch(() => {}).then(() => tellPlayer(player));
  return following;
}
async function tellPlayer(player) {
  if (!supported() || !player) return;
  const told = await appGet(REMINDER);
  if (!told || told.player === player) return;
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  await post('subscribe', { subscription: sub.toJSON(), player, tz: told.tz });
  await appPut(REMINDER, { ...told, player });
}

/** Permission (on a tap), and this browser's subscription: the one it has, else a new one. → { sub, had } */
async function subscription(reg) {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error(BLOCKED);
  const had = await reg.pushManager.getSubscription();
  if (had) return { sub: had, had };
  const r = await fetch('/push/key');
  if (!r.ok) throw new Error(`The reminder server answered ${r.status}.`);
  const { key } = await r.json();
  return { sub: await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), had: null };
}

/**
 * The Game's Remind me: one notification at `at` (unix seconds: when the game opens again), whether or not the daily
 * reminder is on. The browser subscribes if it hasn't; a server that refuses leaves nothing set (a new subscription
 * dropped). Kept in IndexedDB (ONCE) so the button says it is set. → at
 */
export async function remindOnce(at) {
  if (!supported()) throw new Error(state.reminder?.note || NO_PUSH);
  const { sub, had } = await subscription(await registration());
  try {
    await post('once', { subscription: sub.toJSON(), at });
  } catch (err) {
    if (!had) await sub.unsubscribe().catch(() => {});
    throw err;
  }
  await appPut(ONCE, at);
  setReminder({ once: at });
  return at;
}

/** On: permission, the subscription, the server told this time of day. Off: the server told, the subscription dropped. */
export async function turnReminder(on, player) {
  if (!supported()) throw new Error(state.reminder?.note || NO_PUSH);
  const reg = await registration();
  if (on) {
    const { sub, had } = await subscription(reg);
    const now = new Date();
    const told = { player, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, minute: now.getHours() * 60 + now.getMinutes() };
    let minute;
    try {
      ({ minute } = await post('subscribe', { subscription: sub.toJSON(), ...told })); // this time of day, each day from tomorrow
    } catch (err) {
      if (!had) await sub.unsubscribe().catch(() => {}); // the server never took it: not On
      throw err;
    }
    await appPut(REMINDER, { ...told, minute });
    setReminder({ on, minute });
  } else {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('unsubscribe', { endpoint: sub.endpoint }).catch((err) => console.warn('[satori] reminder', err));
      await sub.unsubscribe();
    }
    await appPut(REMINDER, null);
    await appPut(ONCE, null); // the subscription is gone, and the server dropped it with the daily one
    setReminder({ on, minute: null, once: null });
  }
  return state.reminder;
}

/** A notification's tap with the app open: the service worker asks the page to go to its page (src/pwa/sw.js). */
export function followNotifications() {
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const url = e.data?.open;
    if (typeof url === 'string' && url.startsWith('/')) location.hash = new URL(url, location.origin).hash;
  });
}
