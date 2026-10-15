import { describe, expect, test, vi } from 'vitest';
import { DEFAULTS, loadConfig } from './config.js';

describe('loadConfig', () => {
  const remote = { chainId: 84532, token: '0x' + 'aa'.repeat(20), hub: '', rpcUrl: 'https://rpc.example' };

  test('bundled DEFAULTS mirror contract/satori/deployments/baseSepolia.json', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const f = '/code/Satori/contract/satori/deployments/baseSepolia.json';
    if (!existsSync(f)) return;
    const { addresses, chainId } = JSON.parse(readFileSync(f, 'utf8'));
    expect(DEFAULTS.chainId).toBe(chainId);
    for (const k of ['token', 'merkle', 'airdrop', 'rewards', 'engine', 'games', 'registry', 'hub']) {
      expect(DEFAULTS[k]).toBe(addresses[k]);
    }
    expect(DEFAULTS.rpcUrl).toBe('https://sepolia.base.org');
  });

  test('central values overlay the defaults; empty values are ignored', async () => {
    const { config, cache } = await loadConfig({ fetchCentral: async () => remote, now: 1000 });
    expect(config.token).toBe(remote.token);
    expect(config.hub).toBe(DEFAULTS.hub);
    expect(config.rpcUrl).toBe('https://rpc.example');
    expect(cache).toEqual({ remote, fetchedAt: 1000 });
  });

  test('a fresh cache (< 1 h) is used without fetching', async () => {
    const fetchCentral = vi.fn();
    const { config } = await loadConfig({ fetchCentral, cached: { remote, fetchedAt: 1000 }, now: 1000 + 3599_000 });
    expect(fetchCentral).not.toHaveBeenCalled();
    expect(config.token).toBe(remote.token);
  });

  test('a stale cache is refetched', async () => {
    const fetchCentral = vi.fn(async () => null);
    const { config, cache } = await loadConfig({ fetchCentral, cached: { remote, fetchedAt: 0 }, now: 3600_000 });
    expect(fetchCentral).toHaveBeenCalledOnce();
    expect(config).toEqual(DEFAULTS);
    expect(cache).toEqual({ remote: null, fetchedAt: 3600_000 });
  });

  test('central down or 404 (null) → defaults', async () => {
    const { config } = await loadConfig({ fetchCentral: async () => { throw new Error('offline'); }, now: 1 });
    expect(config).toEqual(DEFAULTS);
  });

  test('the user-picked RPC URL wins over central and defaults', async () => {
    const { config } = await loadConfig({ fetchCentral: async () => remote, rpcUrl: 'https://mine.example', now: 1 });
    expect(config.rpcUrl).toBe('https://mine.example');
  });

  test('a config for another chain is refused (v1 is Base Sepolia only)', async () => {
    const { config } = await loadConfig({ fetchCentral: async () => ({ ...remote, chainId: 8453 }), now: 1 });
    expect(config).toEqual({ ...DEFAULTS });
  });
});
