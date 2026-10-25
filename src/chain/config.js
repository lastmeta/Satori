// Base config (docs/design/base.md#config): the bundled D7 addresses (Base Sepolia, 2026-10-23). Central's
// /api/v1/base/config is read, cached 1 h, as Satori Lite's base_config.py:16-36,66-88,
// but its contract addresses are taken only when they equal the bundled ones (one
// that differs is said, and the bundle's kept: a central must not move the app's
// funds to other contracts), and its rpcUrl and explorerUrl only when the build pins
// no RPC. `lens` and Multicall3 come from the dapp (contract/satori-ui/src/contracts/addresses.ts:199-221);
// central's payload has no lens. The RPC: the user's setting; else the build's (VITE_BASE_RPC,
// then publicnode) or the dev server's local fork; else central's rpcUrl, then publicnode,
// as the dapp lists them.
import { isHttps } from '../util.js';

const CHAIN_ID = 84532; // Base Sepolia
/**
 * PaymentChannels (contract/satori/contracts/channels/PaymentChannels.sol; docs/design/market.md), deployed by CREATE2:
 * the same address on every chain (contract/satori/deployments/payment-channels.json). Not central's to say.
 */
export const PAYMENT_CHANNELS = '0xa6DCa52936EAb8DD1EC9f8AD98e75D1Afb0DC16c';

export const DEFAULTS = Object.freeze({
  chainId: CHAIN_ID,
  rpcUrl: 'https://sepolia.base.org',
  explorerUrl: 'https://sepolia.basescan.org',
  token: '0x7Dd4F6EF7FE534e4962f975cffe93D19d9B891E1',
  merkle: '0x20d398d45A3cC6D6A73a2381294E801736E120aB',
  airdrop: '0xf8482f9640A7A2bb4Ab372DE677E8a82eBEC04A4',
  rewards: '0xF353eb4843E3B8822dd3fE88e638B02C456749BE',
  engine: '0x90C5Bc6f0322900ebAA12bb382Db44be7bc2e240',
  games: '0x05096F2caB4D6E806604caDc2F78A8563be74783',
  registry: '0x95989fc59B0Ed1c323Af14d9139cD05F0379F556',
  hub: '0x17719B7B1A630dECBc5B7FFDdEd14ffb24120183',
  lens: '0x877DD8bD95E1301E283CACF31F0ec60401dB746a',
  voting: '0xD6cB62d0f07EF38642f096D9B48b5421B4d3Cc44', // SatoriEngine.satoriVoting() on D7
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  channels: PAYMENT_CHANNELS,
});

export const FALLBACK_RPC = 'https://base-sepolia-rpc.publicnode.com';
// Satori Daily, the dapp (contract/satori-ui), where a wallet plays by hand; the neuron plays only automatically.
export const SATORI_DAILY_URL = 'https://games.satorinet.io';
const CONFIG_TTL_S = 3600;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CONTRACTS = ['token', 'merkle', 'airdrop', 'rewards', 'engine', 'games', 'registry', 'hub'];
const https = (v) => typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v);

/**
 * The config, from a cache of the same central (`url`) younger than 1 h, or a fresh fetch (`fresh`). `fetchCentral`
 * returns central's JSON or throws (prod's 404, central down): the bundle then. Only a config for chain 84532 is read.
 * Central's contract addresses are never used: `differs` lists the ones that are addresses and not the bundle's
 * (case aside). Its rpcUrl and explorerUrl (https only) are used unless `pinned` (the build or the dev server fixed
 * the RPC: rpcUrls).
 * @returns {Promise<{config: typeof DEFAULTS, cache: {remote: object|null, at: number, url?: string}, differs: string[], fresh: boolean}>}
 */
export async function loadConfig({ fetchCentral, url, cache, now, pinned = false }) {
  const fresh = !(cache && cache.url === url && now - cache.at < CONFIG_TTL_S);
  if (fresh) {
    let remote = null;
    try { remote = (await fetchCentral?.()) ?? null; } catch { /* the bundle */ }
    cache = { remote, at: now, url };
  }
  const r = cache.remote && typeof cache.remote === 'object' && (cache.remote.chainId ?? CHAIN_ID) === CHAIN_ID
    ? cache.remote : {};
  const config = { ...DEFAULTS };
  if (!pinned) for (const k of ['rpcUrl', 'explorerUrl']) if (https(r[k])) config[k] = r[k];
  const differs = CONTRACTS.filter((k) => ADDRESS.test(r[k] ?? '') && r[k].toLowerCase() !== DEFAULTS[k].toLowerCase());
  return { config: Object.freeze(config), cache, differs, fresh };
}

/** The RPC setting as typed: '' (the default), an https:// URL, or a same-origin path such as /rpc. */
export function checkRpcSetting(raw) {
  const url = String(raw ?? '').trim();
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (!isHttps(url)) throw new Error('The Base RPC must be an https:// URL or a path on this site (such as /rpc).');
  return url;
}

/**
 * The RPC URLs to use, in failover order: the setting alone; else the default the build or the dev server fixed
 * (`fixed`): a build's VITE_BASE_RPC, then publicnode; the dev server's local fork (a path) alone; else central's
 * rpcUrl (loadConfig), then publicnode.
 */
export function rpcUrls({ config, setting, fixed }) {
  if (setting) return [setting];
  if (fixed) return fixed.startsWith('/') ? [fixed] : [...new Set([fixed, FALLBACK_RPC])];
  return [...new Set([config.rpcUrl, FALLBACK_RPC])];
}
