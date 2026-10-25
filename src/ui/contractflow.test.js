import { expect, test } from 'vitest';
import { predictedToday, contractChecks } from './contractflow.js';

const base = (o = {}) => ({ config: 'bundled', round: 20, play: 'auto', lastBatch: null, lastPlay: null,
  wallet: { staked: 'alias', address: '0xW', lowEth: false, satori: '100' }, alias: { address: '0xA', noGas: false, lowEth: false, batchesLeft: 40 }, ...o });
const states = (b) => contractChecks(b).map((c) => `${c.id}:${c.state}${c.fix ? `:${c.fix}` : ''}`);

test('predictedToday: the batch or the game, this round', () => {
  expect(predictedToday(base())).toBe(false);
  expect(predictedToday(base({ lastBatch: { round: 20 } }))).toBe(true);
  expect(predictedToday(base({ lastPlay: { round: 20 } }))).toBe(true);
  expect(predictedToday(base({ lastBatch: { round: 19 } }))).toBe(false);
});

test('automatic: staked, gas, predicted today; each missing one says its fix', () => {
  expect(states(base({ lastBatch: { round: 20 } }))).toEqual(['satori:ok', 'stake:ok', 'gas:ok', 'today:ok']);
  expect(states(base({ wallet: { staked: 'none', satori: '0.5' } }))).toEqual(['satori:bad', 'stake:bad:stake', 'gas:ok', 'today:wait']);
  const low = contractChecks(base({ alias: { address: '0xA', lowEth: true, batchesLeft: 3 } }));
  expect(low[2]).toMatchObject({ state: 'bad', fix: 'fund', address: '0xA', text: expect.stringMatching(/about 3 days left/) });
  expect(states(base({ wallet: { staked: 'other' } }))[1]).toBe('stake:bad');
});

test("by hand: who plays, the player's gas, played today (else Play)", () => {
  expect(states(base({ play: 'manual', lastPlay: { round: 20 } }))).toEqual(['satori:ok', 'gas:ok', 'today:ok']);
  expect(states(base({ play: 'manual' }))).toEqual(['satori:ok', 'gas:ok', 'today:wait:game']);
  const wallet = contractChecks(base({ play: 'manual', wallet: { staked: 'none', address: '0xW', lowEth: true } }));
  expect(wallet[1]).toMatchObject({ state: 'bad', fix: 'fund', address: '0xW', who: 'wallet' });
  expect(contractChecks(base({ play: 'manual' }))[0].text).toBe('Must have at least 1 SATORI in your wallet to participate');
  expect(states(base({ play: 'manual', wallet: { staked: 'other' } })).slice(0, 2)).toEqual(['satori:bad', 'free:bad']);
  expect(contractChecks(base({ play: null }))).toEqual([]);
});
