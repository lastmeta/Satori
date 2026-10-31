// Base config (docs/design/base.md#config): the bundled addresses (D8 on Base Sepolia, 2026-10-26; mainnet.js). Central's
// /api/v1/base/config is read, cached 1 h, as Satori Lite's base_config.py:16-36,66-88,
// but its contract addresses are taken only when they equal the bundled ones (one
// that differs is said, and the bundle's kept: a central must not move the app's
// funds to other contracts), and its rpcUrl and explorerUrl only when the build pins
// no RPC. `lens` and Multicall3 come from the dapp (contract/satori-ui/src/contracts/addresses.ts:199-221);
// central's payload has no lens. The RPC: the user's setting; else the build's (VITE_BASE_RPC,
// then publicnode) or the dev server's local fork; else central's rpcUrl, then publicnode,
// as the dapp lists them.
import { isHttps } from '../util.js';
import { MAINNET } from './mainnet.js';

/**
 * PaymentChannels (contract/satori/contracts/channels/PaymentChannels.sol; docs/design/market.md), deployed by CREATE2:
 * the same address on every chain (contract/satori/deployments/payment-channels.json). Not central's to say.
 */
export const PAYMENT_CHANNELS = '0xa6DCa52936EAb8DD1EC9f8AD98e75D1Afb0DC16c';

const TESTNET = {
  chainId: 84532,
  chainName: 'Base Sepolia',
  rpcUrl: 'https://sepolia.base.org',
  explorerUrl: 'https://sepolia.basescan.org',
  fallbackRpc: 'https://base-sepolia-rpc.publicnode.com',
  dailyUrl: 'https://test-games.satorinet.io',
  safeService: 'https://api.safe.global/tx-service/basesep',
  token: '0xe6A4b12Eae75795E4D427706dc67c1392f75D54A',
  merkle: '0xeCc7f1d5Df7aCBD7D1b0615490A88d14CA2B1F1c',
  airdrop: '0x5BF17B223D623CdbD37E3497b95c911e954a3E65',
  rewards: '0x618138368f9Fc69585907d576DEA5C89F1C798D1',
  engine: '0x438Ca7a87b4D384b57f27c0829C06Ef1F1f90A60',
  games: '0x4AD128bF49841d8e970dC36E1D1e43b36a79B612',
  registry: '0xcE4278b73dFE00772B485697FD1E97Bb0669c87f',
  hub: '0x97D53d240e3dcfC6569d7B4001b03062681f4818',
  lens: '0x5404db175634ef5e83B23B6f9BD1836b040A47Dd',
  voting: '0xb2679d77D96be59E2FA3F1e8BB575f669d5150DE', // SatoriEngine.satoriVoting() on D8
};

// One chain per build: VITE_CHAIN_ID=8453 is Base mainnet (deploy/build.env), else Base Sepolia.
export const DEFAULTS = Object.freeze({
  ...(Number(import.meta.env?.VITE_CHAIN_ID) === MAINNET.chainId ? MAINNET : TESTNET),
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  channels: PAYMENT_CHANNELS,
});
const CHAIN_ID = DEFAULTS.chainId;

export const FALLBACK_RPC = DEFAULTS.fallbackRpc;
// Satori Daily, the dapp (contract/satori-ui), where a wallet plays by hand; the neuron plays only automatically.
export const SATORI_DAILY_URL = DEFAULTS.dailyUrl;
const CONFIG_TTL_S = 3600;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CONTRACTS = ['token', 'merkle', 'airdrop', 'rewards', 'engine', 'games', 'registry', 'hub'];
const https = (v) => typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v);

/**
 * The config, from a cache of the same central (`url`) younger than 1 h, or a fresh fetch (`fresh`). `fetchCentral`
 * returns central's JSON or throws (prod's 404, central down): the bundle then. Only a config for this build's chain is read.
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
