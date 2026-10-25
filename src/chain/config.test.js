import { describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULTS, FALLBACK_RPC, PAYMENT_CHANNELS, loadConfig, checkRpcSetting, rpcUrls } from './config.js';

// central2's answer on 2026-10-23: still D6's addresses (it has not moved to D7)
const CENTRAL2_D6 = {
  chainId: 84532, chainName: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org', explorerUrl: 'https://sepolia.basescan.org',
  symbol: 'SATORI', decimals: 18, token: '0x4dee947383d5C9c8E421F55Fe3518a29324aE469',
  merkle: '0x78C83AE275e9659Bc8490fa33943e22ec7c5A7e7', rewards: '0xde5d2B4b92c1231EC19cd3877D7C3eb6b44982Ac',
  airdrop: '0xF15CEAec0e29A0B6551180F8617850bc5356938C', engine: '0xE8fA688ea29850305216121C0bddfFb9096A1093',
  games: '0xB06e419D24cCbA967c6193e9e374117171B400C3', registry: '0x1ED75AB0a66Ba7d23C3E5c84798e90205E76743a',
  hub: '0x1eec7E1443C1065ab78180A14326e5Ac8284f143',
  streamProvider: 'cb45de2a76a5df79ea8aff0c867e96e527f803eb389420419e441a4946129838',
};
// what central answers once it serves the bundle's contracts
const CENTRAL2 = { ...CENTRAL2_D6, ...Object.fromEntries(Object.keys(CENTRAL2_D6).filter((k) => DEFAULTS[k] && k !== 'rpcUrl').map((k) => [k, DEFAULTS[k]])) };

describe('loadConfig', () => {
  test('the bundle mirrors contract/satori/deployments/baseSepolia.json and Lite\'s DEFAULTS', () => {
    const f = '/code/Satori/contract/satori/deployments/baseSepolia.json';
    if (existsSync(f)) {
      const { addresses, chainId } = JSON.parse(readFileSync(f, 'utf8'));
      expect(DEFAULTS.chainId).toBe(chainId);
      for (const k of ['token', 'merkle', 'airdrop', 'rewards', 'engine', 'games', 'registry', 'hub', 'lens', 'voting']) {
        expect(DEFAULTS[k], k).toBe(addresses[k]);
      }
    }
    expect(DEFAULTS.rpcUrl).toBe(CENTRAL2_D6.rpcUrl); // = base_config.py DEFAULTS = central2
  });

  test("central still on D6: every contract it names differs from the bundle's D7 and is listed, none used", async () => {
    const { config, differs } = await loadConfig({ fetchCentral: async () => CENTRAL2_D6, now: 1 });
    expect(config).toEqual(DEFAULTS);
    expect(differs).toEqual(['token', 'merkle', 'airdrop', 'rewards', 'engine', 'games', 'registry', 'hub']);
  });

  test('PaymentChannels: the address its CREATE2 deploy recorded (the same on every chain)', () => {
    const f = '/code/Satori/contract/satori/deployments/payment-channels.json';
    if (existsSync(f)) expect(PAYMENT_CHANNELS).toBe(JSON.parse(readFileSync(f, 'utf8')).address);
    expect(DEFAULTS.channels).toBe('0xa6DCa52936EAb8DD1EC9f8AD98e75D1Afb0DC16c');
  });

  test("central's contract addresses are taken only when they equal the bundle's; one that differs is listed, the bundle's kept", async () => {
    const remote = { chainId: 84532, token: '0x' + 'aa'.repeat(20), hub: '', engine: 'nope', registry: CENTRAL2.registry.toLowerCase(),
      rewards: CENTRAL2.rewards, lens: '0x' + 'bb'.repeat(20), evil: 'x' };
    const { config, cache, differs, fresh } = await loadConfig({ fetchCentral: async () => remote, now: 1000 });
    expect(config).toEqual(DEFAULTS); // a different token is never used; lens is not central's to say
    expect(differs).toEqual(['token']); // the same address in lower case is the same; empty and malformed values say nothing
    expect([cache, fresh]).toEqual([{ remote, at: 1000 }, true]);
    expect((await loadConfig({ fetchCentral: async () => remote, cache, now: 1001 })).fresh).toBe(false); // from the cache
  });

  test("central's rpcUrl and explorerUrl: taken (https only) unless the build pins its RPC; pinned, the bundle's", async () => {
    const remote = { ...CENTRAL2, rpcUrl: 'https://rpc.example', explorerUrl: 'https://scan.example' };
    const open = await loadConfig({ fetchCentral: async () => remote, now: 1 });
    expect([open.config.rpcUrl, open.config.explorerUrl, open.differs]).toEqual(['https://rpc.example', 'https://scan.example', []]);
    const pinned = await loadConfig({ fetchCentral: async () => remote, now: 1, pinned: true });
    expect([pinned.config.rpcUrl, pinned.config.explorerUrl]).toEqual([DEFAULTS.rpcUrl, DEFAULTS.explorerUrl]);
    const plain = await loadConfig({ fetchCentral: async () => ({ ...CENTRAL2, rpcUrl: 'http://rpc.example', explorerUrl: 'javascript:x' }), now: 1 });
    expect([plain.config.rpcUrl, plain.config.explorerUrl]).toEqual([DEFAULTS.rpcUrl, DEFAULTS.explorerUrl]);
  });

  test('cached for an hour, as Lite (base_config.py:16,72-73); then fetched again', async () => {
    const fetchCentral = vi.fn(async () => CENTRAL2);
    const { cache } = await loadConfig({ fetchCentral, now: 1000 });
    await loadConfig({ fetchCentral, cache, now: 1000 + 3599 });
    expect(fetchCentral).toHaveBeenCalledTimes(1);
    await loadConfig({ fetchCentral, cache, now: 1000 + 3600 });
    expect(fetchCentral).toHaveBeenCalledTimes(2);
  });

  test('the cache is per central: another central is asked at once, not an hour later', async () => {
    const fetchCentral = vi.fn(async () => CENTRAL2);
    const { cache } = await loadConfig({ fetchCentral, url: 'https://central2.example', now: 1000 });
    expect(cache.url).toBe('https://central2.example');
    await loadConfig({ fetchCentral, cache, url: 'https://central2.example', now: 1001 });
    expect(fetchCentral).toHaveBeenCalledTimes(1);
    await loadConfig({ fetchCentral, cache, url: 'https://other.example', now: 1002 });
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
  test("a fixed default: the dev server's local fork alone; a build's VITE_BASE_RPC, then publicnode; never central's; a setting wins over both", () => {
    expect(rpcUrls({ config: DEFAULTS, fixed: '/rpc' })).toEqual(['/rpc']);
    const central = { ...DEFAULTS, rpcUrl: 'https://central-says.example' };
    expect(rpcUrls({ config: central, fixed: 'https://sepolia.base.org' })).toEqual(['https://sepolia.base.org', FALLBACK_RPC]);
    expect(rpcUrls({ config: central, fixed: FALLBACK_RPC })).toEqual([FALLBACK_RPC]);
    expect(rpcUrls({ config: DEFAULTS, fixed: '/rpc', setting: 'https://mine.example' })).toEqual(['https://mine.example']);
  });
  test('the setting: empty, https, or a same-origin path', () => {
    expect(checkRpcSetting('  ')).toBe('');
    expect(checkRpcSetting(' https://base.example/rpc ')).toBe('https://base.example/rpc');
    expect(checkRpcSetting('/rpc')).toBe('/rpc');
    for (const bad of ['http://127.0.0.1:8545', '//evil.example', 'ws://x', 'rpc']) expect(() => checkRpcSetting(bad)).toThrow(/https/);
  });
});
