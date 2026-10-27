// The service worker (docs/design/pwa.md). The app never imports this file:
// in a build the `service-worker` plugin (vite.config.js) bundles it, with what
// it imports, into dist/sw.js, a classic script, followed by a call to start()
// with the build's files. The dev server has no service worker. It also takes
// the daily push (docs/design/push.md): src/pwa/wake.js.
import { wake } from './wake.js';
import { BATCH_LOCK } from './handoff.js';
import { appGet, appPut } from '../wallets.js';

/**
 * What the worker does with a request: 'asset' (a hashed build file: cache
 * first), 'page' (opening the app: network first, the cached page offline) or
 * null (not touched: the browser fetches it as if there were no worker).
 */
export function route({ method, url, mode }, origin) {
  const u = new URL(url);
  if (method !== 'GET' || u.origin !== origin) return null;
  if (u.pathname.startsWith('/assets/') || u.pathname === '/theme.js') return 'asset'; // theme.js: index.html's, before paint
  return mode === 'navigate' && (u.pathname === '/' || u.pathname === '/index.html') ? 'page' : null;
}

/** Precache `files` in the cache `name`, serve by route(), drop older caches, and take over only when the page asks. */
export function start(sw, files, name) {
  sw.addEventListener('install', (e) => e.waitUntil(precache(files, name)));
  sw.addEventListener('activate', (e) => e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== name).map((k) => caches.delete(k))))));
  sw.addEventListener('message', (e) => e.data === 'update' && sw.skipWaiting()); // the page's "Update ready, reload"
  sw.addEventListener('push', (e) => e.waitUntil(onPush(sw)));
  sw.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil(openApp(sw, e.notification.data?.url ?? '/'));
  });
  sw.addEventListener('fetch', (e) => {
    const r = route(e.request, sw.location.origin);
    // ignoreVary: a host's `Vary: Origin` would miss for a module script, which is sent with an Origin header.
    if (r === 'asset') e.respondWith(caches.match(e.request, { ignoreVary: true }).then((hit) => hit ?? fetch(e.request)));
    if (r === 'page') e.respondWith(fetch(e.request).catch(() => caches.match('/')));
  });
}

/** A hashed file an older cache already holds is copied, not downloaded again (DuckDB's wasm is 34 MB). */
async function precache(files, name) {
  const cache = await caches.open(name);
  await Promise.all(files.map(async (f) => {
    const old = f.startsWith('/assets/') && (await caches.match(f)); // the page and /theme.js are not hashed: fetched
    await (old ? cache.put(f, old) : cache.add(new Request(f, { cache: 'no-cache' })));
  }));
}

/**
 * The daily push: the day's batch sent if the app can't (wake), then always one notification, as browsers require. The
 * batch lock is asked for, not waited on: held, the app is sending it now.
 */
async function onPush(sw) {
  const lock = (fn) => (sw.navigator?.locks ? sw.navigator.locks.request(BATCH_LOCK, { ifAvailable: true }, (l) => (l ? fn() : null)) : fn());
  const n = await wake({ get: appGet, put: appPut, lock });
  await sw.registration.showNotification(n.title, { body: n.body, icon: '/icon-192.png', tag: 'satori-daily', data: { url: n.url } });
}

/** A notification's tap: the app's window to the front (at the notification's page), or a new one. */
async function openApp(sw, url) {
  const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const win = wins.find((c) => new URL(c.url).origin === sw.location.origin);
  if (!win) return sw.clients.openWindow(url);
  await win.focus();
  if (new URL(url, sw.location.origin).hash !== new URL(win.url).hash) win.postMessage({ open: url });
  return win;
}
