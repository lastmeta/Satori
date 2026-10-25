import { expect, test } from 'vitest';
import { sealBackup, openBackup } from './index.js';

const keys = { wallet: { words: 'w1 w2', privateKey: '0x1' }, alias: { words: 'a1 a2', privateKey: '0x2' }, nostr: { nsec: 'nsec1x', secret: 'ab' } };

test('an encrypted backup: sealed with the passphrase, opened with it, refused without it', async () => {
  const file = await sealBackup({ address: '0xA', keys, passphrase: 'correct horse', at: 't' });
  expect(file).toMatchObject({ kind: 'satori-backup', v: 1, address: '0xA', at: 't' });
  expect(JSON.stringify(file)).not.toMatch(/w1|a1|nsec1x|0x1/); // nothing in clear
  expect(await openBackup(JSON.stringify(file), 'correct horse')).toEqual({ walletWords: 'w1 w2', aliasWords: 'a1 a2', nostrKey: 'nsec1x', address: '0xA' });
  await expect(openBackup(file, 'wrong horse')).rejects.toThrow('Wrong passphrase');
  await expect(openBackup({ kind: 'other' }, 'correct horse')).rejects.toThrow('Not a Satori backup file.');
  await expect(sealBackup({ address: '0xA', keys, passphrase: 'short' })).rejects.toThrow();
  // a connected wallet's: its own words are in its wallet app
  const c = await sealBackup({ address: '0xB', keys: { alias: keys.alias, nostr: keys.nostr }, passphrase: 'correct horse' });
  expect((await openBackup(c, 'correct horse')).walletWords).toBe(null);
}, 30_000);
