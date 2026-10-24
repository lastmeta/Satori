// The page's CSP (csp.js): a build's (CSP, sent by the deploy image and `vite preview`) and the dev server's (DEV_CSP).
import { expect, test } from 'vitest';
import { CSP, DEV_CSP } from '../csp.js';

const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

test("connect-src: the app, any https central, wss relays; ws:// only on the dev server's page (docs/design/nostr.md)", () => {
  const src = directives(CSP);
  expect(src['connect-src']).toEqual(["'self'", 'https:', 'wss:']); // a build: no ws: (it would reach ws://localhost services)
  expect(directives(DEV_CSP)['connect-src']).toEqual(["'self'", 'https:', 'wss:', 'ws:']); // the dev page's ws://localhost:7778 test relay
  expect(src['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  expect(src['default-src']).toEqual(["'self'"]);
});

test('form-action none: no form is ever submitted natively, so a passphrase can never land in a URL', () => {
  expect(directives(CSP)['form-action']).toEqual(["'none'"]);
  expect(directives(DEV_CSP)['form-action']).toEqual(["'none'"]);
});

test('the dev CSP is the build CSP with ws: added, nothing else', () => {
  const [a, b] = [directives(CSP), directives(DEV_CSP)];
  expect({ ...b, 'connect-src': a['connect-src'] }).toEqual(a);
});

test('the installed app (docs/design/pwa.md): the service worker, the manifest and its icons are allowed from the app only', () => {
  const src = directives(CSP);
  expect(src['worker-src']).toEqual(["'self'"]); // /sw.js and DuckDB's worker
  expect(src['manifest-src']).toBeUndefined(); // default-src 'self'
  expect(src['img-src']).toEqual(["'self'", 'data:', 'blob:']);
});

test("the phone wallets' screens (docs/design/wallets.md#a-connected-wallet): inline styles, blob: icons, Reown's font; scripts still the app's", () => {
  const src = directives(CSP);
  expect(src['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
  expect(src['font-src']).toEqual(["'self'", 'https://fonts.reown.com']);
  expect(src['frame-src']).toEqual(['https://verify.walletconnect.org', 'https://verify.walletconnect.com']);
  expect(src['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
});
