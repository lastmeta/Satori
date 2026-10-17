// The traffic emitter (src/traffic.js): each channel's last request or answer, told to every subscriber;
// a viem transport traced.
import { expect, test } from 'vitest';
import { createTraffic, traced, CHANNELS } from './traffic.js';

test("emit: each channel's last traffic (ms), told to every subscriber; unsubscribe stops it", () => {
  const t = createTraffic();
  expect(CHANNELS).toEqual(['central', 'base', 'network']);
  expect(t.last()).toEqual({ central: null, base: null, network: null });
  const seen = [];
  const off = t.subscribe((ch, at) => seen.push([ch, at]));
  t.emit('central', 1000);
  t.emit('network', 1005);
  expect(t.last()).toEqual({ central: 1000, base: null, network: 1005 });
  off();
  t.emit('base', 2000);
  expect(seen).toEqual([['central', 1000], ['network', 1005]]);
  expect(t.last().base).toBe(2000);
  t.last().central = 0; // a copy
  expect(t.last().central).toBe(1000);
});

test('traced: a viem transport whose every request and its answer (or its error) is traffic', async () => {
  const fired = [];
  const inner = () => ({ config: { key: 'http' }, value: { url: 'x' },
    request: async ({ method }) => { if (method === 'bad') throw new Error('rpc down'); return `${method}!`; } });
  const t = traced(inner, () => fired.push(1))({ chain: null });
  expect([t.config, t.value]).toEqual([{ key: 'http' }, { url: 'x' }]);
  expect(await t.request({ method: 'eth_chainId' })).toBe('eth_chainId!');
  expect(fired).toHaveLength(2); // the request, the answer
  await expect(t.request({ method: 'bad' })).rejects.toThrow('rpc down');
  expect(fired).toHaveLength(4);
});
