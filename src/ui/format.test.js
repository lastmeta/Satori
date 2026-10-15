import { expect, test } from 'vitest';
import {
  fmtNum, fmtWhen, pickIndexes, registrationText, mismatchText, pollText, submitText, modelTitle,
  fmtCadence, shortKey, relayText, obsText, catalogMatch, predText,
  shortHash, amountText, fmtUtc, delegationText, lockText, gasText, batchText, checkText, claimLine,
} from './format.js';

test('fmtNum', () => {
  expect(fmtNum(67123.456)).toBe('67,123.46');
  expect(fmtNum(100010)).toBe('100,010.00');
  expect(fmtNum(7)).toBe('7');
  expect(fmtNum(1.234567)).toBe('1.2346');
  expect(fmtNum(0.000123456)).toBe('0.000123');
  expect(fmtNum(null)).toBe('–');
  expect(fmtNum(NaN)).toBe('–');
});

test('fmtWhen: unix seconds → local month, day and time', () => {
  const at = new Date(2026, 9, 15, 14, 3, 9).getTime() / 1000;
  expect(fmtWhen(at)).toBe('Oct 15, 14:03');
  expect(fmtWhen(new Date(2026, 9, 16, 0, 5).getTime() / 1000)).toBe('Oct 16, 00:05');
  expect(fmtWhen(null)).toBe('–');
});

test('registrationText and mismatchText', () => {
  expect(registrationText(null)).toBe('Registering…');
  expect(registrationText({ ok: true, peer_id: 7 })).toBe('Yes · peer 7');
  expect(registrationText({ ok: false, error: 'central 409: taken' })).toBe('No: central 409: taken');
  expect(mismatchText(null, 'Ev')).toBe('');
  expect(mismatchText({ ok: true, vaultMismatch: false, vault_address: 'Ev' }, 'Ev')).toBe('');
  expect(mismatchText({ ok: true, vaultMismatch: true, vault_address: 'Ex' }, 'Ev'))
    .toBe('Vault mismatch: central has Ex for this identity, not this vault (Ev).');
  expect(mismatchText({ ok: true, vaultMismatch: true, vault_address: null }, 'Ev'))
    .toBe('Vault mismatch: central kept no vault for this identity (Ev may be registered to another neuron).');
});

test('pollText and submitText', () => {
  const at = new Date(2026, 9, 15, 14, 3).getTime() / 1000;
  expect(pollText(null)).toBe('Not yet');
  expect(pollText({ at, streams: 83, new: 80, predicted: 80 })).toBe('Oct 15, 14:03 · 83 streams, 80 new, 80 predicted');
  expect(pollText({ at, error: 'central timed out (15 s)' })).toBe('Oct 15, 14:03 · failed: central timed out (15 s)');
  expect(submitText(null)).toBe('Not yet');
  expect(submitText({ at, total_submitted: 80, successful: 80, failed: 0 })).toBe('Oct 15, 14:03 · 80 of 80 accepted');
  expect(submitText({ at, total_submitted: 2, successful: 0, failed: 2, errors: ['x'] }))
    .toBe('Oct 15, 14:03 · 0 of 2 accepted; kept for the next poll');
  expect(submitText({ at, error: 'central 500: boom' })).toBe('Oct 15, 14:03 · failed: central 500: boom; kept for the next poll');
});

test('pickIndexes', () => {
  const ix = pickIndexes(3, 24);
  expect(ix).toHaveLength(3);
  expect(new Set(ix).size).toBe(3);
  expect(ix.every((i) => i >= 0 && i < 24)).toBe(true);
  expect([...ix].sort((a, b) => a - b)).toEqual(ix);
});

test('modelTitle: the engine model in a few words (the Streams table hover)', () => {
  expect(modelTitle({ model: 'bar1', phi: -0.12345, weight: 0.8 })).toBe('Bayesian AR(1) on 12 h returns · φ −0.123 · weight 0.8');
  expect(modelTitle({ model: 'bar1', phi: 0, weight: 1 })).toBe('Bayesian AR(1) on 12 h returns · φ 0 · weight 1');
  expect(modelTitle({ model: 'naive' }))
    .toBe('the last value: bar1 needs an observation every 12 h (6 lag pairs of back-to-back 12 h buckets)');
  expect(modelTitle({ model: 'ols-20' })).toBe('ols-20');
  expect(modelTitle({ model: null })).toBe('');
});

test('fmtCadence', () => {
  expect([900, 1800, 3600, 7200, 86400, 2592000, 45, 90, null].map(fmtCadence))
    .toEqual(['15 min', '30 min', '1 h', '2 h', '1 d', '30 d', '45 s', '90 s', 'irregular']);
});

test('shortKey', () => {
  expect(shortKey('e5e6ce948344b1e0178f9ccf49fcb499b4b4f00fc09c7637535ee82fc7bf503d')).toBe('e5e6ce94…503d');
  expect(shortKey('')).toBe('');
});

test('relayText: the state in a word, and read only', () => {
  expect(relayText({ state: 'open', write: true })).toBe('Connected');
  expect(relayText({ state: 'open', write: false })).toBe('Connected · read only');
  expect(relayText({ state: 'connecting', write: true })).toBe('Connecting…');
  expect(relayText({ state: 'closed', write: true, error: 'closed (1006)' })).toBe('Disconnected (closed (1006)); retrying');
  expect(relayText({ state: 'blocked', write: false, error: 'ws:// cannot be opened from an https page' }))
    .toBe('Blocked: ws:// cannot be opened from an https page');
});

test('obsText: a relay value as sent (a dict as JSON)', () => {
  expect(obsText({ raw: '82234', value: 82234 })).toBe('82234');
  expect(obsText({ raw: { raw: '1', unit: 'tick' }, value: null })).toBe('{"raw":"1","unit":"tick"}');
  expect(obsText(null)).toBe('–');
});

test('predText: a published value as a number when it is one (the exact string is in the title)', () => {
  expect(predText('97.16251735526325')).toBe('97.1625');
  expect(predText('82109.0')).toBe('82,109.00');
  expect(predText('abc')).toBe('abc');
  expect(predText('{"raw": "1"}')).toBe('{"raw": "1"}');
  expect(predText(null)).toBe('–');
});

test('catalogMatch: name, stream, description or tags, any case', () => {
  const s = { stream_name: 'btc-usd-price', name: 'Bitcoin USD Price', description: 'From CoinGecko', tags: ['crypto'] };
  for (const q of ['', 'BTC', 'bitcoin usd', 'coingecko', 'CRYPTO']) expect(catalogMatch(s, q), q).toBe(true);
  expect(catalogMatch(s, 'eth')).toBe(false);
});

test('Base: amounts, the delegation, the lock (until round N, free from N + 1 at 00:00 UTC)', () => {
  expect(amountText('100', 'SATORI')).toBe('100 SATORI');
  expect(amountText('0.000123456', 'ETH')).toBe('0.000123 ETH');
  expect(amountText(null, 'ETH')).toBe('–');
  expect(fmtUtc(20743 * 86400)).toBe('Oct 17, 00:00 UTC');
  const v = { identity: { power: '100' }, vault: { delegated: 'identity', delegate: '0xI' } };
  expect(delegationText(v)).toBe('Delegated to the identity · 100 SATORI of prediction power');
  expect(delegationText({ ...v, vault: { delegated: 'none' } })).toBe('Not delegated');
  expect(delegationText({ ...v, vault: { delegated: 'other', delegate: '0xO' } })).toBe('Delegated to 0xO, not this identity');
  expect(delegationText(null)).toBe('–');
  expect(lockText({ locked: false })).toBe('Free to send');
  expect(lockText({ locked: true, indefinite: true })).toBe('SATORI transfer-locked while delegated');
  expect(lockText({ locked: true, indefinite: false, untilRound: 20742, freeAt: 20743 * 86400 }))
    .toBe('SATORI transfer-locked until round 20742 (free from Oct 17, 00:00 UTC)');
});

test('Base: gas, the last batch, the check, a claim', () => {
  expect(gasText({ eth: '0.1', batchesLeft: 33 })).toBe('0.1 ETH · about 33 daily batches');
  expect(gasText({ eth: '0.1', batchesLeft: 1 })).toBe('0.1 ETH · about 1 daily batch');
  expect(gasText({ eth: '9', batchesLeft: 5000 })).toBe('9 ETH · about 1,000+ daily batches');
  expect(gasText({ eth: null })).toBe('–');
  const at = new Date(2026, 9, 15, 9, 0).getTime() / 1000;
  expect(batchText(null)).toBe('None yet');
  expect(batchText({ round: 20741, at, games: [{ gameId: 1, direction: 2 }, { gameId: 3, direction: 1 }],
    dropped: [{ gameId: 4, error: 'StaleValue' }] })).toBe('Round 20741 · Oct 15, 09:00 · game 1 ↓, game 3 ↑ · left out: game 4 (StaleValue)');
  expect(checkText(null, null)).toBe('Not yet');
  expect(checkText({ round: 20741, sent: {} }, at)).toBe('sent round 20741 · next Oct 15, 09:00');
  expect(checkText({ skipped: 'already predicted this round' }, null)).toBe('already predicted this round');
  expect(checkText({ error: 'boom' }, null)).toBe('failed: boom');
  expect(shortHash('0x' + 'ab'.repeat(32))).toBe('0xabab…abab');
  expect(claimLine('Rewards', { hash: '0x' + 'ab'.repeat(32), amount: '3' })).toBe('Rewards: claimed 3 SATORI (0xabab…abab)');
  expect(claimLine('Merkle', { skipped: 'this vault is not in the current drop' })).toBe('Merkle: this vault is not in the current drop');
  expect(claimLine('Airdrop', { error: 'reverted: NothingToClaim' })).toBe('Airdrop: failed: reverted: NothingToClaim');
});

test('modelTitle: bar1d, the AR(1) on changes', () => {
  expect(modelTitle({ model: 'bar1d', phi: 0.51234, weight: 0.75 })).toBe('Bayesian AR(1) on 12 h changes (a series with values ≤ 0) · φ 0.512 · weight 0.75');
});
