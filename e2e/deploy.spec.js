// The deploy image (deploy/; docs/design/deploy.md) at DEPLOY_URL, default
// http://localhost:8090 (`docker run --rm -p 8090:80 satori-neuron`): start it,
// then `npm run e2e:deploy` (playwright.deploy.config.js); after a deploy,
// DEPLOY_URL=https://app.satorinet.io. Its headers on every kind of
// response; then the app in a Chrome profile of its own, as a person's
// browser: under the CSP with no violation, DuckDB, the service worker, the
// manifest, and this deployment's defaults (deploy/build.env). Every host but
// the app's is unresolvable, central is the stub (listing satorian, as central
// does) and the build's relays and satorian's wss stand-in are routed to
// nothing, so the neuron it creates talks to nothing real.
import { expect, test, chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loaded, polled } from './load.js';
import { stubCentral } from './stub.js';
import { CSP } from '../csp.js';
import { BUILD_DEFAULTS, defaultsFrom } from '../src/config.js';
import { FALLBACK_RPC } from '../src/chain/config.js';

const APP = `${(process.env.DEPLOY_URL ?? 'http://localhost:8090').replace(/\/+$/, '')}/`;
// deploy/build.env, a variable set in the environment winning (one not in the file too), as scripts/deploy-image.sh reads it
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_'))),
  ...Object.fromEntries(readFileSync(new URL('../deploy/build.env', import.meta.url), 'utf8').split('\n')
    .map((line) => /^(VITE_\w+)=(.*)$/.exec(line)).filter(Boolean).map(([, k, v]) => [k, process.env[k] ?? v])) };
const WANT = defaultsFrom(ENV, BUILD_DEFAULTS);
const SATORIAN = 'ws://satorian.satorinet.io:7777'; // what central lists; a build can't open ws://
const STAND_IN = WANT.wss[SATORIAN]; // the build's wss stand-in for it (src/config.js), or none: then it is blocked
const href = (u) => new URL(u).href;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const HSTS = 'max-age=63072000; includeSubDomains'; // two years, no preload (docs/design/deploy.md#what-it-sends)
const T0 = Math.floor(Date.now() / 1000) - 3600;
const BATCH = [{
  id: 1, observed_at: `${T0}.5`, value: '67000.5', hash: '', stream_id: 1, stream_uuid: 'u-btc', ts: new Date(T0 * 1000).toISOString().slice(0, -1),
  stream: { id: 1, uuid: 'u-btc', name: 'bitcoin', author: null, secondary: null, target: null, meta: null, description: null },
}];

test('every response has the CSP from csp.js, nosniff and HSTS; hashed assets are immutable, the rest revalidated; types; SPA', async ({ request }) => {
  const index = await (await request.get(APP)).text();
  const sw = await (await request.get(`${APP}sw.js`)).text();
  const files = JSON.parse(/start\(self, (\[.*?\]),/.exec(sw)[1]); // the worker's precache list: the build's hashed files
  const js = /src="\/(assets\/index-[^"]+\.js)"/.exec(index)[1];
  const worker = files.find((f) => /^\/assets\/duckdb-browser-eh\.worker-.*\.js$/.test(f)).slice(1);
  const wasm = files.find((f) => /^\/assets\/duckdb-eh-.*\.wasm$/.test(f)).slice(1);
  const cases = [
    ['', 200, /^text\/html; charset=utf-8$/, 'no-cache'],
    ['index.html', 200, /^text\/html; charset=utf-8$/, 'no-cache'],
    ['sw.js', 200, /^application\/javascript/, 'no-cache'],
    ['manifest.webmanifest', 200, /^application\/manifest\+json$/, 'no-cache'],
    ['llms.txt', 200, /^text\/plain; charset=utf-8$/, 'no-cache'],
    ['llms-changelog.txt', 200, /^text\/plain; charset=utf-8$/, 'no-cache'],
    ['icon-192.png', 200, /^image\/png$/, 'no-cache'],
    [js, 200, /^application\/javascript/, IMMUTABLE],
    [worker, 200, /^application\/javascript/, IMMUTABLE],
    [wasm, 200, /^application\/wasm$/, IMMUTABLE],
    ['some/path/the/app/has/not', 200, /^text\/html; charset=utf-8$/, 'no-cache'], // the page (SPA)
    ['assets/gone-00000000.js', 404, /^text\/html/, undefined], // not the page, and not kept
  ];
  for (const [path, status, type, cache] of cases) {
    const r = await request.fetch(APP + path, { method: 'HEAD', failOnStatusCode: false });
    const h = r.headers();
    expect([path, r.status(), h['content-security-policy'], h['x-content-type-options'], h['strict-transport-security'], h['cache-control']])
      .toEqual([path, status, CSP, 'nosniff', HSTS, cache]);
    expect(h['content-type'], path).toMatch(type);
  }
  expect(await (await request.get(`${APP}some/path/the/app/has/not`)).text()).toBe(index);
  const text = await request.get(`${APP}llms.txt`);
  expect(await text.text()).toMatch(/^# Satori neuron[\s\S]*\n## Safety\n/);
  expect(await (await request.get(`${APP}llms-changelog.txt`)).text()).toMatch(/^# Satori neuron \(browser app\): what changed/);

  // compressed beside itself: DuckDB's wasm goes in brotli where the browser takes it (5.1 MB), else gzipped (7.7 MB),
  // else as it is, the same file each time, with the CSP and the cache rule (docs/design/deploy.md#compression)
  const encoded = async (accept) => {
    const r = await request.get(APP + wasm, { headers: { 'accept-encoding': accept } });
    return { h: r.headers(), length: (await r.body()).length };
  };
  const br = await encoded('gzip, deflate, br, zstd');
  expect(br.h).toMatchObject({ 'content-encoding': 'br', vary: 'Accept-Encoding', 'content-type': 'application/wasm',
    'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'strict-transport-security': HSTS, 'cache-control': IMMUTABLE });
  const gz = await encoded('gzip, deflate');
  expect(gz.h).toMatchObject({ 'content-encoding': 'gzip', vary: 'Accept-Encoding', 'content-type': 'application/wasm',
    'content-security-policy': CSP, 'strict-transport-security': HSTS, 'cache-control': IMMUTABLE });
  const plain = await encoded('alias');
  expect(plain.h['content-encoding']).toBeUndefined();
  expect(plain.h['content-type']).toBe('application/wasm');
  // Playwright decodes bodies: each is the same wasm; the wire sizes are the content-length
  expect([br.length, gz.length]).toEqual([plain.length, plain.length]);
  const [brBytes, gzBytes] = [Number(br.h['content-length']), Number(gz.h['content-length'])];
  expect(brBytes).toBeLessThan(gzBytes * 0.7); // about a third smaller than gzip
  expect(gzBytes).toBeLessThan(10e6);
  // a wasm with no brotli copy (DuckDB's mvp, for browsers without wasm exceptions) is gzip's, never marked br
  const mvp = /assets\/duckdb-mvp-[\w-]+\.wasm/.exec(await (await request.get(APP + js)).text())?.[0];
  expect(mvp).toBeTruthy();
  const m = await request.fetch(APP + mvp, { method: 'HEAD', headers: { 'accept-encoding': 'gzip, br' } });
  expect(m.headers()).toMatchObject({ 'content-encoding': 'gzip', 'content-type': 'application/wasm' });
});

test("the app in a browser profile: the CSP, DuckDB, the service worker, the manifest, and this deployment's central and relays", async () => {
  const context = await chromium.launchPersistentContext(test.info().outputPath('profile'), {
    channel: 'chrome', headless: true,
    args: [`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE ${new URL(APP).hostname}`,
      '--bypass-app-banner-engagement-checks'],
  });
  try {
    const stub = await stubCentral(context, { url: WANT.central, relays: [SATORIAN] });
    const opened = [];
    const reachable = [...WANT.relays, ...(STAND_IN ? [STAND_IN] : [])].map(href);
    await context.routeWebSocket((u) => reachable.includes(u.href), (ws) => { // after the stub's: wins for the stand-in
      opened.push(href(ws.url()));
      ws.close();
    });
    await context.addInitScript(() => {
      window.violations = [];
      document.addEventListener('securitypolicyviolation', (e) => window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const page = context.pages()[0];
    const res = await page.goto(APP);
    expect(res.headers()['content-security-policy']).toBe(CSP);
    expect(await loaded(page)).toBe('setup'); // DuckDB-WASM started and opened its OPFS file

    // the service worker and the manifest
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cdp = await context.newCDPSession(page);
    const m = await cdp.send('Page.getAppManifest');
    expect([m.url, m.errors]).toEqual([`${APP}manifest.webmanifest`, []]);
    expect(JSON.parse(m.data)).toMatchObject({ name: 'Satori app', start_url: '/', display: 'standalone' });
    await expect.poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);

    // a neuron, on this deployment's defaults: it registers with its central and opens its relays
    stub.batch = BATCH;
    await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
    await expect(page.locator('body')).toHaveAttribute('data-screen', 'home');
    await expect.poll(() => stub.registered.length).toBe(1);
    const s = await page.evaluate(() => window.satori.status());
    expect(s.central.url).toBe(WANT.central);
    expect([s.nostr.userRelays, s.nostr.centralWrite]).toEqual([WANT.relays, WANT.centralWrite]);
    // the Base RPC the build pins (VITE_BASE_RPC), publicnode after it; never central's (docs/design/base.md#config)
    expect(s.base.rpc).toEqual(WANT.rpc ? [WANT.rpc, FALLBACK_RPC] : expect.any(Array));
    expect(s.version).toMatch(/^browser-\d+\.\d+\.\d+\+[0-9a-f]{7,}$/); // the build's version, stamped with its commit
    expect(stub.registered[0]['neuron-version']).toBe(s.version);
    await expect.poll(() => [...new Set(opened)].sort()).toEqual([...reachable].sort());
    // central's ws:// relay: reached at its wss stand-in, as central's relay (written to as the build says), never tried itself
    const central = (await page.evaluate(() => window.satori.nostr())).relays.filter((r) => r.from.includes('central'));
    expect(central).toEqual([expect.objectContaining(STAND_IN ? { url: STAND_IN, for: SATORIAN, write: WANT.centralWrite }
      : { url: SATORIAN, state: 'blocked' })]);
    expect(stub.blocked).toEqual([]);

    // DuckDB writes: the first poll, at once after register, stores central's stream and forecasts it
    expect((await polled(page)).lastPoll).toMatchObject({ streams: 1, new: 1, predicted: 1 });

    // the worker now serves the page
    const again = await page.reload();
    expect(again.fromServiceWorker()).toBe(true);
    expect(await loaded(page)).toBe('home');
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('home.png') });
    expect(await page.evaluate(() => window.violations)).toEqual([]);
  } finally {
    await context.close();
  }
});
