// The defaults a user can change under Settings, as baked in when the app is
// built (docs/design/deploy.md#build-variables). Each VITE_* variable, set
// and not empty, replaces its default; unset, the dev server keeps its own (the
// dev central, the test relay, central's relays read only, the local fork) and a
// build its own (prod central, no user relay, central's relays written to,
// central's RPC). main.js reads them from import.meta.env; vite.config.js
// checks them before a build, so a bad value stops the build.
import { isHttps, isRelayUrl } from './util.js';
import { checkRpcSetting } from './chain/config.js';

// The dev server talks to the dev central and the test relay (scripts/test-relay.mjs),
// reads central's relays (satorian, production) without writing to them, and sends
// Base transactions to /rpc, which Vite proxies to a local fork on 127.0.0.1:8545
// (scripts/fork.mjs): by default a dev checkout writes nothing to production.
// (Plain objects: a build drops the one it does not use, which it can't do with Object.freeze's call.)
export const DEV_DEFAULTS = {
  central: 'https://central2.satorinet.io', relays: ['ws://localhost:7778'], centralWrite: false, rpc: '/rpc',
};
// A build: prod central (satorilib's default); its relays, written to; its Base RPC, then publicnode.
export const BUILD_DEFAULTS = {
  central: 'https://network.satorinet.io', relays: [], centralWrite: true, rpc: undefined,
};

const value = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The neuron's version: `browser-<package version>+<git short sha>` (vite.config.js stamps it at build and when the dev
 * server starts), as register's neuron-version, Settings › This device and status().version say it.
 */
export const versionOf = (version, sha) => `browser-${version}${sha ? `+${sha}` : ''}`;

/**
 * `base` with each VITE_* variable of `env` that is set over it. The caller picks
 * `base` with import.meta.env.DEV, which a build replaces by `false`, so the dev
 * server's defaults are not in a build's bundle.
 * @param {Record<string, any>} env import.meta.env, or loadEnv's VITE_* variables
 * @param {typeof BUILD_DEFAULTS} base DEV_DEFAULTS or BUILD_DEFAULTS
 * @returns {{central: string, relays: string[], centralWrite: boolean, rpc: string|undefined}}
 */
export function defaultsFrom(env, base) {
  const central = value(env.VITE_CENTRAL_URL)?.replace(/\/+$/, '') ?? base.central;
  if (!isHttps(central)) throw new Error(`VITE_CENTRAL_URL must be an https:// URL: ${central}`);

  const list = value(env.VITE_NOSTR_RELAYS);
  const relays = list ? [...new Set(list.split(',').map((u) => u.trim()).filter(Boolean))] : [...base.relays];
  const bad = relays.find((u) => !isRelayUrl(u));
  if (bad) throw new Error(`VITE_NOSTR_RELAYS: a relay is a ws:// or wss:// address: ${bad}`);

  const write = value(env.VITE_NOSTR_CENTRAL_WRITE);
  if (write && !['true', 'false'].includes(write)) throw new Error(`VITE_NOSTR_CENTRAL_WRITE must be true or false: ${write}`);
  const centralWrite = write ? write === 'true' : base.centralWrite;

  let rpc = base.rpc;
  if (value(env.VITE_BASE_RPC)) {
    try { rpc = checkRpcSetting(env.VITE_BASE_RPC); } catch (err) { throw new Error(`VITE_BASE_RPC: ${err.message}`); }
  }
  return { central, relays, centralWrite, rpc };
}
