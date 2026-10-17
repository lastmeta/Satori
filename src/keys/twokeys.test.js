// The two-key model in this app's own record (docs/design/keys.md): the
// identity and the Nostr key in plain text (the neuron signs on its own), the
// vault encrypted with the passphrase; Docker's files translated in; this
// app's earlier rows carried forward.
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  newKeys, readDockerFiles, recordFromRows, loadKeys, unlockVault, publicKey, wordsOf, evmAddress,
} from './index.js';
import { verifyMessage } from 'viem';
import { nostrPubkey } from '../nostr/event.js';

vi.setConfig({ testTimeout: 180_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const edges = JSON.parse(readFileSync(new URL('../../test/fixtures/satorilib-edges.json', import.meta.url)));
const { profiles } = JSON.parse(readFileSync(new URL('../../test/fixtures/profiles.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const [a, b] = fx.vectors;
const PASS = 'correct horse battery';

describe('newKeys: the record', () => {
  test('identity and Nostr key in plain text (hex), the vault sealed with its public key in clear; nothing of Docker\'s', async () => {
    const r = await newKeys({ identity: hex(a.entropyHex), vault: hex(b.entropyHex), nostr: fx.nostr.secretHex }, PASS);
    expect(r).toEqual({
      v: 1, created: expect.any(Number), identity: a.entropyHex, nostr: fx.nostr.secretHex,
      vault: { pubkey: b.pubkey, kdf: expect.objectContaining({ name: 'PBKDF2', hash: 'SHA-256' }),
        cipher: expect.objectContaining({ name: 'AES-GCM' }), data: expect.any(String) },
    });
    expect(Math.abs(r.created - Date.now() / 1000)).toBeLessThan(60); // when these keys were made: Home's first day
    expect(JSON.stringify(r)).not.toMatch(/yaml|address|wif|scripthash|words/i);
    expect(JSON.stringify(r)).not.toContain(b.entropyHex);
  });
  test('a new random identity and Nostr key when not given', async () => {
    const one = await newKeys({ vault: hex(b.entropyHex) }, PASS);
    const two = await newKeys({ vault: hex(b.entropyHex) }, PASS);
    expect(one.identity).not.toBe(two.identity);
    expect(one.nostr).not.toBe(two.nostr);
    expect(one.identity).not.toBe(b.entropyHex);
    expect(nostrPubkey(one.nostr)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('passphrase: at least 8 characters, any Unicode', async () => {
    await expect(newKeys({ vault: hex(b.entropyHex) }, 'seven c')).rejects.toThrow(/at least 8/);
    await expect(newKeys({ vault: hex(b.entropyHex) }, '密码密码')).rejects.toThrow(/at least 8/);
    for (const p of ['密码密码密码密码', '🔑🦊🌕🚀🔑🦊🌕🚀', 'p€ss w€rd']) {
      const r = await newKeys({ vault: hex(b.entropyHex) }, p);
      expect((await unlockVault(r, p)).vault.pubkey, p).toBe(b.pubkey);
    }
  });
  test('the identity and the vault must differ; a bad Nostr key is refused', async () => {
    await expect(newKeys({ identity: hex(a.entropyHex), vault: hex(a.entropyHex) }, PASS)).rejects.toThrow(/same key/i);
    await expect(newKeys({ vault: hex(b.entropyHex), nostr: '00' }, PASS)).rejects.toThrow(/Nostr/);
  });
});

describe('loadKeys and Unlock', () => {
  test('the identity signs on its own; the vault\'s Base address shows while locked; Unlock, backup, Lock', async () => {
    const r = await newKeys({ identity: hex(a.entropyHex), vault: hex(b.entropyHex), nostr: fx.nostr.secretHex }, PASS);
    const k = loadKeys(r);
    expect(k.identity).toMatchObject({ pubkey: a.pubkey, evmAddress: a.ethAddress });
    expect(await verifyMessage({ address: a.ethAddress, message: 'c-0', signature: k.identity.signCentralLogin('c-0') })).toBe(true); // EIP-191
    expect(k.identity.backup()).toEqual({ words: a.words, privateKey: `0x${a.entropyHex}` });
    expect(k.nostr).toEqual({ secret: fx.nostr.secretHex, pubkey: fx.nostr.pubkeyHex });
    expect(k.vault).toEqual({ pubkey: b.pubkey, evmAddress: b.ethAddress });

    await expect(unlockVault(r, 'not it at all')).rejects.toThrow(/^Wrong passphrase$/);
    const { vault, record } = await unlockVault(r, PASS);
    expect(record).toBe(null); // already in this app's format: nothing to store
    expect(vault).toMatchObject({ pubkey: b.pubkey, evmAddress: b.ethAddress, locked: false });
    expect(vault.signCentralLogin).toBeUndefined(); // only the identity logs in to central
    expect(vault.backup()).toEqual({ words: b.words, privateKey: `0x${b.entropyHex}` });
    expect(vault.signDigest(new Uint8Array(32).fill(7))).toMatchObject({ yParity: expect.any(Number) });
    vault.lock();
    expect(vault.locked).toBe(true);
    expect(() => vault.backup()).toThrow(/locked/i);
    expect(() => vault.signDigest(new Uint8Array(32))).toThrow(/locked/i);
    expect(vault.evmAddress).toBe(b.ethAddress); // an address, not a secret: kept after Lock
  });
  test('a record from a newer app, or a broken one, is refused', async () => {
    const r = await newKeys({ vault: hex(b.entropyHex) }, PASS);
    expect(() => loadKeys({ ...r, v: 2 })).toThrow(/newer version/);
    expect(() => loadKeys({ ...r, identity: 'nope' })).toThrow();
    expect(() => loadKeys({ ...r, vault: { pubkey: b.pubkey } })).toThrow(/vault/);
  });
  test('a vault whose stored public key is not its key is refused at Unlock', async () => {
    const r = await newKeys({ vault: hex(b.entropyHex) }, PASS);
    await expect(unlockVault({ ...r, vault: { ...r.vault, pubkey: a.pubkey } }, PASS)).rejects.toThrow(/does not match/);
  });
});

describe('readDockerFiles: a Dockerized Neuron\'s files, translated', () => {
  const { password, wrongPassword } = fx.vaults;
  const current = fx.vectors[fx.vaults.current.vector];
  test('current files and nostr.yaml → the three secrets; the record has the same keys', async () => {
    const s = await readDockerFiles({ walletText: a.walletYaml, vaultText: fx.vaults.current.yaml, password, nostrText: fx.nostr.yaml });
    expect(s).toEqual({ identity: hex(a.entropyHex), vault: hex(current.entropyHex), nostr: fx.nostr.secretHex });
    const k = loadKeys(await newKeys(s, PASS));
    expect([k.identity.pubkey, k.vault.pubkey, k.nostr.pubkey]).toEqual([a.pubkey, current.pubkey, fx.nostr.pubkeyHex]);
    expect(k.vault.evmAddress).toBe(current.ethAddress); // the same Base address as the Docker neuron's
  });
  test('no nostr.yaml: no Nostr key, so newKeys makes one', async () => {
    const s = await readDockerFiles({ walletText: a.walletYaml, vaultText: fx.vaults.current.yaml, password });
    expect(s.nostr).toBeUndefined();
    expect(nostrPubkey((await newKeys(s, PASS)).nostr)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('an old vault (fields encrypted by length) and one with no plain publicKey', async () => {
    const old = await readDockerFiles({ walletText: a.walletYaml, vaultText: fx.vaults.old.yaml, password });
    expect(old.vault).toEqual(hex(fx.vectors[fx.vaults.old.vector].entropyHex));
    const noKey = fx.vaults.current.yaml.split('\n').filter((l) => !l.startsWith('publicKey:')).join('\n');
    expect((await readDockerFiles({ walletText: a.walletYaml, vaultText: noKey, password })).vault).toEqual(hex(current.entropyHex));
  });
  test('a Latin-1 password, as satorilib takes it', async () => {
    const s = await readDockerFiles({ walletText: a.walletYaml, vaultText: edges.latin1Vault.yaml, password: edges.latin1Vault.password });
    expect(publicKey(s.vault)).toMatch(/^0[23]/);
  });
  test('wrong password, a mismatched file, a watch-only file are refused', async () => {
    await expect(readDockerFiles({ walletText: a.walletYaml, vaultText: fx.vaults.current.yaml, password: wrongPassword }))
      .rejects.toThrow(/vault\.yaml: wrong passphrase/i);
    await expect(readDockerFiles({ walletText: fx.mismatch.yaml, vaultText: fx.vaults.current.yaml, password }))
      .rejects.toThrow(/wallet\.yaml: .*publicKey/);
    await expect(readDockerFiles({ walletText: `publicKey: ${a.pubkey}\n`, vaultText: fx.vaults.current.yaml, password }))
      .rejects.toThrow(/wallet\.yaml: no entropy/i);
  });
  test('files in the wrong slots are refused, and the message says which', async () => {
    const cur = fx.vaults.current.yaml;
    await expect(readDockerFiles({ walletText: cur, vaultText: a.walletYaml, password })).rejects.toThrow(/swapped/i);
    await expect(readDockerFiles({ walletText: cur, vaultText: fx.vaults.old.yaml, password }))
      .rejects.toThrow(/wallet\.yaml: .*encrypted.*vault\.yaml/i);
    await expect(readDockerFiles({ walletText: a.walletYaml, vaultText: b.walletYaml, password }))
      .rejects.toThrow(/vault\.yaml: .*not encrypted/i);
  });
  test('a vault Docker saved unencrypted (password outside Latin-1) is refused', async () => {
    await expect(readDockerFiles({ walletText: a.walletYaml, vaultText: edges.nonLatin1Password.savedYaml, password: 'p€ss' }))
      .rejects.toThrow(/vault\.yaml: .*not encrypted/i);
  });
  test('the same key twice, and a bad nostr.yaml, are refused', async () => {
    const files = { walletText: current.walletYaml, vaultText: fx.vaults.current.yaml, password };
    await expect(readDockerFiles(files)).rejects.toThrow(/same key/i);
    await expect(readDockerFiles({ ...files, walletText: a.walletYaml, nostrText: 'secret_hex: 00\n' })).rejects.toThrow(/nostr.yaml/);
  });
});

describe('every earlier version\'s keys (test/fixtures/profiles.json) carried forward', () => {
  for (const p of profiles.filter((x) => x.meta.wallet_yaml && x.meta.vault_yaml && !x.label.includes('plain-text vault'))) {
    test(p.label, async () => {
      const rows = { walletYaml: p.meta.wallet_yaml, vaultYaml: p.meta.vault_yaml, nostrYaml: p.meta.nostr_yaml };
      const record = await recordFromRows(rows);
      // At load: the identity and the Nostr key translated; the vault kept as it was, its public key in clear when it had one.
      expect(record).toMatchObject({ v: 1, identity: p.expect.identity, vault: { yaml: p.meta.vault_yaml } });
      if (p.expect.nostr) expect(record.nostr).toBe(p.expect.nostr);
      else expect(nostrPubkey(record.nostr)).toMatch(/^[0-9a-f]{64}$/); // made now, as the load before step 5 did
      const vaultPub = publicKey(hex(p.expect.vault));
      const noPlainKey = p.commit === '8996f24';
      expect(loadKeys(record).vault).toEqual(noPlainKey ? { pubkey: null, evmAddress: null } : { pubkey: vaultPub, evmAddress: evmAddress(vaultPub) });
      expect(loadKeys(record).identity.pubkey).toBe(publicKey(hex(p.expect.identity)));

      // The next Unlock: the vault re-encrypted in this app's format, with the same passphrase.
      await expect(unlockVault(record, 'not the passphrase')).rejects.toThrow(/^Wrong passphrase$/);
      const first = await unlockVault(record, p.passphrase);
      expect(first.vault.backup().words).toBe(wordsOf(hex(p.expect.vault)));
      expect(first.record).toEqual({ ...record, vault: { pubkey: vaultPub, kdf: expect.any(Object), cipher: expect.any(Object), data: expect.any(String) } });
      const again = await unlockVault(first.record, p.passphrase);
      expect(again.record).toBe(null);
      expect(again.vault.pubkey).toBe(vaultPub);
    });
  }
  test('a plain-text vault an early import kept is encrypted at its next Unlock, with a passphrase that meets the rule', async () => {
    const p = profiles.find((x) => x.label.includes('plain-text vault.yaml'));
    const record = await recordFromRows({ walletYaml: p.meta.wallet_yaml, vaultYaml: p.meta.vault_yaml });
    await expect(unlockVault(record, 'short')).rejects.toThrow(/at least 8/);
    const { record: upgraded } = await unlockVault(record, p.passphrase);
    await expect(unlockVault(upgraded, 'another one entirely')).rejects.toThrow(/^Wrong passphrase$/);
    expect((await unlockVault(upgraded, p.passphrase)).vault.pubkey).toBe(publicKey(hex(p.expect.vault)));
  });
});
