// The daily reminder (docs/design/push.md): Settings › This device's switch. On, this browser subscribes to the push
// server (/push/, the push/ folder) with the player's address, its time zone and the time of day it was turned on (each
// person's own time, one they are awake at); once a day at that time, if that player hasn't
// predicted this round, the server wakes the service worker (src/pwa/wake.js), which sends the day's batch or reminds.
// The subscription is the switch's truth: the browser keeps it, and the server is told it again at each start.
import { state } from '../ui/view.js';

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
/** The server told the subscription; `minute` (of the local day) only when turned on, else it keeps its own. → its minute */
async function tell(sub, player, minute = null) {
  const r = await post('subscribe', { subscription: sub.toJSON(), player, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(minute == null ? {} : { minute }) });
  setReminder({ minute: Number.isInteger(r?.minute) ? r.minute : null });
}

/** The switch's state at start, and the server told the subscription again (with today's player). */
export async function startReminder(player) {
  if (!supported()) return setReminder({ supported: false, on: false, note: state.app.addTo === 'ios' && !state.app.installed ? IOS_FIRST : NO_PUSH });
  setReminder({ supported: true, note: '' });
  const sub = await (await registration()).pushManager.getSubscription();
  setReminder({ on: !!sub });
  if (sub && player) await tell(sub, player).catch((err) => console.warn('[satori] reminder', err));
}

/** On: permission, the subscription, the server told. Off: the server told, the subscription dropped. → state.reminder */
export async function turnReminder(on, player) {
  if (!supported()) throw new Error(state.reminder?.note || NO_PUSH);
  const reg = await registration();
  if (on) {
    if ((await Notification.requestPermission()) !== 'granted') throw new Error(BLOCKED);
    const r = await fetch('/push/key');
    if (!r.ok) throw new Error(`The reminder server answered ${r.status}.`);
    const { key } = await r.json();
    const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const now = new Date();
    await tell(sub, player, now.getHours() * 60 + now.getMinutes()); // this time of day, each day from tomorrow
  } else {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('unsubscribe', { endpoint: sub.endpoint }).catch((err) => console.warn('[satori] reminder', err));
      await sub.unsubscribe();
    }
  }
  setReminder({ on, ...(on ? {} : { minute: null }) });
  return state.reminder;
}

/** A notification's tap with the app open: the service worker asks the page to go to its page (src/pwa/sw.js). */
export function followNotifications() {
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const url = e.data?.open;
    if (typeof url === 'string' && url.startsWith('/')) location.hash = new URL(url, location.origin).hash;
  });
}
