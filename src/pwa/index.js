// The installed app (docs/design/pwa.md): the service worker in a build (never
// on the dev server, where it would serve stale code) and its Update button,
// Install, and persistent storage, which keeps the keys from eviction.
import { state } from '../ui/view.js';

let installPrompt = null; // Chromium's beforeinstallprompt, kept for Install
let registration = null;
const setApp = (o) => { state.app = { ...state.app, ...o }; };
const UA = navigator.userAgent;

export function startPwa() {
  setApp({ installed: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true });
  state.safari = /Safari\//.test(UA) && !/Chrom|CriOS|FxiOS|EdgiOS|Android/.test(UA); // no prompt: say how to add it
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
  const sw = navigator.serviceWorker;
  if (!sw) return;
  // Dev: a worker left from a build on this origin goes (unregister() takes effect from the next load).
  if (!import.meta.env.PROD) return void sw.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
  sw.register('/sw.js').then((reg) => {
    registration = reg;
    const waiting = () => setApp({ update: !!(reg.waiting && reg.active) });
    waiting();
    reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', waiting));
    setInterval(() => reg.update().catch(() => {}), 3600_000); // a window left open still finds a new version
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
