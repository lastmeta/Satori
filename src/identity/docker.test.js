// Docker interop: wallet.yaml / vault.yaml / nostr.yaml. Docker's vault KDF is
// PBKDF2-SHA1 × 1,000,000 per field, so the vault tests are slow (~1-2 s each).
import { describe, expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import {
  importDockerWallet, exportDockerWallet, importNostrYaml, exportNostrYaml,
  decryptField, encryptField, importSecret,
} from './docker.js';

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-parity.json', import.meta.url)));
const jsfx = JSON.parse(readFileSync(new URL('../../test/fixtures/identity-js.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const vec = (i) => fx.vectors[i];
const { password, wrongPassword } = fx.vaults;
const SLOW = 180_000;

describe('wallet.yaml (plaintext)', () => {
  test('imports every vector and finds no mismatch', async () => {
    for (const v of fx.vectors) {
      const r = await importDockerWallet(v.walletYaml);
      expect(r.entropy).toEqual(hex(v.entropyHex));
      expect(r.keys.address).toBe(v.address);
      expect(r.mismatches).toEqual([]);
    }
  });
  test('WIF-only file (satorilib itself cannot load it) imports from the WIF', async () => {
    const r = await importDockerWallet(fx.wifOnly.yaml);
    expect(r.entropy).toEqual(hex(vec(fx.wifOnly.vector).entropyHex));
    expect(r.mismatches).toEqual([]);
  });
  test('reports stored values that do not match the entropy', async () => {
    const r = await importDockerWallet(fx.mismatch.yaml);
    expect(r.keys.address).toBe(vec(fx.mismatch.vector).address);
    expect(r.mismatches).toEqual(fx.mismatch.fields);
  });
  test('watch-only file is refused', async () => {
    const v = vec(0);
    await expect(importDockerWallet(`publicKey: ${v.pubkey}\nevr:\n  address: ${v.address}\n`)).rejects.toThrow(/no private key/i);
  });
  test('encrypted file without a password is refused', async () => {
    await expect(importDockerWallet(fx.vaults.current.yaml)).rejects.toThrow(/password/i);
  });
  test('export without a password loads back and keeps Docker keys', async () => {
    const v = vec(0);
    const text = await exportDockerWallet(hex(v.entropyHex));
    expect(load(text)).toEqual(load(v.walletYaml));
  });
});

describe('vault.yaml (AES-CBC, PBKDF2-SHA1 1e6)', () => {
  test('field round trip and Python-encrypted field', async () => {
    const enc = await encryptField('hello vault', 'pw');
    expect(await decryptField(enc, 'pw')).toBe('hello vault');
    const cur = load(fx.vaults.current.yaml);
    expect(await decryptField(cur.entropy, password)).toBe(vec(fx.vaults.current.vector).entropy);
  }, SLOW);

  test('current vault: only entropy encrypted among compared fields', async () => {
    const r = await importDockerWallet(fx.vaults.current.yaml, { password });
    expect(r.entropy).toEqual(hex(vec(fx.vaults.current.vector).entropyHex));
    expect(r.mismatches).toEqual([]);
  }, SLOW);

  test('old vault: length rule decrypts publicKey, scripthash, evr.address', async () => {
    const r = await importDockerWallet(fx.vaults.old.yaml, { password });
    const v = vec(fx.vaults.old.vector);
    expect(r.entropy).toEqual(hex(v.entropyHex));
    expect(r.keys.pubkey).toBe(v.pubkey);
    expect(r.mismatches).toEqual([]);
  }, SLOW);

  test('wrong password fails on entropy', async () => {
    await expect(importDockerWallet(fx.vaults.current.yaml, { password: wrongPassword })).rejects.toThrow(/wrong password/i);
  }, SLOW);

  test('JS-exported vault (accepted by satorilib) imports in JS', async () => {
    expect(jsfx.satorilibVerified?.vault).toBe(true);
    const r = await importDockerWallet(jsfx.vault.yaml, { password: jsfx.vault.password });
    expect(r.keys.address).toBe(jsfx.vault.address);
    expect(r.mismatches).toEqual([]);
  }, SLOW);

  test('export with password encrypts entropy, privateKey, words only', async () => {
    const v = vec(0);
    const doc = load(await exportDockerWallet(hex(v.entropyHex), { password: 'pw' }));
    expect(doc.publicKey).toBe(v.pubkey);
    expect(doc.scripthash).toBe(v.scripthash);
    expect(doc.evr.address).toBe(v.address);
    expect(doc.entropy).not.toBe(v.entropy);
    expect(await decryptField(doc.words, 'pw')).toBe(v.words);
  }, SLOW);
});

describe('nostr.yaml', () => {
  test('import checks pubkey against secret', () => {
    expect(importNostrYaml(fx.nostr.yaml)).toEqual({ secretHex: fx.nostr.secretHex, pubkeyHex: fx.nostr.pubkeyHex });
    const bad = fx.nostr.yaml.replace(fx.nostr.pubkeyHex, '00'.repeat(32));
    expect(() => importNostrYaml(bad)).toThrow(/does not match/);
  });
  test('export matches Docker byte for byte', () => {
    expect(exportNostrYaml(fx.nostr.secretHex)).toBe(fx.nostr.yaml);
  });
});

describe('importSecret: words or WIF', () => {
  test('both forms', () => {
    const v = vec(3);
    expect(importSecret(v.words)).toEqual(hex(v.entropyHex));
    expect(importSecret(` ${v.wif}\n`)).toEqual(hex(v.entropyHex));
    expect(() => importSecret('nonsense')).toThrow();
  });
});
