// Docker's files, read only: the Dockerized Neuron's wallet.yaml / vault.yaml /
// nostr.yaml (the import), and this app's own earlier rows, which were those
// texts (the forward migration). satorilib's wallet KDF is PBKDF2-SHA1 × 1,000,000
// per field, so wallet tests are slow (~1-2 s each).
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { readKeyFile, decryptField, secrecy, readNostrYaml, walletPubkey } from './docker.js';

vi.setConfig({ testTimeout: 180_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/alias-parity.json', import.meta.url)));
const jsfx = JSON.parse(readFileSync(new URL('../../test/fixtures/alias-js.json', import.meta.url)));
const edges = JSON.parse(readFileSync(new URL('../../test/fixtures/satorilib-edges.json', import.meta.url)));
const { profiles } = JSON.parse(readFileSync(new URL('../../test/fixtures/profiles.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const vec = (i) => fx.vectors[i];
const { password, wrongPassword } = fx.wallets;
/** A wallet.yaml with only the WIF, no entropy: satorilib itself fails to load one. */
const wifOnly = (v) => v.walletYaml.replace(/^entropy: .*\n/m, '');

describe('wallet.yaml (plaintext)', () => {
  test('reads every satorilib vector with no mismatch', async () => {
    for (const v of fx.vectors) {
      const r = await readKeyFile(v.walletYaml);
      expect(r).toEqual({ secret: hex(v.entropyHex), pubkey: v.pubkey, mismatches: [] });
    }
  });
  test('the key is the entropy: a file without one (watch-only, or a WIF only, which satorilib cannot load either) is refused', async () => {
    await expect(readKeyFile(wifOnly(vec(3)))).rejects.toThrow(/no entropy/i);
  });
  test('a stored public key that is not the key\'s is reported (compared by public key and words)', async () => {
    const r = await readKeyFile(fx.mismatch.yaml);
    expect(r.pubkey).toBe(vec(fx.mismatch.vector).pubkey);
    expect(r.mismatches).toEqual(fx.mismatch.fields);
    const words = await readKeyFile(vec(0).walletYaml.replace(/^words: \w+/m, 'words: zoo'));
    expect(words.mismatches).toEqual(['words']);
  });
  test("Docker's other fields are not read: a wrong nested address, scripthash or WIF privateKey is no mismatch", async () => {
    const text = vec(0).walletYaml.replace(/^( {2}address: ).*$/m, '$1EOtherAddressXXXXXXXXXXXXXXXXXXXXX')
      .replace(/^(scripthash: ).*$/m, `$1${'00'.repeat(32)}`).replace(/^(privateKey: ).*$/m, `$1${vec(1).walletYaml.match(/^privateKey: (.*)$/m)[1]}`);
    expect(text).not.toBe(vec(0).walletYaml);
    expect(await readKeyFile(text)).toEqual({ secret: hex(vec(0).entropyHex), pubkey: vec(0).pubkey, mismatches: [] });
  });
  test('watch-only and empty files are refused', async () => {
    await expect(readKeyFile(`publicKey: ${vec(0).pubkey}\nscripthash: ${'00'.repeat(32)}\n`)).rejects.toThrow(/no entropy/i);
    await expect(readKeyFile('')).rejects.toThrow(/no entropy/i);
    await expect(readKeyFile('a: [')).rejects.toThrow();
  });
  test('an encrypted file without a passphrase is refused', async () => {
    await expect(readKeyFile(fx.wallets.current.yaml)).rejects.toThrow(/encrypted/i);
  });
  test('a plain-text file read as a wallet is refused, whatever the passphrase', async () => {
    await expect(readKeyFile(vec(0).walletYaml, { password: 'anything' })).rejects.toThrow(/not encrypted/i);
    await expect(readKeyFile(wifOnly(vec(3)), { password: 'anything' })).rejects.toThrow(/not encrypted/i);
  });
});

describe('secrecy: which a file is, by its secret fields (satorilib length rules)', () => {
  test('plain, encrypted, mixed, or no key at all', () => {
    expect(secrecy(vec(0).walletYaml)).toBe('plain');
    expect(secrecy(wifOnly(vec(3)))).toBe('plain');
    expect(secrecy(fx.wallets.current.yaml)).toBe('encrypted');
    expect(secrecy(fx.wallets.old.yaml)).toBe('encrypted');
    expect(secrecy(`entropy: ${vec(0).entropy}\nwords: ${load(fx.wallets.current.yaml).words}\n`)).toBe('mixed');
    expect(secrecy(`publicKey: ${vec(0).pubkey}\n`)).toBe('');
    expect(secrecy('')).toBe('');
  });
});

describe('vault.yaml (satorilib: AES-256-CBC, PBKDF2-SHA1 1e6, the password as Latin-1 bytes)', () => {
  test('a field encrypted by Python', async () => {
    const cur = load(fx.wallets.current.yaml);
    expect(await decryptField(cur.entropy, password)).toBe(vec(fx.wallets.current.vector).entropy);
  });
  test('current wallet reads with its password', async () => {
    const r = await readKeyFile(fx.wallets.current.yaml, { password });
    expect(r).toEqual({ secret: hex(vec(fx.wallets.current.vector).entropyHex), pubkey: vec(fx.wallets.current.vector).pubkey, mismatches: [] });
  });
  test('old wallet: the length rule decrypts its publicKey to compare', async () => {
    const r = await readKeyFile(fx.wallets.old.yaml, { password });
    expect(r.secret).toEqual(hex(vec(fx.wallets.old.vector).entropyHex));
    expect(r.mismatches).toEqual([]);
  });
  test('a Latin-1 password is one byte per character, as satorilib (pycryptodome) takes it', async () => {
    const r = await readKeyFile(edges.latin1Wallet.yaml, { password: edges.latin1Wallet.password });
    expect(r.mismatches).toEqual([]);
  });
  test('a password outside Latin-1 cannot open a satorilib wallet (satorilib cannot encrypt with one)', async () => {
    await expect(readKeyFile(fx.wallets.current.yaml, { password: 'p€ss' })).rejects.toThrow(/wrong passphrase/i);
  });
  test('a wrong password fails on the entropy', async () => {
    await expect(readKeyFile(fx.wallets.current.yaml, { password: wrongPassword })).rejects.toThrow(/wrong passphrase/i);
  });
  test('a wallet this app wrote in Docker\'s format (accepted by satorilib) reads back', async () => {
    expect(jsfx.satorilibVerified?.wallet).toBe(true);
    const r = await readKeyFile(jsfx.wallet.yaml, { password: jsfx.wallet.password });
    expect(r.mismatches).toEqual([]);
  });
  test("this app's 2026-10-15 06:29-14:04 wallets took the passphrase as UTF-8: they open only when UTF-8 is allowed", async () => {
    for (const p of profiles.filter((x) => x.label.includes('as UTF-8 bytes'))) {
      await expect(readKeyFile(p.meta.vault_yaml, { password: p.passphrase }), p.label).rejects.toThrow(/wrong passphrase/i);
      const r = await readKeyFile(p.meta.vault_yaml, { password: p.passphrase, encodings: ['latin1', 'utf8'] });
      expect(r.secret).toEqual(hex(p.expect.wallet));
      expect(r.mismatches).toEqual([]);
    }
  });
  test('walletPubkey: a wallet\'s plain public key, read without the password; null if encrypted or missing', () => {
    expect(walletPubkey(fx.wallets.current.yaml)).toBe(vec(fx.wallets.current.vector).pubkey);
    expect(walletPubkey(fx.wallets.old.yaml)).toBe(null);
    expect(walletPubkey(fx.wallets.current.yaml.split('\n').filter((l) => !l.startsWith('publicKey:')).join('\n'))).toBe(null);
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
