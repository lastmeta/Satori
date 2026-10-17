// The service worker's routing decision (docs/design/pwa.md#caching).
import { expect, test } from 'vitest';
import { route } from './sw.js';

const O = 'https://satori.example';
const get = (path, mode = 'cors') => ({ method: 'GET', url: new URL(path, O).href, mode });

test("the build's hashed files are 'asset' (cache first): the app's code, DuckDB's wasm and its worker", () => {
  expect(route(get('/assets/index-C37gqI0E.js'), O)).toBe('asset');
  expect(route(get('/assets/index-DJctAwZA.css', 'no-cors'), O)).toBe('asset');
  expect(route(get('/assets/duckdb-eh-9ubY-jlA.wasm'), O)).toBe('asset');
  expect(route(get('/assets/duckdb-browser-eh.worker-hQa-dcAV.js', 'same-origin'), O)).toBe('asset');
  expect(route(get('/theme.js', 'no-cors'), O)).toBe('asset'); // index.html's pre-paint theme script: offline too
});

test("opening the app is 'page' (network first, the cached shell offline)", () => {
  expect(route(get('/', 'navigate'), O)).toBe('page');
  expect(route(get('/index.html', 'navigate'), O)).toBe('page');
  expect(route(get('/?source=pwa', 'navigate'), O)).toBe('page');
});

test('everything else is left to the browser: other pages, /llms.txt, /rpc, the manifest, writes, other origins', () => {
  expect(route(get('/llms.txt', 'navigate'), O)).toBe(null); // offline it must not turn into the app
  expect(route(get('/llms.txt'), O)).toBe(null);
  expect(route(get('/e2e/store/', 'navigate'), O)).toBe(null);
  expect(route(get('/'), O)).toBe(null); // fetch('/'), not a navigation
  expect(route(get('/rpc'), O)).toBe(null);
  expect(route({ ...get('/rpc'), method: 'POST' }, O)).toBe(null);
  expect(route({ ...get('/assets/index-C37gqI0E.js'), method: 'HEAD' }, O)).toBe(null);
  expect(route(get('/manifest.webmanifest'), O)).toBe(null);
  expect(route(get('/sw.js'), O)).toBe(null);
  expect(route(get('/icon-192.png'), O)).toBe(null);
  // Other origins: central, the Base RPC, an explorer; and a look-alike path elsewhere.
  expect(route(get('https://network.satorinet.io/api/v1/observations/batch?limit=100'), O)).toBe(null);
  expect(route(get('https://sepolia.base.org/'), O)).toBe(null);
  expect(route(get('https://cdn.example/assets/index-C37gqI0E.js'), O)).toBe(null);
  expect(route(get('https://satori.example:8443/', 'navigate'), O)).toBe(null);
});
