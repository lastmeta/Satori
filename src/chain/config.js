// Base config (docs/design/base.md#config): the bundled D6 addresses, with
// central's /api/v1/base/config over them, cached 1 h, as Satori Lite's
// base_config.py:16-36,66-88. `lens` and Multicall3 come from the dapp
// (contract/satori-ui/src/contracts/addresses.ts:199-221); central's payload
// has no lens. The RPC: the user's setting, else (a build) central's rpcUrl
// then publicnode as a fallback, as the dapp lists them.

export const CHAIN_ID = 84532; // Base Sepolia

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
export const CONFIG_TTL_S = 3600;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const valid = (k, v) => (ADDRESS.test(DEFAULTS[k]) ? ADDRESS.test(v) : typeof v === 'string' && /^https:\/\//.test(v));

/**
 * The config, from a cache of the same central (`url`) younger than 1 h, or a
 * fresh fetch. `fetchCentral` returns central's JSON or throws (prod's 404,
 * central down): the defaults then. Only non-empty values for chain 84532 are
 * taken; addresses must look like addresses.
 * @returns {Promise<{config: typeof DEFAULTS, cache: {remote: object|null, at: number, url?: string}}>}
 */
export async function loadConfig({ fetchCentral, url, cache, now }) {
  if (!(cache && cache.url === url && now - cache.at < CONFIG_TTL_S)) {
    let remote = null;
    try { remote = (await fetchCentral?.()) ?? null; } catch { /* the defaults */ }
    cache = { remote, at: now, url };
  }
  const r = cache.remote && typeof cache.remote === 'object' && (cache.remote.chainId ?? CHAIN_ID) === CHAIN_ID
    ? cache.remote : {};
  const config = { ...DEFAULTS };
  for (const k of ['rpcUrl', 'explorerUrl', 'token', 'merkle', 'airdrop', 'rewards', 'engine', 'games', 'registry', 'hub']) {
    if (r[k] && valid(k, r[k])) config[k] = r[k];
  }
  return { config: Object.freeze(config), cache };
}

/** The RPC setting as typed: '' (the default), an https:// URL, or a same-origin path such as /rpc. */
export function checkRpcSetting(raw) {
  const url = String(raw ?? '').trim();
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  let ok = false;
  try { ok = new URL(url).protocol === 'https:'; } catch { /* not a URL */ }
  if (!ok) throw new Error('The Base RPC must be an https:// URL or a path on this site (such as /rpc).');
  return url;
}

/** The RPC URLs to use, in failover order: the setting alone; else the default (dev: the local fork). */
export function rpcUrls({ config, setting, devDefault }) {
  if (setting) return [setting];
  if (devDefault) return [devDefault];
  return [...new Set([config.rpcUrl, FALLBACK_RPC])];
}
