import { describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULTS, FALLBACK_RPC, loadConfig, checkRpcSetting, rpcUrls } from './config.js';

// central2's answer on 2026-10-15
const CENTRAL2 = {
  chainId: 84532, chainName: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org', explorerUrl: 'https://sepolia.basescan.org',
  symbol: 'SATORI', decimals: 18, token: '0x4dee947383d5C9c8E421F55Fe3518a29324aE469',
  merkle: '0x78C83AE275e9659Bc8490fa33943e22ec7c5A7e7', rewards: '0xde5d2B4b92c1231EC19cd3877D7C3eb6b44982Ac',
  airdrop: '0xF15CEAec0e29A0B6551180F8617850bc5356938C', engine: '0xE8fA688ea29850305216121C0bddfFb9096A1093',
  games: '0xB06e419D24cCbA967c6193e9e374117171B400C3', registry: '0x1ED75AB0a66Ba7d23C3E5c84798e90205E76743a',
  hub: '0x1eec7E1443C1065ab78180A14326e5Ac8284f143',
  streamProvider: 'cb45de2a76a5df79ea8aff0c867e96e527f803eb389420419e441a4946129838',
};

describe('loadConfig', () => {
  test('the bundle mirrors contract/satori/deployments/baseSepolia.json and Lite\'s DEFAULTS', () => {
    const f = '/code/Satori/contract/satori/deployments/baseSepolia.json';
    if (existsSync(f)) {
      const { addresses, chainId } = JSON.parse(readFileSync(f, 'utf8'));
      expect(DEFAULTS.chainId).toBe(chainId);
      for (const k of ['token', 'merkle', 'airdrop', 'rewards', 'engine', 'games', 'registry', 'hub', 'lens']) {
        expect(DEFAULTS[k], k).toBe(addresses[k]);
      }
    }
    for (const k of ['token', 'merkle', 'airdrop', 'rewards', 'engine', 'games', 'registry', 'hub', 'rpcUrl']) {
      expect(DEFAULTS[k], k).toBe(CENTRAL2[k]); // = base_config.py DEFAULTS = central2
    }
  });

  test('central overlays the bundle; empty, malformed and unknown values are ignored; lens stays bundled', async () => {
    const remote = { chainId: 84532, token: '0x' + 'aa'.repeat(20), hub: '', engine: 'nope', rpcUrl: 'https://rpc.example',
      lens: '0x' + 'bb'.repeat(20), evil: 'x' };
    const { config, cache } = await loadConfig({ fetchCentral: async () => remote, now: 1000 });
    expect(config).toEqual({ ...DEFAULTS, token: remote.token, rpcUrl: 'https://rpc.example' });
    expect(cache).toEqual({ remote, at: 1000 });
  });

  test('cached for an hour, as Lite (base_config.py:16,72-73); then fetched again', async () => {
    const fetchCentral = vi.fn(async () => CENTRAL2);
    const { cache } = await loadConfig({ fetchCentral, now: 1000 });
    await loadConfig({ fetchCentral, cache, now: 1000 + 3599 });
    expect(fetchCentral).toHaveBeenCalledTimes(1);
    await loadConfig({ fetchCentral, cache, now: 1000 + 3600 });
    expect(fetchCentral).toHaveBeenCalledTimes(2);
  });

  test('prod\'s 404 or central down → the bundle', async () => {
    const { config } = await loadConfig({ fetchCentral: async () => { throw new Error('central 404: Not Found'); }, now: 1 });
    expect(config).toEqual(DEFAULTS);
  });

  test('a config for another chain is refused', async () => {
    const { config } = await loadConfig({ fetchCentral: async () => ({ ...CENTRAL2, chainId: 8453, token: '0x' + 'cc'.repeat(20) }), now: 1 });
    expect(config).toEqual(DEFAULTS);
  });
});

describe('the RPC', () => {
  test('a build: central\'s (or the bundled) URL, then publicnode', () => {
    expect(rpcUrls({ config: DEFAULTS })).toEqual(['https://sepolia.base.org', FALLBACK_RPC]);
    expect(rpcUrls({ config: { ...DEFAULTS, rpcUrl: FALLBACK_RPC } })).toEqual([FALLBACK_RPC]);
  });
  test('the dev server: the local fork; a setting wins over both', () => {
    expect(rpcUrls({ config: DEFAULTS, devDefault: '/rpc' })).toEqual(['/rpc']);
    expect(rpcUrls({ config: DEFAULTS, devDefault: '/rpc', setting: 'https://mine.example' })).toEqual(['https://mine.example']);
  });
  test('the setting: empty, https, or a same-origin path', () => {
    expect(checkRpcSetting('  ')).toBe('');
    expect(checkRpcSetting(' https://base.example/rpc ')).toBe('https://base.example/rpc');
    expect(checkRpcSetting('/rpc')).toBe('/rpc');
    for (const bad of ['http://127.0.0.1:8545', '//evil.example', 'ws://x', 'rpc']) expect(() => checkRpcSetting(bad)).toThrow(/https/);
  });
});
