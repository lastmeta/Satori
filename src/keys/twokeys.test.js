// The two-key model: identity (unencrypted, signs on its own) and vault
// (encrypted with the passphrase; Unlock/Lock). See docs/design/keys.md.
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { writeKeys, importDocker, loadIdentity, vaultInfo, unlockVault, verifyMessage } from './index.js';
import { writeWallet } from './docker.js';

vi.setConfig({ testTimeout: 180_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const edges = JSON.parse(readFileSync(new URL('../../test/fixtures/satorilib-edges.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const [a, b] = fx.vectors;
const PASS = 'pass';

describe('writeKeys', () => {
  test('identity stored plaintext, vault encrypted; both readable as Docker files', async () => {
    const { walletYaml, vaultYaml } = await writeKeys({ identity: hex(a.entropyHex), vault: hex(b.entropyHex) }, PASS);
    expect(load(walletYaml)).toEqual(load(a.walletYaml));
    const doc = load(vaultYaml);
    expect(doc.evr.address).toBe(b.address);
    expect(doc.words).not.toContain(' ');
    expect(vaultInfo(vaultYaml)).toEqual({ address: b.address });
  });
  test('no identity given: a new random one', async () => {
    const one = await writeKeys({ vault: hex(b.entropyHex) }, PASS);
    const two = await writeKeys({ vault: hex(b.entropyHex) }, PASS);
    expect(load(one.walletYaml).evr.address).not.toBe(load(two.walletYaml).evr.address);
    expect(load(one.walletYaml).evr.address).not.toBe(b.address);
  });
  test('passphrase rule as Docker: at least 4 characters, as Python counts them', async () => {
    await expect(writeKeys({ vault: hex(b.entropyHex) }, 'abc')).rejects.toThrow(/at least 4/);
    await expect(writeKeys({ vault: hex(b.entropyHex) }, 'äöü')).rejects.toThrow(/at least 4/);
  });
  test('a passphrase outside Latin-1 is refused: Docker can only encrypt with Latin-1', async () => {
    await expect(writeKeys({ vault: hex(b.entropyHex) }, '😀😀')).rejects.toThrow(/Latin-1/);
    await expect(writeKeys({ vault: hex(b.entropyHex) }, 'p€ss')).rejects.toThrow(/Latin-1/);
  });
});

describe('identity', () => {
  test('loads without a passphrase and signs', async () => {
    const id = await loadIdentity(a.walletYaml);
    expect(id).toMatchObject({ address: a.address, pubkey: a.pubkey });
    expect(verifyMessage('m', id.sign('m'), { address: a.address })).toBe(true);
    expect(id.backup()).toEqual({ words: a.words, wif: a.wif });
  });
});

describe('vault', () => {
  test('address shows while locked; Unlock needs the passphrase; Lock wipes', async () => {
    const vaultYaml = await writeWallet(hex(b.entropyHex), { password: PASS });
    expect(vaultInfo(vaultYaml)).toEqual({ address: b.address });
    await expect(unlockVault(vaultYaml, 'nope')).rejects.toThrow(/wrong passphrase/i);
    const v = await unlockVault(vaultYaml, PASS);
    expect(v).toMatchObject({ address: b.address, pubkey: b.pubkey, locked: false });
    expect(verifyMessage('m', v.sign('m'), { address: b.address })).toBe(true);
    expect(v.backup()).toEqual({ words: b.words, wif: b.wif });
    v.lock();
    expect(v.locked).toBe(true);
    expect(() => v.sign('m')).toThrow(/locked/i);
    expect(() => v.backup()).toThrow(/locked/i);
  });
  test('an old vault (address encrypted) has no address until imported', () => {
    expect(vaultInfo(fx.vaults.old.yaml)).toEqual({ address: null });
  });
});

describe('importDocker', () => {
  const { password, wrongPassword } = fx.vaults;
  test('current files: identity re-written plaintext, vault kept as given', async () => {
    const r = await importDocker({ walletText: a.walletYaml, vaultText: fx.vaults.current.yaml, passphrase: password });
    expect(load(r.walletYaml)).toEqual(load(a.walletYaml));
    expect(r.vaultYaml).toBe(fx.vaults.current.yaml);
  });
  test('an old vault is re-written so its address shows while locked', async () => {
    const r = await importDocker({ walletText: a.walletYaml, vaultText: fx.vaults.old.yaml, passphrase: password });
    const old = fx.vectors[fx.vaults.old.vector];
    expect(vaultInfo(r.vaultYaml)).toEqual({ address: old.address });
    expect((await unlockVault(r.vaultYaml, password)).address).toBe(old.address);
  });
  test('wrong passphrase, a mismatched file, a watch-only file are refused', async () => {
    await expect(importDocker({ walletText: a.walletYaml, vaultText: fx.vaults.current.yaml, passphrase: wrongPassword }))
      .rejects.toThrow(/vault\.yaml: wrong passphrase/i);
    await expect(importDocker({ walletText: fx.mismatch.yaml, vaultText: fx.vaults.current.yaml, passphrase: password }))
      .rejects.toThrow(/wallet\.yaml: .*publicKey/);
    await expect(importDocker({ walletText: `publicKey: ${a.pubkey}\n`, vaultText: fx.vaults.current.yaml, passphrase: password }))
      .rejects.toThrow(/wallet\.yaml: no private key/i);
  });
  test('files in the wrong slots are refused, and the message says which', async () => {
    const current = fx.vaults.current.yaml;
    await expect(importDocker({ walletText: current, vaultText: a.walletYaml, passphrase: password }))
      .rejects.toThrow(/swapped/i);
    await expect(importDocker({ walletText: current, vaultText: fx.vaults.old.yaml, passphrase: password }))
      .rejects.toThrow(/wallet\.yaml: .*encrypted.*vault\.yaml/i);
    await expect(importDocker({ walletText: a.walletYaml, vaultText: b.walletYaml, passphrase: password }))
      .rejects.toThrow(/vault\.yaml: .*not encrypted/i);
  });
  test('a vault Docker saved unencrypted (password outside Latin-1) is refused', async () => {
    await expect(importDocker({ walletText: a.walletYaml, vaultText: edges.nonLatin1Password.savedYaml, passphrase: 'p€ss' }))
      .rejects.toThrow(/vault\.yaml: .*not encrypted/i);
  });
  test('a plain-text vault is never kept: Unlock refuses it whatever the passphrase', async () => {
    await expect(unlockVault(b.walletYaml, 'anything')).rejects.toThrow(/not encrypted/i);
  });
  test('the same key as identity and vault is refused', async () => {
    const vaultText = await writeWallet(hex(a.entropyHex), { password: PASS });
    await expect(importDocker({ walletText: a.walletYaml, vaultText, passphrase: PASS })).rejects.toThrow(/same key/i);
  });
});
