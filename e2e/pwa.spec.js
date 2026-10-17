// The installed app (docs/design/pwa.md) against a build: `npm run e2e:pwa`
// builds, then runs this against `vite preview` on :5181
// (playwright.pwa.config.js). Each test launches Chrome with its own profile,
// as a person's browser: Playwright's usual contexts are incognito, where
// nothing is installable. Every host but localhost is unresolvable, and a
// build's central (prod) is routed to the stub, so nothing leaves this box.
import { expect, test, chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { loaded, reloadApp, polled, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';
import { CSP } from '../csp.js';

const APP = 'http://localhost:5181/';
const PROD = 'https://network.satorinet.io'; // a build's central
const T0 = Math.floor(Date.now() / 1000) - 3600;
const BATCH = [{
  id: 1, observed_at: `${T0}.5`, value: '67000.5', hash: '', stream_id: 1, stream_uuid: 'u-btc', ts: new Date(T0 * 1000).toISOString().slice(0, -1),
  stream: { id: 1, uuid: 'u-btc', name: 'bitcoin', author: null, secondary: null, target: null, meta: null, description: null },
}];

/** Chrome with a profile of its own; `args` added. → { context, stub } */
async function launch(args = []) {
  const context = await chromium.launchPersistentContext(test.info().outputPath(`profile-${Date.now()}`), {
    channel: 'chrome', headless: true,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost', '--bypass-app-banner-engagement-checks', ...args],
  });
  const stub = await stubCentral(context, { url: PROD });
  stub.batch = BATCH;
  await context.addInitScript(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    window.persistCalls = 0;
    const persist = StorageManager.prototype.persist;
    StorageManager.prototype.persist = function counted() { window.persistCalls++; return persist.call(this); };
  });
  return { context, stub };
}

const status = (page) => page.evaluate(() => window.satori.status());
const controlled = (page) => page.evaluate(() => !!navigator.serviceWorker.controller);

test.describe.serial('a build, in a browser profile', () => {
  let context;
  let stub;
  let page;
  test.beforeAll(async () => {
    ({ context, stub } = await launch());
    page = context.pages()[0];
  });
  test.afterAll(() => context?.close());

  test('the manifest is valid and installable; the service worker precaches and controls the page; Install and storage on Setup and Home', async () => {
    await page.goto(APP);
    expect(await loaded(page)).toBe('setup');
    const cdp = await context.newCDPSession(page);
    const m = await cdp.send('Page.getAppManifest');
    expect(m.url).toBe(`${APP}manifest.webmanifest`);
    expect(m.errors).toEqual([]);
    expect(JSON.parse(m.data)).toMatchObject({ name: 'Satori neuron', short_name: 'Satori', start_url: '/', scope: '/', display: 'standalone',
      theme_color: '#f6f7f9', background_color: '#f6f7f9' });
    expect(JSON.parse(m.data).icons.map((i) => `${i.sizes} ${i.purpose ?? 'any'}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    for (const icon of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
      expect((await context.request.get(APP + icon)).headers()['content-type']).toBe('image/png');
    }
    await expect.poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);

    // The worker: served with the CSP, and installed with the page and the hashed assets in its cache.
    const sw = await context.request.get(`${APP}sw.js`);
    expect(sw.headers()['content-security-policy']).toBe(CSP);
    expect(sw.headers()['content-type']).toMatch(/javascript/);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cached = await page.evaluate(async () => {
      const [name] = await caches.keys();
      return (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
    });
    expect(cached).toContain('/');
    expect(cached.filter((p) => /^\/assets\/duckdb-(eh-.*\.wasm|browser-eh\.worker-.*\.js)$/.test(p))).toHaveLength(2);
    expect(cached.some((p) => p.includes('-mvp'))).toBe(false);

    // Setup: Install (Chromium's prompt was offered), no storage request yet.
    const s0 = await status(page);
    expect(s0.app).toEqual({ installed: false, canInstall: true, update: false });
    expect(s0.storage).toEqual({ persisted: expect.any(Boolean), usage: expect.any(Number), quota: expect.any(Number) });
    await expect(page.locator('[data-test=install]').filter({ visible: true })).toHaveText('Install Satori');
    expect(await page.evaluate(() => window.persistCalls)).toBe(0);

    // Home: persistent storage asked for right after setup; the storage line and Install by the keys.
    await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
    await expect.poll(() => page.evaluate(() => window.persistCalls)).toBe(1);
    const s1 = await status(page);
    await expect(page.locator('[data-test=storage]')).toHaveText(s1.storage.persisted ? /^Storage: kept · \d/
      : /^Storage: the browser may clear it; install Satori or back up your words · [\d.]+ MB of [\d.]+ GB used$/);
    await page.evaluate(() => window.satori.go('settings'));
    await expect(page.locator('#settings-device [data-test=install]')).toBeVisible();
    await expect(page.locator('#settings-device [data-test=install-hint]')).toHaveText('Keeps your keys, and runs in its own window.');

    // A reload is the worker's: the page comes from it, and asks for storage again unless it is kept.
    const res = await page.reload();
    expect(res.fromServiceWorker()).toBe(true);
    expect(await loaded(page)).toBe('home');
    expect(await controlled(page)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.persistCalls)).toBe(s1.storage.persisted ? 0 : 1);
    expect(stub.registered.length).toBe(2); // central's calls still reach it (the stub) under the worker
    expect(await page.evaluate(() => window.violations)).toEqual([]);
  });

  test('offline: the page, DuckDB and the stored neuron load from the cache; central, Base and /llms.txt fail and say so', async () => {
    expect((await polled(page)).lastPoll).toMatchObject({ streams: 1, new: 1, predicted: 1 }); // the first poll, at once after setup
    const { identity, vault } = await status(page);

    await context.unroute(`${PROD}/**`); // central is now only the network, which is gone
    await context.setOffline(true);
    try {
      expect(await context.serviceWorkers()[0].evaluate(() => fetch('/').then(() => 'online', () => 'offline'))).toBe('offline');
      const res = await page.reload();
      expect(res.fromServiceWorker()).toBe(true); // network first failed: the cached page
      expect(await loaded(page)).toBe('home'); // DuckDB's worker and wasm from the cache, the keys from OPFS
      await expect(page.locator('[data-test=identity]')).toHaveText(identity);
      await expect(page.locator('[data-test=vault]')).toHaveText(vault);
      await expect(page.locator('[data-test=streams-count]')).toHaveText('1 from central, with our forecasts');
      await expect(page.locator('[data-test=last-poll]')).toContainText('1 streams, 1 new, 1 predicted');
      await expect(page.locator('[data-test=registered]')).toHaveText(/^No: central unreachable/);
      await expect(page.locator('[data-test=base-error]')).toContainText('The chain did not answer');
      expect(await page.evaluate(() => fetch('/llms.txt').then(() => 'fetched', () => 'failed'))).toBe('failed'); // never cached
      expect(await page.evaluate(() => window.violations)).toEqual([]);
    } finally {
      await context.setOffline(false);
    }
  });

  test('a new version waits for "Update ready, reload", and the page never reloads on its own', async () => {
    await reloadApp(page);
    const file = new URL('../dist/sw.js', import.meta.url);
    const built = readFileSync(file, 'utf8');
    writeFileSync(file, `${built}// a new version\n`);
    try {
      await page.evaluate(() => { window.sameDocument = true; });
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
      await expect(page.locator('[data-test=update]')).toBeVisible({ timeout: LOAD_TIMEOUT });
      expect((await status(page)).app.update).toBe(true);
      await page.waitForTimeout(2000);
      expect(await page.evaluate(() => window.sameDocument)).toBe(true);

      await Promise.all([page.waitForEvent('load'), page.locator('[data-test=update]').click()]);
      expect(await loaded(page)).toBe('home');
      expect(await page.evaluate(() => window.sameDocument)).toBeUndefined();
      expect(await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !r.waiting && !!r.active))).toBe(true);
      await expect(page.locator('[data-test=update]')).toBeHidden();
      expect(await controlled(page)).toBe(true);
    } finally {
      writeFileSync(file, built);
    }
  });
});

test('an app window (the window an installed app opens in) and a tab: one neuron', async () => {
  const { context } = await launch([`--app=${APP}`]);
  try {
    const app = context.pages()[0];
    if (app.url() !== APP) await app.goto(APP); // the window may still be opening
    expect(await loaded(app)).toBe('setup');
    expect(await app.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
    expect((await status(app)).app).toEqual({ installed: true, canInstall: false, update: false });
    await expect(app.locator('[data-test=install]').filter({ visible: true })).toHaveCount(0);
    await app.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
    await app.evaluate(() => window.satori.go('settings'));
    await expect(app.locator('[data-test=storage]')).toBeVisible();

    const tab = await context.newPage();
    await tab.goto(APP);
    expect(await loaded(tab)).toBe('elsewhere');
    await app.close();
    await tab.reload();
    expect(await loaded(tab)).toBe('home'); // the app window gone, the tab runs it
  } finally {
    await context.close();
  }
});
