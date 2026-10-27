import { expect, test } from 'vitest';
import { predictedToday, contractChecks, nextStep } from './contractflow.js';

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

test("by hand: the player's gas, staked (else Stake), played today (else Play)", () => {
  expect(states(base({ play: 'manual', lastPlay: { round: 20 } }))).toEqual(['satori:ok', 'gas:ok', 'stake:ok', 'today:ok']);
  expect(states(base({ play: 'manual' }))).toEqual(['satori:ok', 'gas:ok', 'stake:ok', 'today:wait:game']);
  const wallet = contractChecks(base({ play: 'manual', wallet: { staked: 'none', address: '0xW', lowEth: true } }));
  expect(wallet[2]).toMatchObject({ id: 'stake', state: 'wait', fix: 'stake' }); // not staked: invited to, calmly
  expect(wallet[1]).toMatchObject({ state: 'bad', fix: 'fund', address: '0xW', who: 'wallet' });
  expect(contractChecks(base({ play: 'manual' }))[0].text).toBe('Must have at least 1 SATORI in your wallet to participate');
  expect(states(base({ play: 'manual', wallet: { staked: 'other' } })).slice(0, 2)).toEqual(['satori:bad', 'free:bad']);
  expect(contractChecks(base({ play: null }))).toEqual([]);
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

import { networkSent, networkChecks, relaysOn, relayChecks } from './contractflow.js';
const NOW = 1_000_000;
const ids = (list) => list.map((c) => `${c.id}:${c.state}${c.fix ? `:${c.fix}` : ''}`);

test('the Network card: registered, rewards to the wallet, sent in the last day', () => {
  const sent = { at: NOW - 7200, successful: 82 };
  const c = { registration: { ok: true }, lastSubmit: sent };
  expect(networkSent(c, NOW)).toBe(true);
  expect(ids(networkChecks(c, NOW))).toEqual(['register:ok', 'sent:ok']);
  expect(networkChecks(c, NOW)[1].text).toBe('Sent 82 predictions 2 h ago.');
  expect(ids(networkChecks({ registration: { ok: false, error: 'HTTP 500' }, lastSubmit: null }, NOW))).toEqual(['register:bad:poll', 'sent:wait']);
  expect(ids(networkChecks({ registration: { ok: true, walletMismatch: 'none' }, lastSubmit: { at: NOW, error: 'timeout' } }, NOW)))
    .toEqual(['register:ok', 'sent:bad:poll']);
  expect(networkSent({ lastSubmit: { at: NOW - 2 * 86400, successful: 5 } }, NOW)).toBe(false);
});

test('the Relays card: connected, watching, publishing', () => {
  const n = { relays: [{ state: 'open' }, { state: 'closed' }, { state: 'blocked' }], watching: { streams: 112 }, subscriptions: [{}, {}], own: { streams: 83 } };
  expect(relaysOn(n)).toBe(true);
  expect(ids(relayChecks(n))).toEqual(['connected:ok', 'watching:ok', 'own:ok', 'publishing:ok']);
  expect(relayChecks(n)[0].text).toBe('Connected to 1 of 2 relays.');
  expect(ids(relayChecks({ relays: [{ state: 'closed' }], watching: { streams: 0 }, subscriptions: [] })))
    .toEqual(['connected:bad', 'watching:wait', 'own:wait', 'publishing:wait:streams']);
  expect(relaysOn({ relays: [] })).toBe(false);
});
