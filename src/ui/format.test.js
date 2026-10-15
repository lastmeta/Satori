import { expect, test } from 'vitest';
import {
  fmtNum, fmtWhen, pickIndexes, registrationText, mismatchText, pollText, submitText, modelTitle,
  fmtCadence, shortKey, relayText, obsText, catalogMatch, predText,
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
  expect(registrationText({ ok: false, skipped: true, error: 'no vault public key in vault.yaml' }))
    .toBe('Not sent: no vault public key in vault.yaml');
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
