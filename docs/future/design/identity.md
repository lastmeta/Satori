# Identity and keys: what is left

[← OVERVIEW](OVERVIEW.md)

**Built in step 2:** the identity and vault keys, derivations, Evrmore message
signing, Docker `wallet.yaml`/`vault.yaml` import and export, backup. See
[../../design/keys.md](../../design/keys.md). That doc replaces the "at rest"
plan that was here: the browser now stores the two keys exactly as Docker does
(identity plaintext, vault fields encrypted with PBKDF2-SHA1 × 1e6 → AES-CBC),
inside DuckDB, instead of a separate IndexedDB format.

Still to build, with the evidence gathered earlier:

## Nostr key (step 5)

`nostr.yaml`, plaintext hex, random, independent of both wallets
(`neuron/neuron-lite/start.py:120-149`): `pubkey_hex`, `secret_hex`. Registered
with central in v1; signs Nostr events. `draft/v1-full` has
`importNostrYaml`/`exportNostrYaml` and a fixture (`fx.nostr` in
`test/fixtures/identity-parity.json`, already on `main`).

## Base address (step 4)

The same 32-byte secret is the EVM private key
(`satorilib/src/satorilib/wallet/ethereum/wallet.py:113-121`); the address is
keccak of the uncompressed pubkey. Parity vectors carry `ethAddress`.
`draft/v1-full` used viem's `privateKeyToAccount`. The identity signs the daily
Base batch (`start.py:1148-1165`); the vault delegates to it and claims
(`base_claim.py:84-121`), so those need Unlock.

## Signing

The browser signs with RFC 6979; Python signs through OpenSSL with a random
nonce, so tests cross-verify and never compare signature bytes. Central
accepted both kinds during research.

## Later (step 7)

- Move the unlocked vault (and signing) into a worker, off the main thread.
- `navigator.storage.persist()` on first run; Safari can drop storage after 7
  days without a visit, which is why the vault's words are checked at setup.
- Not planned: EIP-191 signing (no caller), ECDH peer encryption (only for
  Docker's engine IPC), Evrmore transaction signing (see [chain.md](chain.md)).
