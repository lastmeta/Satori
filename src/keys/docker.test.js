// Docker's files, read only: the Dockerized Neuron's wallet.yaml / vault.yaml /
// nostr.yaml (the import), and this app's own earlier rows, which were those
// texts (the forward migration). satorilib's vault KDF is PBKDF2-SHA1 × 1,000,000
// per field, so vault tests are slow (~1-2 s each).
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { readWallet, decryptField, secrecy, readNostrYaml, vaultPubkey } from './docker.js';

vi.setConfig({ testTimeout: 180_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const jsfx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-js.json', import.meta.url)));
const edges = JSON.parse(readFileSync(new URL('../../test/fixtures/satorilib-edges.json', import.meta.url)));
const { profiles } = JSON.parse(readFileSync(new URL('../../test/fixtures/profiles.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const vec = (i) => fx.vectors[i];
const { password, wrongPassword } = fx.vaults;
/** A wallet.yaml with only the WIF, no entropy: satorilib itself fails to load one. */
const wifOnly = (v) => v.walletYaml.replace(/^entropy: .*\n/m, '');

describe('wallet.yaml (plaintext)', () => {
  test('reads every satorilib vector with no mismatch', async () => {
    for (const v of fx.vectors) {
      const r = await readWallet(v.walletYaml);
      expect(r).toEqual({ secret: hex(v.entropyHex), pubkey: v.pubkey, mismatches: [] });
    }
  });
  test('the key is the entropy: a file without one (watch-only, or a WIF only, which satorilib cannot load either) is refused', async () => {
    await expect(readWallet(wifOnly(vec(3)))).rejects.toThrow(/no entropy/i);
  });
  test('a stored public key that is not the key\'s is reported (compared by public key and words)', async () => {
    const r = await readWallet(fx.mismatch.yaml);
    expect(r.pubkey).toBe(vec(fx.mismatch.vector).pubkey);
    expect(r.mismatches).toEqual(fx.mismatch.fields);
    const words = await readWallet(vec(0).walletYaml.replace(/^words: \w+/m, 'words: zoo'));
    expect(words.mismatches).toEqual(['words']);
  });
  test("Docker's other fields are not read: a wrong nested address, scripthash or WIF privateKey is no mismatch", async () => {
    const text = vec(0).walletYaml.replace(/^( {2}address: ).*$/m, '$1EOtherAddressXXXXXXXXXXXXXXXXXXXXX')
      .replace(/^(scripthash: ).*$/m, `$1${'00'.repeat(32)}`).replace(/^(privateKey: ).*$/m, `$1${vec(1).walletYaml.match(/^privateKey: (.*)$/m)[1]}`);
    expect(text).not.toBe(vec(0).walletYaml);
    expect(await readWallet(text)).toEqual({ secret: hex(vec(0).entropyHex), pubkey: vec(0).pubkey, mismatches: [] });
  });
  test('watch-only and empty files are refused', async () => {
    await expect(readWallet(`publicKey: ${vec(0).pubkey}\nscripthash: ${'00'.repeat(32)}\n`)).rejects.toThrow(/no entropy/i);
    await expect(readWallet('')).rejects.toThrow(/no entropy/i);
    await expect(readWallet('a: [')).rejects.toThrow();
  });
  test('an encrypted file without a passphrase is refused', async () => {
    await expect(readWallet(fx.vaults.current.yaml)).rejects.toThrow(/encrypted/i);
  });
  test('a plain-text file read as a vault is refused, whatever the passphrase', async () => {
    await expect(readWallet(vec(0).walletYaml, { password: 'anything' })).rejects.toThrow(/not encrypted/i);
    await expect(readWallet(wifOnly(vec(3)), { password: 'anything' })).rejects.toThrow(/not encrypted/i);
  });
});

describe('secrecy: which a file is, by its secret fields (satorilib length rules)', () => {
  test('plain, encrypted, mixed, or no key at all', () => {
    expect(secrecy(vec(0).walletYaml)).toBe('plain');
    expect(secrecy(wifOnly(vec(3)))).toBe('plain');
    expect(secrecy(fx.vaults.current.yaml)).toBe('encrypted');
    expect(secrecy(fx.vaults.old.yaml)).toBe('encrypted');
    expect(secrecy(`entropy: ${vec(0).entropy}\nwords: ${load(fx.vaults.current.yaml).words}\n`)).toBe('mixed');
    expect(secrecy(`publicKey: ${vec(0).pubkey}\n`)).toBe('');
    expect(secrecy('')).toBe('');
  });
});

describe('vault.yaml (satorilib: AES-256-CBC, PBKDF2-SHA1 1e6, the password as Latin-1 bytes)', () => {
  test('a field encrypted by Python', async () => {
    const cur = load(fx.vaults.current.yaml);
    expect(await decryptField(cur.entropy, password)).toBe(vec(fx.vaults.current.vector).entropy);
  });
  test('current vault reads with its password', async () => {
    const r = await readWallet(fx.vaults.current.yaml, { password });
    expect(r).toEqual({ secret: hex(vec(fx.vaults.current.vector).entropyHex), pubkey: vec(fx.vaults.current.vector).pubkey, mismatches: [] });
  });
  test('old vault: the length rule decrypts its publicKey to compare', async () => {
    const r = await readWallet(fx.vaults.old.yaml, { password });
    expect(r.secret).toEqual(hex(vec(fx.vaults.old.vector).entropyHex));
    expect(r.mismatches).toEqual([]);
  });
  test('a Latin-1 password is one byte per character, as satorilib (pycryptodome) takes it', async () => {
    const r = await readWallet(edges.latin1Vault.yaml, { password: edges.latin1Vault.password });
    expect(r.mismatches).toEqual([]);
  });
  test('a password outside Latin-1 cannot open a satorilib vault (satorilib cannot encrypt with one)', async () => {
    await expect(readWallet(fx.vaults.current.yaml, { password: 'p€ss' })).rejects.toThrow(/wrong passphrase/i);
  });
  test('a wrong password fails on the entropy', async () => {
    await expect(readWallet(fx.vaults.current.yaml, { password: wrongPassword })).rejects.toThrow(/wrong passphrase/i);
  });
  test('a vault this app wrote in Docker\'s format (accepted by satorilib) reads back', async () => {
    expect(jsfx.satorilibVerified?.vault).toBe(true);
    const r = await readWallet(jsfx.vault.yaml, { password: jsfx.vault.password });
    expect(r.mismatches).toEqual([]);
  });
  test("this app's 2026-10-15 06:29-14:04 vaults took the passphrase as UTF-8: they open only when UTF-8 is allowed", async () => {
    for (const p of profiles.filter((x) => x.label.includes('as UTF-8 bytes'))) {
      await expect(readWallet(p.meta.vault_yaml, { password: p.passphrase }), p.label).rejects.toThrow(/wrong passphrase/i);
      const r = await readWallet(p.meta.vault_yaml, { password: p.passphrase, encodings: ['latin1', 'utf8'] });
      expect(r.secret).toEqual(hex(p.expect.vault));
      expect(r.mismatches).toEqual([]);
    }
  });
  test('vaultPubkey: a vault\'s plain public key, read without the password; null if encrypted or missing', () => {
    expect(vaultPubkey(fx.vaults.current.yaml)).toBe(vec(fx.vaults.current.vector).pubkey);
    expect(vaultPubkey(fx.vaults.old.yaml)).toBe(null);
    expect(vaultPubkey(fx.vaults.current.yaml.split('\n').filter((l) => !l.startsWith('publicKey:')).join('\n'))).toBe(null);
  });
});

describe('nostr.yaml (Satori Lite start.py:120-149)', () => {
  test('reads the satorilib fixture', () => {
    expect(readNostrYaml(fx.nostr.yaml)).toEqual({ secret: fx.nostr.secretHex, pubkey: fx.nostr.pubkeyHex });
  });
  test('a pubkey that is not the secret’s, no secret, or a bad secret is refused', () => {
    expect(() => readNostrYaml(fx.nostr.yaml.replace(fx.nostr.pubkeyHex, '00'.repeat(32)))).toThrow(/does not match/);
    expect(() => readNostrYaml(`pubkey_hex: ${fx.nostr.pubkeyHex}\n`)).toThrow(/secret_hex/);
    expect(() => readNostrYaml('secret_hex: nope\n')).toThrow(/secret_hex/);
    expect(() => readNostrYaml('- a list\n')).toThrow();
  });
  test('upper case and no pubkey_hex are accepted', () => {
    expect(readNostrYaml(`secret_hex: ${fx.nostr.secretHex.toUpperCase()}\n`).pubkey).toBe(fx.nostr.pubkeyHex);
  });
});
