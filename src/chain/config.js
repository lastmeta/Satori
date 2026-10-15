// Base config: bundled DEFAULTS overlaid with central's /api/v1/base/config,
// cached 1 h (neuron/neuron-lite/satorineuron/base_config.py:20-36,66-88).
// DEFAULTS mirror contract/satori/deployments/baseSepolia.json.

export const DEFAULTS = Object.freeze({
  chainId: 84532,
  rpcUrl: 'https://sepolia.base.org',
  token: '0x4dee947383d5C9c8E421F55Fe3518a29324aE469',
  merkle: '0x78C83AE275e9659Bc8490fa33943e22ec7c5A7e7',
  airdrop: '0xF15CEAec0e29A0B6551180F8617850bc5356938C',
  rewards: '0xde5d2B4b92c1231EC19cd3877D7C3eb6b44982Ac',
  engine: '0xE8fA688ea29850305216121C0bddfFb9096A1093',
  games: '0xB06e419D24cCbA967c6193e9e374117171B400C3',
  registry: '0x1ED75AB0a66Ba7d23C3E5c84798e90205E76743a',
  hub: '0x1eec7E1443C1065ab78180A14326e5Ac8284f143',
  streamProvider: 'cb45de2a76a5df79ea8aff0c867e96e527f803eb389420419e441a4946129838',
});

const TTL_MS = 3600_000;

/**
 * @param {{fetchCentral?: () => Promise<object|null>, cached?: {remote: object|null, fetchedAt: number},
 *          rpcUrl?: string, now?: number}} opts  fetchCentral = central.baseConfig
 * @returns {Promise<{config: typeof DEFAULTS, cache: {remote: object|null, fetchedAt: number}}>}
 *   Persist `cache` (settings.base_config_cache) and pass it back next time.
 */
export async function loadConfig({ fetchCentral, cached, rpcUrl, now = Date.now() }) {
  let cache = cached && now - cached.fetchedAt < TTL_MS ? cached : null;
  if (!cache) {
    let remote = null;
    try { remote = (await fetchCentral?.()) ?? null; } catch { /* central down: defaults */ }
    cache = { remote, fetchedAt: now };
  }
  const remote = cache.remote && (cache.remote.chainId ?? DEFAULTS.chainId) === DEFAULTS.chainId ? cache.remote : {};
  const config = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (remote[k]) config[k] = remote[k];
  if (rpcUrl) config.rpcUrl = rpcUrl;
  return { config, cache };
}
