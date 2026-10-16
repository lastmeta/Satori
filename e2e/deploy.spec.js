// The deploy image (deploy/; docs/design/deploy.md) at DEPLOY_URL, default
// http://localhost:8090 (`docker run --rm -p 8090:80 satori-neuron`): start it,
// then `npm run e2e:deploy` (playwright.deploy.config.js); after a deploy,
// DEPLOY_URL=https://neuron.satorinet.io. Its headers on every kind of
// response; then the app in a Chrome profile of its own, as a person's
// browser: under the CSP with no violation, DuckDB, the service worker, the
// manifest, and this deployment's defaults (deploy/build.env). Every host but
// the app's is unresolvable, central is the stub and the build's relays are
// routed to nothing, so the neuron it creates talks to nothing real.
import { expect, test, chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loaded } from './load.js';
import { stubCentral } from './stub.js';
import { CSP } from '../csp.js';
import { BUILD_DEFAULTS, defaultsFrom } from '../src/config.js';

const APP = `${(process.env.DEPLOY_URL ?? 'http://localhost:8090').replace(/\/+$/, '')}/`;
// deploy/build.env, a variable set in the environment winning, as scripts/deploy-image.sh reads it
const ENV = Object.fromEntries(readFileSync(new URL('../deploy/build.env', import.meta.url), 'utf8').split('\n')
  .map((line) => /^(VITE_\w+)=(.*)$/.exec(line)).filter(Boolean).map(([, k, v]) => [k, process.env[k] ?? v]));
const WANT = defaultsFrom(ENV, BUILD_DEFAULTS);
const IMMUTABLE = 'public, max-age=31536000, immutable';
const T0 = Math.floor(Date.now() / 1000) - 3600;
const BATCH = [{
  id: 1, observed_at: `${T0}.5`, value: '67000.5', hash: '', stream_id: 1, stream_uuid: 'u-btc', ts: new Date(T0 * 1000).toISOString().slice(0, -1),
  stream: { id: 1, uuid: 'u-btc', name: 'bitcoin', author: null, secondary: null, target: null, meta: null, description: null },
}];

test('every response has the CSP from csp.js and nosniff; hashed assets are immutable, the rest revalidated; types; SPA', async ({ request }) => {
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
    expect([path, r.status(), h['content-security-policy'], h['x-content-type-options'], h['cache-control']])
      .toEqual([path, status, CSP, 'nosniff', cache]);
    expect(h['content-type'], path).toMatch(type);
  }
  expect(await (await request.get(`${APP}some/path/the/app/has/not`)).text()).toBe(index);
  const text = await request.get(`${APP}llms.txt`);
  expect(await text.text()).toMatch(/^# Satori neuron/);

  // gzipped beside itself: DuckDB's wasm goes compressed, as the same file
  const gz = await request.fetch(APP + wasm, { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  expect(gz.headers()).toMatchObject({ 'content-encoding': 'gzip', vary: 'Accept-Encoding', 'content-type': 'application/wasm' });
  expect(Number(gz.headers()['content-length'])).toBeLessThan(10e6);
});

test("the app in a browser profile: the CSP, DuckDB, the service worker, the manifest, and this deployment's central and relays", async () => {
  const context = await chromium.launchPersistentContext(test.info().outputPath('profile'), {
    channel: 'chrome', headless: true,
    args: [`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE ${new URL(APP).hostname}`,
      '--bypass-app-banner-engagement-checks'],
  });
  try {
    const stub = await stubCentral(context, { url: WANT.central });
    const opened = [];
    await context.routeWebSocket((u) => WANT.relays.includes(u.href), (ws) => {
      opened.push(ws.url());
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
    expect(JSON.parse(m.data)).toMatchObject({ name: 'Satori neuron', start_url: '/', display: 'standalone' });
    await expect.poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);

    // a neuron, on this deployment's defaults: it registers with its central and opens its relays
    await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
    await expect(page.locator('body')).toHaveAttribute('data-screen', 'home');
    await expect.poll(() => stub.registered.length).toBe(1);
    const s = await page.evaluate(() => window.satori.status());
    expect(s.central.url).toBe(WANT.central);
    expect([s.nostr.userRelays, s.nostr.centralWrite]).toEqual([WANT.relays, WANT.centralWrite]);
    await expect.poll(() => [...new Set(opened)].sort()).toEqual([...WANT.relays].sort());

    // DuckDB writes: a poll stores central's stream and forecasts it
    stub.batch = BATCH;
    expect((await page.evaluate(() => window.satori.poll())).poll).toMatchObject({ streams: 1, new: 1, predicted: 1 });

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
