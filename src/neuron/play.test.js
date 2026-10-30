// Who plays, and the next step to earning on the contract (src/neuron/play.js).
import { expect, test } from 'vitest';
import { nextStep, playerOf, sendsToday } from './play.js';

const base = (o = {}) => ({ config: 'bundled', round: 20, play: 'auto', lastBatch: null, lastPlay: null,
  wallet: { staked: 'alias', address: '0xW', lowEth: false, satori: '100' }, alias: { address: '0xA', noGas: false, lowEth: false, batchesLeft: 40 }, ...o });

test('the player: the alias when staked with it, else the wallet; the reminder watches whoever sends today', () => {
  expect([playerOf('alias'), playerOf('none'), playerOf('other'), playerOf(null)]).toEqual(['alias', 'wallet', 'wallet', 'wallet']);
  expect([sendsToday({ play: 'auto', staked: 'none' }), sendsToday({ play: 'manual', staked: 'none' }), sendsToday({ play: 'manual', staked: 'alias' })])
    .toEqual(['alias', 'wallet', 'alias']);
});

test('nextStep: the first thing missing for the app to predict on the contract by itself (Home\'s nudge)', () => {
  const w = (o) => ({ staked: 'none', address: '0xW', lowEth: false, satori: '100', eth: '0.01', ...o });
  const noGas = { address: '0xA', noGas: true, lowEth: true, batchesLeft: 0 };
  expect(nextStep(base({ wallet: w({ eth: '0', lowEth: true }), alias: noGas }))).toBe('eth'); // Stake and Preload gas spend it
  expect(nextStep(base({ wallet: w(), alias: noGas }))).toBe('gas'); // Stake needs gas at this app's address first
  expect(nextStep(base({ wallet: w({ staked: 'other' }), alias: noGas }))).toBe('gas');
  expect(nextStep(base({ wallet: w() }))).toBe('stake');
  expect(nextStep(base({ wallet: w({ staked: 'other' }) }))).toBe('stake');
  expect(nextStep(base({ wallet: w({ staked: 'alias' }), alias: noGas }))).toBe('gas');
  expect(nextStep(base({ wallet: w({ staked: 'alias' }), alias: { address: '0xA', lowEth: true, batchesLeft: 3 } }))).toBe('gas');
  expect(nextStep(base({ wallet: w(), alias: { address: '0xA', lowEth: true, batchesLeft: 3 } }))).toBe('stake'); // enough to stake
  expect(nextStep(base({ wallet: w({ staked: 'alias', eth: '0', lowEth: true }), alias: noGas }))).toBe('eth');
  expect(nextStep(base({ play: 'manual' }))).toBe('auto');
  expect(nextStep(base({ play: 'manual', wallet: w({ staked: 'alias', eth: '0', lowEth: true }) }))).toBe('auto'); // its gas is in the alias
  expect(nextStep(base())).toBe(null); // automatic, staked, gas: nothing to do
  expect(nextStep(base({ wallet: w({ satori: '0.5', eth: '0' }) }))).toBe(null); // under 1 SATORI: nothing to earn with yet
  expect(nextStep(base({ play: null }))).toBe(null);
});
