# Identity and keys

[← OVERVIEW](OVERVIEW.md)

The browser neuron holds the same three secrets as the Docker neuron and must
produce the same addresses, signatures and files from them, so a user can move
a neuron between the two.

## The keys (verified)

| Key | Docker storage | Used for |
|---|---|---|
| identity | `wallet.yaml`, plaintext (`neuron/neuron-lite/satorineuron/init/wallet.py:94-111`) | central login signature; signs the daily Base batch (`neuron/neuron-lite/start.py:1164-1165,1234`); sets predictor fee 0 |
| vault | `vault.yaml`, per-field encrypted (`init/wallet.py:113-159`) | delegate/revoke (`hub.delegatePredictionPower`), `hub.claim`, merkle and airdrop claims (`neuron/neuron-lite/satorineuron/base_claim.py:84-121`) |
| Nostr | `nostr.yaml`, plaintext hex, random (`start.py:120-149`) | registered with central in v1; Nostr events from parity on |

Each wallet key is one 32-byte secp256k1 secret ("entropy") used directly as:

- the Evrmore private key (`satorilib/src/satorilib/wallet/evrmore/identity.py:52-56`);
- the EVM/Base private key (`satorilib/src/satorilib/wallet/ethereum/wallet.py:113-115`, `wallet/wallet.py:221-232`);
- BIP39 *entropy* for the 24 backup words (`wallet/identity.py:319-320`).

There is no HD derivation and no mnemonic-to-seed step. **Never call
`mnemonicToSeed`**: it yields a different key, so existing users' words would
restore the wrong wallet. Restore is `mnemonicToEntropy` → private key.

The Nostr key is independent of both wallets.

## Derivations (verified by parity vector)

A research run generated a vector in the shipped `satorinet/satori-lite:latest`
image from entropy `sha256('satori-browser-parity-vector-1')` and reproduced it
byte for byte in Node with the pinned noble/scure/viem versions: words, WIF,
pubkey, address, scripthash, message hash, ETH address, EIP-191 signature.

| Output | Rule | Evidence |
|---|---|---|
| keygen | 32 random bytes, reject unless 1 ≤ k < n; stored base64 (44 chars) | `wallet/identity.py:309-317,131,245` |
| pubkey | compressed 33 bytes, hex | `evrmore/identity.py:46-59` |
| address | base58check, version 0x21 (`E…`); P2SH 0x5c (`e…`) | `evrmore/identity.py:22-37` |
| WIF | version 0x80 + 0x01 flag, 52 chars | `wallet/identity.py:152,596` |
| scripthash | sha256(`76a914<h160>88ac`) reversed, hex | `wallet/identity.py:290-307` |
| ETH address | keccak of the uncompressed pubkey (viem `privateKeyToAccount`) | `ethereum/wallet.py:113-121` |

## Signing

Evrmore signed message (central login):

```
hash = sha256d( varint(24) || "Evrmore Signed Message:\n" || varint(len) || utf8(msg) )
sig  = base64( [27 + recid + 4] || r || s )      # 65 bytes, low-S
```

Evidence: `satorilib/src/satorilib/wallet/evrmore/sign.py:7-13`,
`evrmore/verify.py:15-36`.

About 15 lines on `@noble/curves`. The browser signs with RFC 6979, while
Python signs through OpenSSL with a random nonce. Two Python signatures of the
same message differ (verified in the image), so **tests cross-verify** (JS
verifies Python's signature, Python's `satorilib` verify accepts JS's) and never
compare signature bytes. Both kinds were accepted by central's verifier during
research.

Base transactions use viem with a local account; EIP-1559 fees as Docker does
(`satorilib/src/satorilib/chain/evm.py:59-92`).

## At rest

Recommended (owner decision 1 in OVERVIEW):

- One passphrase. WebCrypto PBKDF2-SHA256 (600,000 iterations, stored with the
  ciphertext so it can rise later), then AES-256-GCM. Ciphertext and parameters
  live in IndexedDB. No Argon2/hash-wasm: WebCrypto PBKDF2 is already needed
  for Docker vault import, so it adds no dependency.
- Signing in decrypts in the **neuron worker** only, never the main thread.
- "Remember on this device" (opt-in): the identity entropy is also wrapped with a
  non-extractable AES-GCM `CryptoKey` stored in IndexedDB, so a reloaded or
  discarded tab can log in and run the daily batch without a prompt. This stops
  the key from being copied out as bytes; it does not stop a script running on
  our origin from using it (inferred), so the CSP is strict
  ([ui.md](ui.md#security)) and dependencies are minimal.
- The vault is always passphrase-only, decrypted for one transaction
  (delegate, revoke, claims) and wiped after.
- The passphrase is never stored. (Docker stores it in plaintext as
  `'vault password'`, `neuron/neuron-lite/cli.py:251-252`; not copied.)
- Call `navigator.storage.persist()` on first run. Safari can delete storage
  after 7 days without a visit, so backup words are mandatory at onboarding.

WebCrypto has no secp256k1, so the signing key is necessarily a JS byte array in
worker memory while signed in (inferred from platform docs).

## Two-key model: kept

The vault delegates prediction power to the identity
(`neuron/neuron-lite/satorineuron/base_predict.py:242-323`). In a browser both
keys sit in one place, but keeping the model means the vault stays encrypted day
to day, imports from Docker work unchanged, and the contracts need no change.

## Import and export (Docker interop)

Import accepts:

- `wallet.yaml` / `vault.yaml` (keys `entropy, words, privateKey, publicKey,
  scripthash, evr.address`; load order entropy → 52-char WIF → watch-only,
  `wallet/identity.py:115-177`);
- `nostr.yaml` (`pubkey_hex`, `secret_hex`, `start.py:120-149`);
- 24 words or a WIF.

After import everything is re-derived from entropy and checked against the file's
stored pubkey and address; a mismatch is shown, as `identity.py:141-148` does.

Docker vault encryption (verified, decrypted by WebCrypto in about 1.7 s per
field under Node): a field is
`base64(salt16 || iv16 || AES-256-CBC(PKCS7(utf8(value))))`, key =
PBKDF2-HMAC-**SHA1**(password, salt, 1,000,000, 32 bytes)
(`satorilib/src/satorilib/utils/secret.py:10-42,60-94`). Current writers encrypt
`entropy`, `privateKey`, `words` (`wallet/identity.py:686-689`). Older vaults
also encrypted `publicKey`, `scripthash` and `evr.address`, and the reader still
decrypts them by length (`wallet/identity.py:666-676`): `publicKey` if length
≠ 66, `scripthash` if ≠ 64, `evr.address` if > 34. The browser ports that rule.

Import decrypts `entropy` first. A wrong password shows up there as an AES-CBC
padding failure (WebCrypto throws on decrypt); that is the wrong-password
signal. (Python swallows it and leaves the dict encrypted,
`wallet/identity.py:662-692`.) Then it decrypts any length-flagged fields, derives
everything from entropy, and compares with the plaintext stored values; a
mismatch is a corrupt or mismatched file, not a wrong password.

Export writes the same legacy format so the files load in Docker. The browser's
own at-rest format is the stronger one above.

## Not in v1

- EIP-191 signing: exists in satorilib, no caller (`ethereum/wallet.py:132-140`).
- ECDH+HKDF+AES-GCM peer encryption: only for the engine IPC Docker uses
  (`wallet/identity.py:372-487`); the browser engine runs in-process.
- Evrmore transaction signing (sends, channels): see [chain.md](chain.md#evrmore-later).

## Tests

Fixtures from the Docker image: entropy → words, WIF, pubkey, address,
scripthash, ETH address; a current and an old-format (encrypted `publicKey` /
address) vault + password, plus a wrong password; a Python message signature. Assert equality on everything except signature bytes.
