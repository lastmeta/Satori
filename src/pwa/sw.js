// The service worker (docs/design/pwa.md). The app never imports this file:
// in a build the `service-worker` plugin (vite.config.js) writes it out as
// dist/sw.js, a classic script (`export` dropped), followed by a call to
// start() with the build's files. The dev server has no service worker.

/**
 * What the worker does with a request: 'asset' (a hashed build file: cache
 * first), 'page' (opening the app: network first, the cached page offline) or
 * null (not touched: the browser fetches it as if there were no worker).
 */
export function route({ method, url, mode }, origin) {
  const u = new URL(url);
  if (method !== 'GET' || u.origin !== origin) return null;
  if (u.pathname.startsWith('/assets/')) return 'asset';
  return mode === 'navigate' && (u.pathname === '/' || u.pathname === '/index.html') ? 'page' : null;
}

/** Precache `files` in the cache `name`, serve by route(), drop older caches, and take over only when the page asks. */
export function start(sw, files, name) {
  sw.addEventListener('install', (e) => e.waitUntil(precache(files, name)));
  sw.addEventListener('activate', (e) => e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== name).map((k) => caches.delete(k))))));
  sw.addEventListener('message', (e) => e.data === 'update' && sw.skipWaiting()); // the page's "Update ready, reload"
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
    const old = f !== '/' && (await caches.match(f));
    await (old ? cache.put(f, old) : cache.add(new Request(f, { cache: 'no-cache' })));
  }));
}
