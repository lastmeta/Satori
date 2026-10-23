// Secrets in memory (the security review, 2026-10-19): what JS can wipe is wiped. The passphrase's UTF-8 bytes once
// the key is derived (wallet.js), and the copy an Unlock opens again to check its re-encryption (index.js). Strings and
// the curve library's numbers can't be wiped (keys.md).
import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const opened = []; // every secret openSecret handed out
vi.mock('./wallet.js', async (original) => {
  const m = await original();
  return { ...m, openSecret: async (...args) => { const s = await m.openSecret(...args); opened.push(s); return s; } };
});
const { newKeys, recordFromRows, unlockWallet } = await import('./index.js');
const { sealSecret } = await vi.importActual('./wallet.js');

vi.setConfig({ testTimeout: 180_000 });
const { profiles } = JSON.parse(readFileSync(new URL('../../test/fixtures/profiles.json', import.meta.url)));
const zero = (b) => b.every((x) => x === 0);

test("the passphrase's bytes are zeroed once the key is derived (seal and open)", async () => {
  const seen = [];
  const encode = TextEncoder.prototype.encode;
  const spy = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (s) { const b = encode.call(this, s); seen.push(b); return b; });
  try {
    await sealSecret(new Uint8Array(32).fill(7), 'correct horse battery', { iterations: 1000 });
  } finally {
    spy.mockRestore();
  }
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(zero)).toBe(true);
});

test("an earlier version's wallet, re-encrypted at Unlock: the copy opened again to check it is zeroed; the wallet's own at Lock", async () => {
  const p = profiles.find((x) => x.meta.wallet_yaml && x.meta.vault_yaml && !x.label.includes('plain-text vault.yaml') && x.commit !== '8996f24');
  const record = await recordFromRows({ aliasYaml: p.meta.wallet_yaml, walletYaml: p.meta.vault_yaml, nostrYaml: p.meta.nostr_yaml });
  opened.length = 0;
  const { wallet, record: upgraded } = await unlockWallet(record, p.passphrase);
  expect(upgraded.wallet.data).toEqual(expect.any(String));
  expect(opened).toHaveLength(1); // the check's copy
  expect(zero(opened[0])).toBe(true);
  wallet.lock();
  // this app's own wallet: the secret Unlock opens is the signer's, wiped by Lock
  const mine = await newKeys({ wallet: new Uint8Array(32).fill(9) }, 'correct horse battery');
  opened.length = 0;
  const v2 = (await unlockWallet(mine, 'correct horse battery')).wallet;
  expect(zero(opened[0])).toBe(false);
  v2.lock();
  expect(zero(opened[0])).toBe(true);
});
