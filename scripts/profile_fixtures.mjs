// test/fixtures/profiles.json: the keys every earlier version of this app
// stored (its meta rows), made by those versions' own code, so the forward
// migration (src/db/schema.js, migration 7; docs/design/storage.md) is tested
// on what is really in people's browsers. Throwaway keys (identity-parity.json's).
//
// Each version's src at its commit, next to this repo's node_modules:
//   S=$(mktemp -d); for c in 7be47fc a5bd150 8996f24 de8a29a; do mkdir -p $S/$c
//     git archive $c src | tar -x -C $S/$c; ln -s "$PWD/node_modules" $S/$c/node_modules; done
//   node scripts/profile_fixtures.mjs $S > test/fixtures/profiles.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('usage: node scripts/profile_fixtures.mjs <dir with one src/ per commit>');
const at = (commit, path) => import(pathToFileURL(join(root, commit, 'src', path)).href);
const migrations = async (commit) => (await at(commit, 'db/schema.js')).MIGRATIONS.length;

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/identity-parity.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const [a, b, c, d] = fx.vectors;
const profiles = [];
const add = (p) => profiles.push(p);

// Step 1 (7be47fc, 2026-10-15 03:26): one key, sealed (PBKDF2-SHA256 600k, AES-256-GCM) as meta.vault.
// Step 2 never read it: such a profile shows Setup, and the row is left as it is.
{
  const { seal } = await at('7be47fc', 'keys/seal.js');
  add({
    label: 'step 1 prototype: one sealed key in meta.vault, never read since',
    commit: '7be47fc', schema: await migrations('7be47fc'), passphrase: 'step one passphrase',
    meta: { vault: await seal(hex(a.entropyHex), 'step one passphrase') },
    expect: { setup: true },
  });
}

// Step 2 (a5bd150 → e84335f, 2026-10-15 06:29–14:04): wallet.yaml + vault.yaml, the vault's
// passphrase as UTF-8 bytes (no Latin-1 rule yet), so these two differ from what satorilib makes.
{
  const { writeKeys } = await at('a5bd150', 'keys/index.js');
  for (const [label, passphrase] of [['non-Latin-1', '密码密码'], ['Latin-1 letters', 'pässwörd']]) {
    const { walletYaml, vaultYaml } = await writeKeys({ identity: hex(a.entropyHex), vault: hex(b.entropyHex) }, passphrase);
    add({
      label: `step 2: the vault's passphrase as UTF-8 bytes (${label})`,
      commit: 'a5bd150', schema: await migrations('a5bd150'), passphrase,
      meta: { wallet_yaml: walletYaml, vault_yaml: vaultYaml },
      expect: { identity: a.entropyHex, vault: b.entropyHex, nostr: null },
    });
  }
  // Until 2935be0 (14:00), import did not check each file's role: a plain-text vault.yaml was kept as given.
  const { importDocker } = await at('a5bd150', 'keys/index.js');
  const plain = await importDocker({ walletText: a.walletYaml, vaultText: b.walletYaml, passphrase: 'anything' });
  if (plain.vaultYaml !== b.walletYaml) throw new Error('a5bd150 was expected to keep the plain vault as given');
  add({
    label: 'step 2 Docker import (before 2935be0): a plain-text vault.yaml, kept as given',
    commit: 'a5bd150', schema: await migrations('a5bd150'), passphrase: 'a new passphrase',
    meta: { wallet_yaml: plain.walletYaml, vault_yaml: plain.vaultYaml },
    expect: { identity: a.entropyHex, vault: b.entropyHex, nostr: null },
  });
}

// e84335f → cdce045: Latin-1 bytes as satorilib, no Nostr key yet (one is made at the next load).
// cdce045 → today: and nostr.yaml. The yaml writers did not change in between.
{
  const { writeKeys, importDocker } = await at('de8a29a', 'keys/index.js');
  const made = await writeKeys({ identity: hex(c.entropyHex), vault: hex(d.entropyHex) }, 'pass');
  add({
    label: 'steps 2-4: Latin-1 passphrase bytes, no nostr.yaml',
    commit: 'de8a29a', schema: 3, passphrase: 'pass',
    meta: { wallet_yaml: made.walletYaml, vault_yaml: made.vaultYaml },
    expect: { identity: c.entropyHex, vault: d.entropyHex, nostr: null },
  });
  const nostrSecret = fx.nostr.secretHex;
  const latin1 = await writeKeys({ identity: hex(d.entropyHex), vault: hex(a.entropyHex) }, 'pässwörd');
  add({
    label: 'step 5 on: Latin-1 letters in the passphrase, and nostr.yaml',
    commit: 'de8a29a', schema: await migrations('de8a29a'), passphrase: 'pässwörd',
    meta: { wallet_yaml: latin1.walletYaml, vault_yaml: latin1.vaultYaml, nostr_yaml: (await at('de8a29a', 'keys/docker.js')).writeNostrYaml(nostrSecret) },
    expect: { identity: d.entropyHex, vault: a.entropyHex, nostr: nostrSecret },
  });
  const imported = await importDocker({ walletText: a.walletYaml, vaultText: fx.vaults.current.yaml, passphrase: fx.vaults.password,
    nostrText: fx.nostr.yaml });
  add({
    label: 'Docker import: the identity re-written, satorilib\'s vault.yaml kept as given',
    commit: 'de8a29a', schema: await migrations('de8a29a'), passphrase: fx.vaults.password,
    meta: { wallet_yaml: imported.walletYaml, vault_yaml: imported.vaultYaml, nostr_yaml: imported.nostrYaml },
    expect: { identity: a.entropyHex, vault: fx.vectors[fx.vaults.current.vector].entropyHex, nostr: nostrSecret },
  });
  const old = await importDocker({ walletText: d.walletYaml, vaultText: fx.vaults.old.yaml, passphrase: fx.vaults.password });
  add({
    label: 'Docker import of an old vault (fields encrypted by length), re-written in the then current form',
    commit: 'de8a29a', schema: await migrations('de8a29a'), passphrase: fx.vaults.password,
    meta: { wallet_yaml: old.walletYaml, vault_yaml: old.vaultYaml, nostr_yaml: old.nostrYaml },
    expect: { identity: d.entropyHex, vault: fx.vectors[fx.vaults.old.vector].entropyHex,
      nostr: (await at('de8a29a', 'keys/docker.js')).readNostrYaml(old.nostrYaml).secretHex },
  });
}

// Before ecf3ae0 (2026-10-15 20:13), import kept a vault whose address was plain as given, with
// or without a plain publicKey: such a vault's public key is read only at its Unlock.
{
  const { importDocker } = await at('8996f24', 'keys/index.js');
  const noKey = fx.vaults.current.yaml.split('\n').filter((l) => !l.startsWith('publicKey:')).join('\n');
  const r = await importDocker({ walletText: d.walletYaml, vaultText: noKey, passphrase: fx.vaults.password });
  if (r.vaultYaml !== noKey) throw new Error('8996f24 was expected to keep the vault as given');
  add({
    label: 'Docker import before ecf3ae0: a vault.yaml with no plain publicKey, kept as given',
    commit: '8996f24', schema: await migrations('8996f24'), passphrase: fx.vaults.password,
    meta: { wallet_yaml: r.walletYaml, vault_yaml: r.vaultYaml, nostr_yaml: r.nostrYaml },
    expect: { identity: d.entropyHex, vault: fx.vectors[fx.vaults.current.vector].entropyHex,
      nostr: (await at('8996f24', 'keys/docker.js')).readNostrYaml(r.nostrYaml).secretHex },
  });
}

// A setup cut off between its writes (the vault was written first): never a neuron; shows Setup.
{
  const { writeKeys } = await at('de8a29a', 'keys/index.js');
  const made = await writeKeys({ identity: hex(b.entropyHex), vault: hex(c.entropyHex) }, 'pass');
  add({
    label: 'a setup cut off after the vault row: vault.yaml and nostr.yaml, no wallet.yaml',
    commit: 'de8a29a', schema: await migrations('de8a29a'), passphrase: 'pass',
    meta: { vault_yaml: made.vaultYaml, nostr_yaml: made.nostrYaml },
    expect: { setup: true },
  });
}

process.stdout.write(`${JSON.stringify({
  about: 'The keys each earlier version of this app stored (meta rows, as JS values), made by that version\'s own code. Throwaway keys.',
  generator: 'scripts/profile_fixtures.mjs',
  profiles,
}, null, 2)}\n`);
