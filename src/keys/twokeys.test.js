// The two-key model in this app's own record (docs/design/keys.md): the
// alias and the Nostr key in plain text (the neuron signs on its own), the
// wallet encrypted with the passphrase; Docker's files translated in; this
// app's earlier rows carried forward.
import { recoverMessageAddress } from 'viem';
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  newKeys, readDockerFiles, recordFromRows, loadKeys, unlockWallet, publicKey, wordsOf, evmAddress, withPassphrase, backupKeys, IMPORT_MAX,
  PASSPHRASE_NEEDED,
} from './index.js';
import { verifyMessage } from 'viem';
import { nostrPubkey } from '../nostr/event.js';

vi.setConfig({ testTimeout: 180_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/alias-parity.json', import.meta.url)));
const edges = JSON.parse(readFileSync(new URL('../../test/fixtures/satorilib-edges.json', import.meta.url)));
const { profiles } = JSON.parse(readFileSync(new URL('../../test/fixtures/profiles.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const [a, b] = fx.vectors;
const PASS = 'correct horse battery';

describe('newKeys: the record', () => {
  test('alias and Nostr key in plain text (hex), the wallet sealed with its public key in clear; nothing of Docker\'s', async () => {
    const r = await newKeys({ alias: hex(a.entropyHex), wallet: hex(b.entropyHex), nostr: fx.nostr.secretHex }, PASS);
    expect(r).toEqual({
      v: 1, created: expect.any(Number), alias: a.entropyHex, nostr: fx.nostr.secretHex,
      wallet: { pubkey: b.pubkey, kdf: expect.objectContaining({ name: 'PBKDF2', hash: 'SHA-256' }),
        cipher: expect.objectContaining({ name: 'AES-GCM' }), data: expect.any(String) },
      link: { message: expect.any(String), signature: expect.stringMatching(/^0x[0-9a-f]{130}$/) },
    });
    // the wallet's link to the alias (docs/design/wallets.md): its fixed text, signed by the wallet (EIP-191)
    const [title, alias, wallet, issued] = r.link.message.split('\n');
    expect([title, alias, wallet]).toEqual(['Satori: link this alias to my wallet', `alias: ${a.ethAddress}`, `wallet: ${b.ethAddress}`]);
    expect(Number(issued.slice('issued: '.length))).toBe(r.created);
    expect(await recoverMessageAddress({ message: r.link.message, signature: r.link.signature })).toBe(b.ethAddress);
    expect(Math.abs(r.created - Date.now() / 1000)).toBeLessThan(60); // when these keys were made: Home's first day
    expect(JSON.stringify(r)).not.toMatch(/yaml|address|wif|scripthash|words/i);
    expect(JSON.stringify(r)).not.toContain(b.entropyHex);
  });
  test('a new random alias and Nostr key when not given', async () => {
    const one = await newKeys({ wallet: hex(b.entropyHex) }, PASS);
    const two = await newKeys({ wallet: hex(b.entropyHex) }, PASS);
    expect(one.alias).not.toBe(two.alias);
    expect(one.nostr).not.toBe(two.nostr);
    expect(one.alias).not.toBe(b.entropyHex);
    expect(nostrPubkey(one.nostr)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('passphrase: at least 8 characters, any Unicode', async () => {
    await expect(newKeys({ wallet: hex(b.entropyHex) }, 'seven c')).rejects.toThrow(/at least 8/);
    await expect(newKeys({ wallet: hex(b.entropyHex) }, '密码密码')).rejects.toThrow(/at least 8/);
    for (const p of ['密码密码密码密码', '🔑🦊🌕🚀🔑🦊🌕🚀', 'p€ss w€rd']) {
      const r = await newKeys({ wallet: hex(b.entropyHex) }, p);
      expect((await unlockWallet(r, p)).wallet.pubkey, p).toBe(b.pubkey);
    }
  });
  test('the alias and the wallet must differ; a bad Nostr key is refused', async () => {
    await expect(newKeys({ alias: hex(a.entropyHex), wallet: hex(a.entropyHex) }, PASS)).rejects.toThrow(/same key/i);
    await expect(newKeys({ wallet: hex(b.entropyHex), nostr: '00' }, PASS)).rejects.toThrow(/Nostr/);
  });
});

describe('loadKeys and Unlock', () => {
  test('the alias signs on its own; the wallet\'s Base address shows while locked; Unlock, backup, Lock', async () => {
    const r = await newKeys({ alias: hex(a.entropyHex), wallet: hex(b.entropyHex), nostr: fx.nostr.secretHex }, PASS);
    const k = loadKeys(r);
    expect(k.alias).toMatchObject({ pubkey: a.pubkey, evmAddress: a.ethAddress });
    expect(await verifyMessage({ address: a.ethAddress, message: 'c-0', signature: k.alias.signCentralLogin('c-0') })).toBe(true); // EIP-191
    expect(k.alias.backup()).toEqual({ words: a.words, privateKey: `0x${a.entropyHex}` });
    expect(k.nostr).toEqual({ secret: fx.nostr.secretHex, pubkey: fx.nostr.pubkeyHex });
    expect(k.wallet).toEqual({ pubkey: b.pubkey, evmAddress: b.ethAddress, connected: null });

    await expect(unlockWallet(r, 'not it at all')).rejects.toThrow(/^Wrong passphrase$/);
    const { wallet, record } = await unlockWallet(r, PASS);
    expect(record).toBe(null); // already in this app's format: nothing to store
    expect(wallet).toMatchObject({ pubkey: b.pubkey, evmAddress: b.ethAddress, locked: false });
    expect(wallet.signCentralLogin).toBeUndefined(); // only the alias logs in to central
    expect(wallet.backup()).toEqual({ words: b.words, privateKey: `0x${b.entropyHex}` });
    expect(wallet.signDigest(new Uint8Array(32).fill(7))).toMatchObject({ yParity: expect.any(Number) });
    wallet.lock();
    expect(wallet.locked).toBe(true);
    expect(() => wallet.backup()).toThrow(/locked/i);
    expect(() => wallet.signDigest(new Uint8Array(32))).toThrow(/locked/i);
    expect(wallet.evmAddress).toBe(b.ethAddress); // an address, not a secret: kept after Lock
  });
  test('a record from a newer app, or a broken one, is refused', async () => {
    const r = await newKeys({ wallet: hex(b.entropyHex) }, PASS);
    expect(() => loadKeys({ ...r, v: 2 })).toThrow(/newer version/);
    expect(() => loadKeys({ ...r, alias: 'nope' })).toThrow();
    expect(() => loadKeys({ ...r, wallet: { pubkey: b.pubkey } })).toThrow(/wallet/);
  });
  test('a wallet whose stored public key is not its key is refused at Unlock', async () => {
    const r = await newKeys({ wallet: hex(b.entropyHex) }, PASS);
    await expect(unlockWallet({ ...r, wallet: { ...r.wallet, pubkey: a.pubkey } }, PASS)).rejects.toThrow(/does not match/);
  });
});

describe('the passphrase each time: Backup and Send (docs/design/keys.md#backup)', () => {
  test('withPassphrase: the wallet opened from the passphrase for one use, then wiped; none or a wrong one is refused', async () => {
    const r = await newKeys({ wallet: hex(b.entropyHex) }, PASS);
    for (const none of [undefined, null, '']) {
      await expect(withPassphrase(r, none, () => 'ran')).rejects.toThrow(PASSPHRASE_NEEDED);
    }
    await expect(withPassphrase(r, 'not it at all', () => 'ran')).rejects.toThrow(/^Wrong passphrase$/);
    let used;
    expect(await withPassphrase(r, PASS, (v) => { used = v; return v.evmAddress; })).toBe(b.ethAddress);
    expect(used.locked).toBe(true); // wiped once fn is done
    // wiped when fn throws too
    await expect(withPassphrase(r, PASS, (v) => { used = v; throw new Error('send failed'); })).rejects.toThrow('send failed');
    expect(used.locked).toBe(true);
  });
  test('backupKeys: each key or all three, from the passphrase every time; never without it', async () => {
    const r = await newKeys({ alias: hex(a.entropyHex), wallet: hex(b.entropyHex), nostr: fx.nostr.secretHex }, PASS);
    await expect(backupKeys(r, 'wallet')).rejects.toThrow(PASSPHRASE_NEEDED);
    await expect(backupKeys(r, 'alias', '')).rejects.toThrow(PASSPHRASE_NEEDED);
    await expect(backupKeys(r, 'nostr', 'not it at all')).rejects.toThrow(/^Wrong passphrase$/);
    await expect(backupKeys(r, 'purse', PASS)).rejects.toThrow(/'alias', 'wallet' or 'nostr'/); // the name first, before 0.3 s
    expect(await backupKeys(r, 'wallet', PASS)).toEqual({ words: b.words, privateKey: `0x${b.entropyHex}` });
    expect(await backupKeys(r, 'alias', PASS)).toEqual({ words: a.words, privateKey: `0x${a.entropyHex}` });
    const nostr = await backupKeys(r, 'nostr', PASS);
    expect(nostr).toEqual({ nsec: expect.stringMatching(/^nsec1/), secret: fx.nostr.secretHex });
    expect(await backupKeys(r, null, PASS)).toEqual({ alias: { words: a.words, privateKey: `0x${a.entropyHex}` },
      wallet: { words: b.words, privateKey: `0x${b.entropyHex}` }, nostr });
    expect(await backupKeys(r, undefined, PASS)).toHaveProperty('wallet');
  });
});

describe('readDockerFiles: a Dockerized Neuron\'s files, translated', () => {
  const { password, wrongPassword } = fx.wallets;
  const current = fx.vectors[fx.wallets.current.vector];
  test('current files and nostr.yaml → the three secrets; the record has the same keys', async () => {
    const s = await readDockerFiles({ aliasText: a.walletYaml, walletText: fx.wallets.current.yaml, password, nostrText: fx.nostr.yaml });
    expect(s).toEqual({ alias: hex(a.entropyHex), wallet: hex(current.entropyHex), nostr: fx.nostr.secretHex });
    const k = loadKeys(await newKeys(s, PASS));
    expect([k.alias.pubkey, k.wallet.pubkey, k.nostr.pubkey]).toEqual([a.pubkey, current.pubkey, fx.nostr.pubkeyHex]);
    expect(k.wallet.evmAddress).toBe(current.ethAddress); // the same Base address as the Docker neuron's
  });
  test('no nostr.yaml: no Nostr key, so newKeys makes one', async () => {
    const s = await readDockerFiles({ aliasText: a.walletYaml, walletText: fx.wallets.current.yaml, password });
    expect(s.nostr).toBeUndefined();
    expect(nostrPubkey((await newKeys(s, PASS)).nostr)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('an old wallet (fields encrypted by length) and one with no plain publicKey', async () => {
    const old = await readDockerFiles({ aliasText: a.walletYaml, walletText: fx.wallets.old.yaml, password });
    expect(old.wallet).toEqual(hex(fx.vectors[fx.wallets.old.vector].entropyHex));
    const noKey = fx.wallets.current.yaml.split('\n').filter((l) => !l.startsWith('publicKey:')).join('\n');
    expect((await readDockerFiles({ aliasText: a.walletYaml, walletText: noKey, password })).wallet).toEqual(hex(current.entropyHex));
  });
  test('a Latin-1 password, as satorilib takes it', async () => {
    const s = await readDockerFiles({ aliasText: a.walletYaml, walletText: edges.latin1Wallet.yaml, password: edges.latin1Wallet.password });
    expect(publicKey(s.wallet)).toMatch(/^0[23]/);
  });
  test('wrong password, a mismatched file, a watch-only file are refused', async () => {
    await expect(readDockerFiles({ aliasText: a.walletYaml, walletText: fx.wallets.current.yaml, password: wrongPassword }))
      .rejects.toThrow(/The wallet file: wrong passphrase/i);
    await expect(readDockerFiles({ aliasText: fx.mismatch.yaml, walletText: fx.wallets.current.yaml, password }))
      .rejects.toThrow(/The alias file: .*publicKey/);
    await expect(readDockerFiles({ aliasText: `publicKey: ${a.pubkey}\n`, walletText: fx.wallets.current.yaml, password }))
      .rejects.toThrow(/The alias file: no entropy/i);
  });
  test('files in the wrong slots are refused, and the message says which', async () => {
    const cur = fx.wallets.current.yaml;
    await expect(readDockerFiles({ aliasText: cur, walletText: a.walletYaml, password })).rejects.toThrow(/swapped/i);
    await expect(readDockerFiles({ aliasText: cur, walletText: fx.wallets.old.yaml, password }))
      .rejects.toThrow(/The alias file: .*encrypted.*wallet file/i);
    await expect(readDockerFiles({ aliasText: a.walletYaml, walletText: b.walletYaml, password }))
      .rejects.toThrow(/The wallet file: .*not encrypted/i);
  });
  test('a wallet Docker saved unencrypted (password outside Latin-1) is refused', async () => {
    await expect(readDockerFiles({ aliasText: a.walletYaml, walletText: edges.nonLatin1Password.savedYaml, password: 'p€ss' }))
      .rejects.toThrow(/The wallet file: .*not encrypted/i);
  });
  test('a file that is not valid YAML: "not valid YAML (line N)", its text never in the error (the security review, 2026-10-19)', async () => {
    const leaky = `entropy: c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MTI=
words: abandon ability able about above absent absorb abstract absurd abuse access accident
privateKey: KxSECRETWIFSECRETWIFSECRETWIFSECRETWIFSECRETWIF12
publicKey: 02aa
  bad: : indentation
`;
    for (const [files, name] of [[{ aliasText: leaky, walletText: fx.wallets.current.yaml }, 'The alias file'],
      [{ aliasText: a.walletYaml, walletText: leaky }, 'The wallet file'],
      [{ aliasText: a.walletYaml, walletText: fx.wallets.current.yaml, nostrText: `secret_hex: ${'ab'.repeat(32)}
  x: : y
` }, 'The Nostr file']]) {
      const err = await readDockerFiles({ ...files, password }).catch((e) => e);
      expect(err.message).toMatch(new RegExp(`^${name}: not valid YAML \\(line \\d+\\)$`));
      expect(err.message).not.toMatch(/SECRET|abandon|ab{4}|c2Vj/);
    }
  });
  test('a file over 64 KB is refused before it is read: no Dockerized Neuron file is that big', async () => {
    const big = `entropy: ${'A'.repeat(70_000)}\n`;
    await expect(readDockerFiles({ aliasText: big, walletText: fx.wallets.current.yaml, password })).rejects.toThrow('The alias file: over 64 KB, so not a Docker file.');
    await expect(readDockerFiles({ aliasText: a.walletYaml, walletText: fx.wallets.current.yaml, password, nostrText: big }))
      .rejects.toThrow('The Nostr file: over 64 KB, so not a Docker file.');
    expect(IMPORT_MAX).toBe(65_536);
  });
  test('the same key twice, and a bad nostr.yaml, are refused', async () => {
    const files = { aliasText: current.walletYaml, walletText: fx.wallets.current.yaml, password };
    await expect(readDockerFiles(files)).rejects.toThrow(/same key/i);
    await expect(readDockerFiles({ ...files, aliasText: a.walletYaml, nostrText: 'secret_hex: 00\n' })).rejects.toThrow(/The Nostr file/);
  });
});

describe('every earlier version\'s keys (test/fixtures/profiles.json) carried forward', () => {
  for (const p of profiles.filter((x) => x.meta.wallet_yaml && x.meta.vault_yaml && !x.label.includes('plain-text vault.yaml'))) {
    test(p.label, async () => {
      const rows = { aliasYaml: p.meta.wallet_yaml, walletYaml: p.meta.vault_yaml, nostrYaml: p.meta.nostr_yaml };
      const record = await recordFromRows(rows);
      // At load: the alias and the Nostr key translated; the wallet kept as it was, its public key in clear when it had one.
      expect(record).toMatchObject({ v: 1, alias: p.expect.alias, wallet: { yaml: p.meta.vault_yaml } });
      if (p.expect.nostr) expect(record.nostr).toBe(p.expect.nostr);
      else expect(nostrPubkey(record.nostr)).toMatch(/^[0-9a-f]{64}$/); // made now, as the load before step 5 did
      const walletPub = publicKey(hex(p.expect.wallet));
      const noPlainKey = p.commit === '8996f24';
      expect(loadKeys(record).wallet).toEqual(noPlainKey ? { pubkey: null, evmAddress: null, connected: null } : { pubkey: walletPub, evmAddress: evmAddress(walletPub), connected: null });
      expect(loadKeys(record).alias.pubkey).toBe(publicKey(hex(p.expect.alias)));

      // The next Unlock: the wallet re-encrypted in this app's format, with the same passphrase.
      await expect(unlockWallet(record, 'not the passphrase')).rejects.toThrow(/^Wrong passphrase$/);
      const first = await unlockWallet(record, p.passphrase);
      expect(first.wallet.backup().words).toBe(wordsOf(hex(p.expect.wallet)));
      expect(first.record).toEqual({ ...record, wallet: { pubkey: walletPub, kdf: expect.any(Object), cipher: expect.any(Object), data: expect.any(String) },
        link: { message: expect.stringContaining(`wallet: ${evmAddress(walletPub)}`), signature: expect.any(String) } }); // its link made at this Unlock
      const again = await unlockWallet(first.record, p.passphrase);
      expect(again.record).toBe(null);
      expect(again.wallet.pubkey).toBe(walletPub);
    });
  }
  test('a plain-text wallet an early import kept is encrypted at its next Unlock, with a passphrase that meets the rule', async () => {
    const p = profiles.find((x) => x.label.includes('plain-text vault.yaml'));
    const record = await recordFromRows({ aliasYaml: p.meta.wallet_yaml, walletYaml: p.meta.vault_yaml });
    await expect(unlockWallet(record, 'short')).rejects.toThrow(/at least 8/);
    const { record: upgraded } = await unlockWallet(record, p.passphrase);
    await expect(unlockWallet(upgraded, 'another one entirely')).rejects.toThrow(/^Wrong passphrase$/);
    expect((await unlockWallet(upgraded, p.passphrase)).wallet.pubkey).toBe(publicKey(hex(p.expect.wallet)));
  });
});
