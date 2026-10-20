// The defaults a build bakes in (src/config.js; docs/design/deploy.md#build-variables).
import { expect, test } from 'vitest';
import { BUILD_DEFAULTS, DEV_DEFAULTS, defaultsFrom, versionOf } from './config.js';

const SATORIAN = { 'ws://satorian.satorinet.io:7777': 'wss://relay.satorinet.io' }; // central's relay → its TLS front

test("the neuron's version: browser-<package version>+<git short sha>, as register sends it and Settings shows it", () => {
  expect(versionOf('0.1.0', '3f11d8c')).toBe('browser-0.1.0+3f11d8c');
  expect(versionOf('0.1.0', '')).toBe('browser-0.1.0'); // no git (a source tarball)
});

test("unset, a build keeps today's defaults: prod central, no user relay, central's relays written to, central's RPC, satorian's stand-in", () => {
  expect(defaultsFrom({ DEV: false, PROD: true, MODE: 'production' }, BUILD_DEFAULTS)).toEqual({
    central: 'https://network.satorinet.io', relays: [], centralWrite: true, rpc: undefined, wss: SATORIAN,
  });
});

test("unset, the dev server keeps its own: the dev central, the test relay, central's relays read only, the local fork; the same stand-in", () => {
  expect(defaultsFrom({ DEV: true }, DEV_DEFAULTS)).toEqual({
    central: 'https://central2.satorinet.io', relays: ['ws://localhost:7778'], centralWrite: false, rpc: '/rpc', wss: SATORIAN,
  });
});

test('empty is unset', () => {
  const empty = { VITE_CENTRAL_URL: '', VITE_NOSTR_RELAYS: ' ', VITE_NOSTR_CENTRAL_WRITE: '', VITE_BASE_RPC: '', VITE_NOSTR_WSS: ' ' };
  expect(defaultsFrom(empty, BUILD_DEFAULTS)).toEqual(defaultsFrom({}, BUILD_DEFAULTS));
  expect(defaultsFrom(empty, DEV_DEFAULTS)).toEqual(defaultsFrom({}, DEV_DEFAULTS));
});

test('set, each one replaces its default, in a build and on the dev server', () => {
  const env = {
    VITE_CENTRAL_URL: 'https://central2.satorinet.io/',
    VITE_NOSTR_RELAYS: ' wss://app.satorinet.io/relay, ,wss://relay.example.com ,wss://app.satorinet.io/relay',
    VITE_NOSTR_CENTRAL_WRITE: 'false',
    VITE_BASE_RPC: 'https://rpc.example.com',
    VITE_NOSTR_WSS: ' ws://a.example.com:7777=wss://a.example.com , ,ws://b.example.com/x?k=v=wss://tls.example.com/b?k=v',
  };
  const want = {
    central: 'https://central2.satorinet.io', // no trailing slash, as Settings saves it
    relays: ['wss://app.satorinet.io/relay', 'wss://relay.example.com'],
    centralWrite: false,
    rpc: 'https://rpc.example.com',
    // replaces the default map (satorian is not in it); a pair splits at the = before the wss:// address
    wss: { 'ws://a.example.com:7777': 'wss://a.example.com', 'ws://b.example.com/x?k=v': 'wss://tls.example.com/b?k=v' },
  };
  expect(defaultsFrom(env, BUILD_DEFAULTS)).toEqual(want);
  expect(defaultsFrom({ ...env, VITE_NOSTR_CENTRAL_WRITE: 'true' }, DEV_DEFAULTS)).toEqual({ ...want, centralWrite: true });
  expect(defaultsFrom({ VITE_BASE_RPC: '/rpc2' }, DEV_DEFAULTS).rpc).toBe('/rpc2');
  // this deployment's two (deploy/build.env): the rest stay a build's
  expect(defaultsFrom({ VITE_CENTRAL_URL: 'https://central2.satorinet.io', VITE_NOSTR_RELAYS: 'wss://app.satorinet.io/relay' },
    BUILD_DEFAULTS)).toEqual({ central: 'https://central2.satorinet.io', relays: ['wss://app.satorinet.io/relay'], centralWrite: true, rpc: undefined,
    wss: SATORIAN });
});

test('a bad value is refused, so `vite build` stops (vite.config.js) instead of baking it in', () => {
  const bad = (env) => () => defaultsFrom(env, BUILD_DEFAULTS);
  expect(bad({ VITE_CENTRAL_URL: 'http://central2.satorinet.io' })).toThrow(/VITE_CENTRAL_URL.*https/);
  expect(bad({ VITE_NOSTR_RELAYS: 'wss://ok.example.com,https://app.satorinet.io/relay' }))
    .toThrow(/VITE_NOSTR_RELAYS.*https:\/\/app\.satorinet\.io\/relay/);
  expect(bad({ VITE_NOSTR_CENTRAL_WRITE: 'yes' })).toThrow(/VITE_NOSTR_CENTRAL_WRITE/);
  expect(bad({ VITE_BASE_RPC: 'http://rpc.example.com' })).toThrow(/VITE_BASE_RPC/);
  // a stand-in pair: ws:// on the left, wss:// on the right, each ws:// once
  expect(bad({ VITE_NOSTR_WSS: 'wss://a.example.com=wss://b.example.com' })).toThrow(/VITE_NOSTR_WSS.*left.*ws:\/\/.*wss:\/\/a\.example\.com/);
  expect(bad({ VITE_NOSTR_WSS: 'ws://a.example.com=ws://b.example.com' })).toThrow(/VITE_NOSTR_WSS.*right.*wss:\/\/.*ws:\/\/b\.example\.com/);
  expect(bad({ VITE_NOSTR_WSS: 'ws://a.example.com=https://b.example.com' })).toThrow(/VITE_NOSTR_WSS.*right.*wss:\/\//);
  expect(bad({ VITE_NOSTR_WSS: 'ws://a.example.com' })).toThrow(/VITE_NOSTR_WSS.*ws:\/\/…=wss:\/\/….*ws:\/\/a\.example\.com/);
  expect(bad({ VITE_NOSTR_WSS: 'ws://=wss://b.example.com' })).toThrow(/VITE_NOSTR_WSS.*left/);
  expect(bad({ VITE_NOSTR_WSS: 'ws://a.example.com=wss://' })).toThrow(/VITE_NOSTR_WSS.*right/);
  expect(bad({ VITE_NOSTR_WSS: 'ws://a.example.com=wss://b.example.com,ws://a.example.com=wss://c.example.com' }))
    .toThrow(/VITE_NOSTR_WSS.*ws:\/\/a\.example\.com.*twice/);
});

test('the defaults are not shared: a caller changing its list or map leaves the table alone', () => {
  defaultsFrom({}, DEV_DEFAULTS).relays.push('wss://x.example.com');
  expect(DEV_DEFAULTS.relays).toEqual(['ws://localhost:7778']);
  defaultsFrom({}, BUILD_DEFAULTS).wss['ws://x.example.com'] = 'wss://x.example.com';
  expect(BUILD_DEFAULTS.wss).toEqual(SATORIAN);
  expect(DEV_DEFAULTS.wss).toEqual(SATORIAN);
});
