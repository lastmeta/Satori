// Docker files: wallet.yaml / vault.yaml as satorilib reads and writes them.
// Docker's vault KDF is PBKDF2-SHA1 × 1,000,000 per field, so vault tests are slow (~1-2 s each).
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { readWallet, writeWallet, decryptField, encryptField, secrecy, readNostrYaml, writeNostrYaml } from './docker.js';

vi.setConfig({ testTimeout: 180_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const jsfx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-js.json', import.meta.url)));
const edges = JSON.parse(readFileSync(new URL('../../test/fixtures/satorilib-edges.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const vec = (i) => fx.vectors[i];
const { password, wrongPassword } = fx.vaults;

describe('wallet.yaml (plaintext)', () => {
  test('reads every satorilib vector with no mismatch', async () => {
    for (const v of fx.vectors) {
      const r = await readWallet(v.walletYaml);
      expect(r.entropy).toEqual(hex(v.entropyHex));
      expect(r.keys).toMatchObject({ address: v.address, pubkey: v.pubkey, wif: v.wif, scripthash: v.scripthash, words: v.words });
      expect(r.mismatches).toEqual([]);
    }
  });
  test('a WIF-only file (satorilib itself fails on it) reads from the WIF', async () => {
    const r = await readWallet(fx.wifOnly.yaml);
    expect(r.entropy).toEqual(hex(vec(fx.wifOnly.vector).entropyHex));
    expect(r.mismatches).toEqual([]);
  });
  test('stored values that do not match the entropy are reported', async () => {
    const r = await readWallet(fx.mismatch.yaml);
    expect(r.keys.address).toBe(vec(fx.mismatch.vector).address);
    expect(r.mismatches).toEqual(fx.mismatch.fields);
  });
  test('watch-only and empty files are refused', async () => {
    const v = vec(0);
    await expect(readWallet(`publicKey: ${v.pubkey}\nevr:\n  address: ${v.address}\n`)).rejects.toThrow(/no private key/i);
    await expect(readWallet('')).rejects.toThrow(/no private key/i);
    await expect(readWallet('a: [')).rejects.toThrow();
  });
  test('an encrypted file without a passphrase is refused', async () => {
    await expect(readWallet(fx.vaults.current.yaml)).rejects.toThrow(/encrypted/i);
  });
  test('a plain-text file read as a vault is refused, whatever the passphrase', async () => {
    await expect(readWallet(vec(0).walletYaml, { password: 'anything' })).rejects.toThrow(/not encrypted/i);
    await expect(readWallet(fx.wifOnly.yaml, { password: 'anything' })).rejects.toThrow(/not encrypted/i);
  });
  test('written without a passphrase it equals what satorilib writes', async () => {
    for (const v of fx.vectors) expect(load(await writeWallet(hex(v.entropyHex)))).toEqual(load(v.walletYaml));
  });
});

describe('secrecy: which a file is, by its secret fields (satorilib length rules)', () => {
  test('plain, encrypted, mixed, or no key at all', () => {
    expect(secrecy(vec(0).walletYaml)).toBe('plain');
    expect(secrecy(fx.wifOnly.yaml)).toBe('plain');
    expect(secrecy(fx.vaults.current.yaml)).toBe('encrypted');
    expect(secrecy(fx.vaults.old.yaml)).toBe('encrypted');
    expect(secrecy(`entropy: ${vec(0).entropy}\nwords: ${load(fx.vaults.current.yaml).words}\n`)).toBe('mixed');
    expect(secrecy(`publicKey: ${vec(0).pubkey}\n`)).toBe('');
    expect(secrecy('')).toBe('');
  });
});

describe('vault.yaml (AES-256-CBC, PBKDF2-SHA1 1e6)', () => {
  test('field round trip, and a field encrypted by Python', async () => {
    expect(await decryptField(await encryptField('hello vault', 'pw'), 'pw')).toBe('hello vault');
    const cur = load(fx.vaults.current.yaml);
    expect(await decryptField(cur.entropy, password)).toBe(vec(fx.vaults.current.vector).entropy);
  });
  test('current vault reads with its password', async () => {
    const r = await readWallet(fx.vaults.current.yaml, { password });
    expect(r.entropy).toEqual(hex(vec(fx.vaults.current.vector).entropyHex));
    expect(r.mismatches).toEqual([]);
  });
  test('old vault: the length rule decrypts publicKey, scripthash and evr.address', async () => {
    const r = await readWallet(fx.vaults.old.yaml, { password });
    expect(r.entropy).toEqual(hex(vec(fx.vaults.old.vector).entropyHex));
    expect(r.mismatches).toEqual([]);
  });
  test('a Latin-1 password is one byte per character, as satorilib (pycryptodome) takes it', async () => {
    const r = await readWallet(edges.latin1Vault.yaml, { password: edges.latin1Vault.password });
    expect(r.keys.address).toBe(edges.latin1Vault.address);
    expect(r.mismatches).toEqual([]);
  });
  test('a password outside Latin-1 cannot encrypt or open a vault (satorilib cannot either)', async () => {
    await expect(encryptField('x', 'p€ss')).rejects.toThrow(/Latin-1/);
    await expect(readWallet(fx.vaults.current.yaml, { password: 'p€ss' })).rejects.toThrow(/wrong passphrase/i);
  });
  test('a wrong password fails on the entropy', async () => {
    await expect(readWallet(fx.vaults.current.yaml, { password: wrongPassword })).rejects.toThrow(/wrong passphrase/i);
  });
  test('a vault written by this code (accepted by satorilib) reads back', async () => {
    expect(jsfx.satorilibVerified?.vault).toBe(true);
    const r = await readWallet(jsfx.vault.yaml, { password: jsfx.vault.password });
    expect(r.keys.address).toBe(jsfx.vault.address);
    expect(r.mismatches).toEqual([]);
  });
  test('written with a passphrase: entropy, privateKey and words encrypted, the rest plain', async () => {
    const v = vec(0);
    const doc = load(await writeWallet(hex(v.entropyHex), { password: 'pw' }));
    expect(doc).toMatchObject({ publicKey: v.pubkey, scripthash: v.scripthash, evr: { address: v.address } });
    expect(await decryptField(doc.entropy, 'pw')).toBe(v.entropy);
    expect(await decryptField(doc.privateKey, 'pw')).toBe(v.wif);
    expect(await decryptField(doc.words, 'pw')).toBe(v.words);
  });
});

describe('nostr.yaml (Satori Lite start.py:120-149)', () => {
  test('reads the satorilib fixture and writes it back byte for byte', () => {
    expect(readNostrYaml(fx.nostr.yaml)).toEqual({ secretHex: fx.nostr.secretHex, pubkeyHex: fx.nostr.pubkeyHex });
    expect(writeNostrYaml(fx.nostr.secretHex)).toBe(fx.nostr.yaml);
  });
  test('a pubkey that is not the secret’s, no secret, or a bad secret is refused', () => {
    expect(() => readNostrYaml(fx.nostr.yaml.replace(fx.nostr.pubkeyHex, '00'.repeat(32)))).toThrow(/does not match/);
    expect(() => readNostrYaml(`pubkey_hex: ${fx.nostr.pubkeyHex}\n`)).toThrow(/secret_hex/);
    expect(() => readNostrYaml('secret_hex: nope\n')).toThrow(/secret_hex/);
    expect(() => readNostrYaml('- a list\n')).toThrow();
  });
  test('upper case and no pubkey_hex are accepted', () => {
    expect(readNostrYaml(`secret_hex: ${fx.nostr.secretHex.toUpperCase()}\n`).pubkeyHex).toBe(fx.nostr.pubkeyHex);
  });
});
