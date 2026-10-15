import { expect, test } from 'vitest';
import { fmtNum, fmtWhen, pickIndexes, registrationText, mismatchText, pollText, submitText } from './format.js';

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
