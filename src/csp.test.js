// The page's CSP (csp.js), sent by the dev and preview servers.
import { expect, test } from 'vitest';
import { CSP } from '../csp.js';

test("connect-src: the app, any https central, wss relays, and ws relays for the dev page (docs/design/nostr.md)", () => {
  const src = Object.fromEntries(CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  expect(src['connect-src']).toEqual(["'self'", 'https:', 'wss:', 'ws:']);
  expect(src['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  expect(src['default-src']).toEqual(["'self'"]);
});
