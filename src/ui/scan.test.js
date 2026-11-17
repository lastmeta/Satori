// Scan's reading of a QR code (scan.js): only an address, or an EIP-681 link to one, fills Send's To.
import { expect, test } from 'vitest';
import { addressFromQr, cameraText, SCAN_TEXT } from './scan.js';

const CHECKED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // EIP-55's own example
const A = CHECKED.toLowerCase();
const TOKEN = '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17';

test('the address alone, any case, checksummed; a bad checksum, none', () => {
  expect(addressFromQr(A)).toBe(CHECKED);
  expect(addressFromQr(` 0x${A.slice(2).toUpperCase()}\n`)).toBe(CHECKED);
  expect(addressFromQr(CHECKED)).toBe(CHECKED);
  expect(addressFromQr(CHECKED.replace('aAe', 'aae'))).toBe(''); // mixed case that is not its checksum: a typo, not an address
});

test('an EIP-681 link: its target, with or without a chain; a token transfer: its recipient, never the token', () => {
  expect(addressFromQr(`ethereum:${A}`)).toBe(CHECKED);
  expect(addressFromQr(`ethereum:${A}@8453`)).toBe(CHECKED);
  expect(addressFromQr(`ETHEREUM:pay-${A}@8453?value=1e18`)).toBe(CHECKED);
  expect(addressFromQr(`ethereum:${TOKEN}@8453/transfer?address=${A}&uint256=1e18`)).toBe(CHECKED);
  expect(addressFromQr(`ethereum:${TOKEN}@8453/transfer?uint256=1e18`)).toBe(''); // no recipient
  expect(addressFromQr(`ethereum:${TOKEN}@8453/approve?address=${A}`)).toBe(''); // not a payment
});

test('anything else, none: a link that merely holds an address, words, nothing', () => {
  expect(addressFromQr(`https://app.satorinet.io/?ref=${A}`)).toBe('');
  expect(addressFromQr(`pay ${A}`)).toBe('');
  expect(addressFromQr('ethereum:vitalik.eth')).toBe('');
  expect(addressFromQr('')).toBe('');
  expect(addressFromQr(undefined)).toBe('');
});

test("the camera's errors, said as what to do", () => {
  expect(cameraText({ name: 'NotAllowedError', message: 'Permission denied' })).toBe(SCAN_TEXT.blocked);
  expect(cameraText({ name: 'NotFoundError', message: 'Requested device not found' })).toBe(SCAN_TEXT.missing);
  expect(cameraText({ name: 'NotReadableError', message: 'Could not start video source' })).toBe('The camera could not start: Could not start video source.');
});
