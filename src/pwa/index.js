// The installed app (docs/design/pwa.md): the service worker in a build (never
// on the dev server, where it would serve stale code) and its Update button,
// Install, and persistent storage, which keeps the keys from eviction.
import { state } from '../ui/view.js';
import { addToOf } from './platform.js';

let installPrompt = null; // Chromium's beforeinstallprompt, kept for Install
let registration = null;
const setApp = (o) => { state.app = { ...state.app, ...o }; };
const UA = navigator.userAgent;

export function startPwa() {
  // addTo: how this browser adds Satori without a prompt (iOS, Safari on a Mac, Firefox on Android), said on Setup,
  // in Settings and once on Home (src/pwa/platform.js)
  setApp({ installed: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    addTo: addToOf(UA, navigator.maxTouchPoints ?? 0) });
  addEventListener('beforeinstallprompt', (e) => {
    if (state.app.installed) return; // an app window opened by --app is offered it too
    e.preventDefault();
    installPrompt = e;
    setApp({ canInstall: true });
  });
  addEventListener('appinstalled', () => {
    installPrompt = null;
    setApp({ installed: true, canInstall: false });
    keepStorage(); // an installed app's storage is kept
  });
  // Dev: a worker left from a build on this origin goes (unregister() takes effect from the next load).
  if (!import.meta.env.PROD) navigator.serviceWorker?.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
}

/**
 * A build's service worker, registered once the database is open: on a first visit its precache (DuckDB's wasm with
 * the rest) would compete with the page's own download of the engine, and stall its progress behind the browser's
 * cache lock; after it, the precache takes the wasm from the HTTP cache (docs/design/pwa.md#caching).
 */
export function registerWorker() {
  const sw = navigator.serviceWorker;
  if (!sw || !import.meta.env.PROD || registration) return;
  sw.register('/sw.js').then((reg) => {
    registration = reg;
    // A new version found by this load (waiting from before, or installed by the load's own check) is the code this
    // page already runs (the page is network-first): it just takes over, no reload and nothing said. One found later
    // (the hourly check, or on coming back to the page) waits for "Update ready, reload".
    let byLoad = true;
    const waiting = () => {
      const has = !!(reg.waiting && reg.active);
      if (has && byLoad) return void reg.waiting.postMessage('update');
      setApp({ update: has });
    };
    const look = () => {
      byLoad = false;
      reg.update().catch(() => {});
    };
    waiting();
    reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', waiting));
    setInterval(look, 12 * 3600_000); // a window left open still finds a new version (twice a day)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') look(); }); // back to the page
  }).catch((err) => console.warn('[satori] service worker', err));
}

/** The waiting version takes over, then the page reloads: only when asked, never on its own (a batch may be in flight). */
export function applyUpdate() {
  if (!registration?.waiting) return false;
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  registration.waiting.postMessage('update');
  return true;
}

/** Chromium's install prompt (needs a user gesture). → 'accepted' | 'dismissed' | 'unavailable' */
export async function install() {
  const p = installPrompt;
  if (!p) return 'unavailable';
  await p.prompt();
  installPrompt = null; // one prompt per event
  setApp({ canInstall: false });
  return (await p.userChoice).outcome;
}

/** { persisted, usage, quota } in bytes (null where the browser does not say). */
export async function storage() {
  const [persisted, { usage = null, quota = null }] = await Promise.all([navigator.storage.persisted(), navigator.storage.estimate()]);
  return { persisted, usage, quota };
}

/** Ask for persistent storage unless it is kept already (each load until granted); Home shows the result. */
export function keepStorage() {
  return navigator.storage.persisted().then((kept) => kept || navigator.storage.persist())
    .then(storage).then((s) => { state.storage = s; })
    .catch((err) => console.warn('[satori] storage', err));
}
