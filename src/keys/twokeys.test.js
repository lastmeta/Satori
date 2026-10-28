// The two-key model in this app's own record (docs/design/keys.md): the
// alias and the Nostr key in plain text (the neuron signs on its own), the
// wallet encrypted with the passphrase; Docker's files translated in; this
// app's earlier rows carried forward.
import { recoverMessageAddress } from 'viem';
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  newKeys, readDockerFiles, recordFromRows, loadKeys, unlockWallet, publicKey, wordsOf, evmAddress, withPassphrase, backupKeys, IMPORT_MAX, keepRetired, checkWalletPassphrase,
  PASSPHRASE_NEEDED,
} from './index.js';
import { verifyMessage } from 'viem';
import { nostrPubkey } from '../nostr/event.js';
import { keysFromWallet } from './derive.js';
import { bytesToHex } from '@noble/hashes/utils';

vi.setConfig({ testTimeout: 180_000 });

const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/alias-parity.json', import.meta.url)));
const edges = JSON.parse(readFileSync(new URL('../../test/fixtures/satorilib-edges.json', import.meta.url)));
const { profiles } = JSON.parse(readFileSync(new URL('../../test/fixtures/profiles.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const [a, b] = fx.vectors;
const PASS = 'correct horse battery';
// the alias and the Nostr key derived from wallet b (docs/design/wallets.md#derived-keys)
const d = keysFromWallet(hex(b.entropyHex));
const dAlias = { hex: bytesToHex(d.alias), pubkey: publicKey(d.alias), address: evmAddress(publicKey(d.alias)), words: wordsOf(d.alias) };

describe('newKeys: the record', () => {
  test('the alias and the Nostr key derived from the wallet, in hex; the wallet sealed with its public key in clear', async () => {
    const r = await newKeys({ wallet: hex(b.entropyHex) }, PASS);
    expect(r).toEqual({
      v: 1, created: expect.any(Number), alias: dAlias.hex, nostr: d.nostr, from: 'wallet',
      wallet: { pubkey: b.pubkey, kdf: expect.objectContaining({ name: 'PBKDF2', hash: 'SHA-256' }),
        cipher: expect.objectContaining({ name: 'AES-GCM' }), data: expect.any(String) },
      link: { message: expect.any(String), signature: expect.stringMatching(/^0x[0-9a-f]{130}$/) },
    });
    // the wallet's link to the alias (docs/design/wallets.md): its fixed text, signed by the wallet (EIP-191)
    const [title, alias, wallet, issued] = r.link.message.split('\n');
    expect([title, alias, wallet]).toEqual(['Satori: link this alias to my wallet', `alias: ${dAlias.address}`, `wallet: ${b.ethAddress}`]);
    expect(Number(issued.slice('issued: '.length))).toBe(r.created);
    expect(await recoverMessageAddress({ message: r.link.message, signature: r.link.signature })).toBe(b.ethAddress);
    expect(Math.abs(r.created - Date.now() / 1000)).toBeLessThan(60); // when these keys were made: Home's first day
    expect(JSON.stringify(r)).not.toMatch(/yaml|address|wif|scripthash|words/i);
    expect(JSON.stringify(r)).not.toContain(b.entropyHex);
  });
  test('the same wallet, the same alias and Nostr key: on any device, from its words or its key', async () => {
    const [one, two] = [await newKeys({ wallet: hex(b.entropyHex) }, PASS), await newKeys({ wallet: hex(a.entropyHex) }, PASS)];
    expect([one.alias, one.nostr]).toEqual([dAlias.hex, d.nostr]);
    expect(two.alias).not.toBe(one.alias);
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
});

describe('loadKeys and Unlock', () => {
  test('the alias signs on its own; the wallet\'s Base address shows while locked; Unlock, backup, Lock', async () => {
    const r = await newKeys({ wallet: hex(b.entropyHex) }, PASS);
    const k = loadKeys(r);
    expect(k.alias).toMatchObject({ pubkey: dAlias.pubkey, evmAddress: dAlias.address });
    expect(await verifyMessage({ address: dAlias.address, message: 'c-0', signature: k.alias.signCentralLogin('c-0') })).toBe(true); // EIP-191
    expect(k.alias.backup()).toEqual({ words: dAlias.words, privateKey: `0x${dAlias.hex}` });
    expect(k.nostr).toEqual({ secret: d.nostr, pubkey: nostrPubkey(d.nostr) });
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
    const r = await newKeys({ wallet: hex(b.entropyHex) }, PASS);
    await expect(backupKeys(r, 'wallet')).rejects.toThrow(PASSPHRASE_NEEDED);
    await expect(backupKeys(r, 'alias', '')).rejects.toThrow(PASSPHRASE_NEEDED);
    await expect(backupKeys(r, 'nostr', 'not it at all')).rejects.toThrow(/^Wrong passphrase$/);
    await expect(backupKeys(r, 'purse', PASS)).rejects.toThrow(/'alias', 'wallet', 'nostr' or 'retired'/); // the name first, before 0.3 s
    expect(await backupKeys(r, 'wallet', PASS)).toEqual({ words: b.words, privateKey: `0x${b.entropyHex}` });
    expect(await backupKeys(r, 'alias', PASS)).toEqual({ words: dAlias.words, privateKey: `0x${dAlias.hex}` });
    const nostr = await backupKeys(r, 'nostr', PASS);
    expect(nostr).toEqual({ nsec: expect.stringMatching(/^nsec1/), secret: d.nostr });
    expect(await backupKeys(r, null, PASS)).toEqual({ alias: { words: dAlias.words, privateKey: `0x${dAlias.hex}` },
      wallet: { words: b.words, privateKey: `0x${b.entropyHex}` }, nostr, retired: [] });
    expect(await backupKeys(r, undefined, PASS)).toHaveProperty('wallet');
  });
});

describe('readDockerFiles: a Dockerized Neuron\'s wallet file, translated (its alias and Nostr files are not kept)', () => {
  const { password, wrongPassword } = fx.wallets;
  const current = fx.vectors[fx.wallets.current.vector];
  test('the current wallet file → its secret; the record derives the alias and the Nostr key from it', async () => {
    const s = await readDockerFiles({ walletText: fx.wallets.current.yaml, password });
    expect(s).toEqual({ wallet: hex(current.entropyHex) });
    const k = loadKeys(await newKeys(s, PASS));
    const dc = keysFromWallet(hex(current.entropyHex));
    expect([k.alias.pubkey, k.wallet.pubkey, k.nostr.secret]).toEqual([publicKey(dc.alias), current.pubkey, dc.nostr]);
    expect(k.wallet.evmAddress).toBe(current.ethAddress); // the same Base address as the Docker neuron's
  });
  test('an old wallet (fields encrypted by length) and one with no plain publicKey', async () => {
    const old = await readDockerFiles({ walletText: fx.wallets.old.yaml, password });
    expect(old.wallet).toEqual(hex(fx.vectors[fx.wallets.old.vector].entropyHex));
    const noKey = fx.wallets.current.yaml.split('\n').filter((l) => !l.startsWith('publicKey:')).join('\n');
    expect((await readDockerFiles({ walletText: noKey, password })).wallet).toEqual(hex(current.entropyHex));
  });
  test('a Latin-1 password, as satorilib takes it', async () => {
    const s = await readDockerFiles({ walletText: edges.latin1Wallet.yaml, password: edges.latin1Wallet.password });
    expect(publicKey(s.wallet)).toMatch(/^0[23]/);
  });
  test('a wrong password is refused; the alias file (not encrypted) is named as such', async () => {
    await expect(readDockerFiles({ walletText: fx.wallets.current.yaml, password: wrongPassword }))
      .rejects.toThrow(/The wallet file: wrong passphrase/i);
    await expect(readDockerFiles({ walletText: a.walletYaml, password })).rejects.toThrow(/The wallet file: .*not encrypted, so it is the alias file/i);
  });
  test('a wallet Docker saved unencrypted (password outside Latin-1) is refused', async () => {
    await expect(readDockerFiles({ walletText: edges.nonLatin1Password.savedYaml, password: 'p€ss' }))
      .rejects.toThrow(/The wallet file: .*not encrypted/i);
  });
  test('a file that is not valid YAML: "not valid YAML (line N)", its text never in the error (the security review, 2026-10-19)', async () => {
    const leaky = `entropy: c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MTI=
words: abandon ability able about above absent absorb abstract absurd abuse access accident
privateKey: KxSECRETWIFSECRETWIFSECRETWIFSECRETWIFSECRETWIF12
publicKey: 02aa
  bad: : indentation
`;
    const err = await readDockerFiles({ walletText: leaky, password }).catch((e) => e);
    expect(err.message).toMatch(/^The wallet file: not valid YAML \(line \d+\)$/);
    expect(err.message).not.toMatch(/SECRET|abandon|c2Vj/);
  });
  test('a file over 64 KB is refused before it is read: no Dockerized Neuron file is that big', async () => {
    await expect(readDockerFiles({ walletText: `entropy: ${'A'.repeat(70_000)}\n`, password })).rejects.toThrow('The wallet file: over 64 KB, so not a Docker file.');
    expect(IMPORT_MAX).toBe(65_536);
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
      // Its alias and Nostr key derived from the wallet now, replacing the earlier ones (docs/design/wallets.md#derived-keys).
      const first = await unlockWallet(record, p.passphrase);
      expect(first.wallet.backup().words).toBe(wordsOf(hex(p.expect.wallet)));
      const dw = keysFromWallet(hex(p.expect.wallet));
      expect(first.record).toEqual({ ...record, alias: bytesToHex(dw.alias), nostr: dw.nostr, from: 'wallet',
        wallet: { pubkey: walletPub, kdf: expect.any(Object), cipher: expect.any(Object), data: expect.any(String) },
        link: { message: expect.stringContaining(`alias: ${evmAddress(publicKey(dw.alias))}\nwallet: ${evmAddress(walletPub)}`), signature: expect.any(String) } }); // its link made at this Unlock
      const again = await unlockWallet(first.record, p.passphrase);
      expect(again.record).toBe(null);
      expect(again.wallet.pubkey).toBe(walletPub);
      // The replaced alias and Nostr key are kept, never dropped (the owner, 2026-10-28: ETH sent to one was stranded).
      const kept = keepRetired(record, first.record, 7);
      expect(kept.retired).toEqual([{ alias: record.alias, nostr: record.nostr, at: 7 }]);
      expect(keepRetired(kept, kept)).toBe(kept); // the same keys again: nothing more retired
      expect(await checkWalletPassphrase(first.record, p.passphrase)).toBe('checked'); // Remove's check, from the wallet part alone
      await expect(checkWalletPassphrase(first.record, 'not the passphrase')).rejects.toThrow(/^Wrong passphrase$/);
      await expect(checkWalletPassphrase(record, 'not the passphrase')).rejects.toThrow(/^Wrong passphrase$/); // an earlier form too
      const [earlier] = await backupKeys(kept, 'retired', p.passphrase);
      expect(earlier).toMatchObject({ address: evmAddress(publicKey(hex(p.expect.alias))), privateKey: `0x${record.alias}`, at: 7 });
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
