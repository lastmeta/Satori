// Base config (docs/design/base.md#config): the bundled D6 addresses. Central's
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

export const DEFAULTS = Object.freeze({
  chainId: CHAIN_ID,
  rpcUrl: 'https://sepolia.base.org',
  explorerUrl: 'https://sepolia.basescan.org',
  token: '0x4dee947383d5C9c8E421F55Fe3518a29324aE469',
  merkle: '0x78C83AE275e9659Bc8490fa33943e22ec7c5A7e7',
  airdrop: '0xF15CEAec0e29A0B6551180F8617850bc5356938C',
  rewards: '0xde5d2B4b92c1231EC19cd3877D7C3eb6b44982Ac',
  engine: '0xE8fA688ea29850305216121C0bddfFb9096A1093',
  games: '0xB06e419D24cCbA967c6193e9e374117171B400C3',
  registry: '0x1ED75AB0a66Ba7d23C3E5c84798e90205E76743a',
  hub: '0x1eec7E1443C1065ab78180A14326e5Ac8284f143',
  lens: '0x9BF5266F60092F1bFbd5F16d21d0bE9673c0F91F',
  voting: '0x5A56279215684A8088234799FfD56f806AcFBb6e', // SatoriEngine.satoriVoting() on D6
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
});

export const FALLBACK_RPC = 'https://base-sepolia-rpc.publicnode.com';
// Satori Daily, the dapp (contract/satori-ui), where a vault plays by hand; the neuron plays only automatically.
export const SATORI_DAILY_URL = 'https://app.satorinet.io';
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
