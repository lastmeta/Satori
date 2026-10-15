# Keys: identity and vault

[← OVERVIEW](OVERVIEW.md)

The browser neuron holds Satori's two keys, made, stored and used the way the
Docker neuron (Satori Lite, `../neuron`) and satorilib (`../satorilib`) do it,
so a neuron moves between the two by moving two files.

| Key | Stored as | Encrypted? | Used for |
|---|---|---|---|
| **identity** | `wallet.yaml` text in the db (`meta.wallet_yaml`) | no | everything the neuron does on its own: central register and login ([central.md](central.md)); later Nostr, the daily Base batch |
| **vault** | `vault.yaml` text in the db (`meta.vault_yaml`) | yes, with the passphrase | holds funds; later delegate, claims, sends. Only while unlocked. |

The identity is unencrypted on purpose: the neuron must run after a page load
with nobody there to type a passphrase. The vault is where the funds are, so it
is opened only by **Unlock** (enter the passphrase) and wiped from memory by
**Lock**.

## What Satori Lite does (the pattern followed)

| Behaviour | Where in Docker |
|---|---|
| The identity is made at startup with no user input: `EvrmoreIdentity(wallet.yaml)` loads the file, or generates and saves it when missing. No password. | `neuron/neuron-lite/start.py:75`; `satorilib/src/satorilib/wallet/identity.py:611-615`; `neuron/neuron-lite/satorineuron/init/wallet.py:94-111` ("doesn't require a password") |
| The vault is made only when a password is given (`vault-setup`, at least 4 characters, typed twice). | `init/wallet.py:44-45,113-155`; `neuron/web/routes.py:570-619` (length rule at `:589`) |
| Login (unlock) decrypts the vault with the password; a wrong password leaves it encrypted. Logout closes it (Lock). | `routes.py:462-568,625-634`; `init/wallet.py:219-245` |
| The vault's address and pubkey are read from `vault.yaml` without decrypting it, so they show while locked. | `start.py:4637-4667` |
| The identity signs the daily Base batch with no vault unlock ("the vault delegated its prediction power to it"). | `start.py:1148-1165` |
| The vault password is never saved by the web setup. | `routes.py:598` |
| Backup: the dashboard (behind login) reveals the vault's and the identity's private key; "Download Wallet" zips `wallet.yaml` + `vault.yaml`; "Import Wallet" takes both files back. | `routes.py:1267-1291,3214-3254,2281-2420`; `web/templates/dashboard.html:2112-2160,3821-3850` |

## One key, many forms (satorilib)

Each key is one 32-byte secp256k1 secret, the **entropy**, used directly as
the Evrmore private key and as the BIP39 entropy of the 24 words. No HD path,
no `mnemonicToSeed`.

| Output | Rule | Evidence |
|---|---|---|
| keygen | 32 random bytes, retried until 1 ≤ k < n | `wallet/identity.py:309-317` |
| entropy | base64, 44 characters | `wallet/identity.py:124-131,245` |
| words | `Mnemonic('english').to_mnemonic(entropy)` (24 words) | `wallet/identity.py:319-320` |
| privateKey | WIF: 0x80 ‖ key ‖ 0x01, base58check (52 chars) | `evrmore/identity.py:52-56` |
| publicKey | compressed, hex (66) | `evrmore/identity.py:46-50` |
| address | base58check(0x21 ‖ hash160(pubkey)), `E…` | `evrmore/identity.py:27-33,58-59` |
| scripthash | sha256(`76a914‖h160‖88ac`) reversed, hex | `wallet/identity.py:290-307` |
| sign | Evrmore signed message, base64 of 65 bytes | `evrmore/identity.py:66-67`, `evrmore/sign.py` |
| verify | recover the key in the form the header names (31-34 compressed, 27-30 uncompressed), compare with the pubkey or address | python-evrmorelib `signmessage.py` `verifyMessage`, `core/key.py` `recover_compact` |

## The files

`wallet.yaml` and `vault.yaml` have the same fields; the vault encrypts three of
them (`wallet/identity.py:625-651,682-692`):

```yaml
entropy: <base64>          # vault: encrypted
evr:
  address: E…
privateKey: <WIF>          # vault: encrypted
publicKey: <hex>
scripthash: <hex>
words: <24 words>          # vault: encrypted
```

A vault field is `base64(salt16 ‖ iv16 ‖ AES-256-CBC(PKCS7(utf8(value))))`,
key = PBKDF2-HMAC-SHA1(password, salt, 1,000,000, 32 bytes)
(`satorilib/src/satorilib/utils/secret.py:10-42`). WebCrypto does all of it.

The password goes into PBKDF2 as **Latin-1** bytes, one byte per character:
pycryptodome turns a `str` password into bytes with `tobytes(s)`, which
encodes Latin-1 (`Crypto/Util/py3compat.py`, `Crypto/Protocol/KDF.py` PBKDF2).
So `ä` is the byte `e4`, not UTF-8's `c3 a4`. A password with a character
outside Latin-1 (`€`, emoji, non-Latin letters) can't be encoded: satorilib's
`encryptWallet` swallows the error and saves the vault **unencrypted**
(`identity.py:682-692`; vector in `test/fixtures/satorilib-edges.json`).

**Which file is which.** By its secret fields, with satorilib's length rules:
a 44-char `entropy`, a 52-char WIF and `words` with spaces are plain text
(`identity.py:131,152,595`); anything else there is ciphertext. A `wallet.yaml`
has them in plain text, a `vault.yaml` encrypted. The browser reads
`wallet.yaml` with no password and refuses it if it is encrypted, and refuses
a `vault.yaml` that is not encrypted (Unlock refuses one too). Files put in
each other's slots are named as swapped.

**Reading** (`wallet/identity.py:115-177,662-680`): entropy first (44 chars);
else a 52-char WIF; else watch-only, which the browser refuses (it needs the
key). Older vaults also encrypted `publicKey`, `scripthash` and `evr.address`;
satorilib decrypts them by length (`publicKey` if ≠ 66, `scripthash` if ≠ 64,
`evr.address` if > 34), and so does the browser. Everything is then derived
from the entropy and compared with the stored values. When they differ,
satorilib logs a warning and uses the entropy's values (`identity.py:140-147`);
the browser refuses the file.

**Wrong password.** satorilib swallows the decrypt error and leaves the vault
encrypted (`identity.py:678-679`, then `routes.py:529-531`). The browser
reports it: a wrong password fails the AES-CBC padding, or decrypts to
something that is not the entropy of the stored address.

## In the browser

- **Setup → Create**: a new identity and a new vault (both random entropy), the
  vault's 24 words shown and three of them checked (it holds the funds), one
  passphrase (≥ 4 characters as Docker counts them, Latin-1 only) for the
  vault. The identity is stored as `wallet.yaml`, the vault as `vault.yaml`
  encrypted with the passphrase.
- **Setup → Import Docker files**: `wallet.yaml` + `vault.yaml` + the vault
  password. Both are read and checked as above: `wallet.yaml` must be plain
  text and `vault.yaml` encrypted, so the funds' key is never stored in plain
  text. The identity is stored re-written from its entropy (plaintext, current
  format). The vault is stored as given, unless it is an old one whose address
  is encrypted; then it is re-written in the current format with the same
  password, so its address can be shown while locked.
- **Setup → Restore from words**: the vault's 24 words (required) and the
  identity's (optional; a new identity if left empty), then the passphrase.
- One setup runs at a time, from the UI or an agent; a second one is refused.
- **Home** shows both addresses at all times. The neuron runs from page load
  on the identity: it registers both public keys with central and signs
  central's login challenge ([central.md](central.md)). The vault card has **Unlock** (passphrase) or,
  while unlocked, **Lock**.
- **Backup** (Docker shows it behind login, so here it needs Unlock): the
  identity's and the vault's 24 words and private keys (WIF), and downloads of
  `wallet.yaml` and `vault.yaml`, which load in Docker.

## Code

`src/keys/`:

- `keys.js`: derivations above, `signMessage`/`verifyMessage`.
- `docker.js`: `readWallet(text, {password})`, `writeWallet(entropy, {password})`,
  `secrecy(text)` (plain, encrypted or mixed), `encryptField`/`decryptField`.
  Reused from `draft/v1-full` without Nostr and Base.
- `index.js`: the two-key model. `writeKeys({identity?, vault}, passphrase)`
  (create and restore) and `importDocker({walletText, vaultText, passphrase})`
  return `{walletYaml, vaultYaml}` to store; `loadIdentity(walletYaml)`,
  `vaultInfo(vaultYaml)` (the address and public key while locked, as Lite
  reads them for central's register, `start.py:4637-4667`),
  `unlockVault(vaultYaml, passphrase)`.

## Tests

Parity fixtures from the Docker image (`test/fixtures/identity-parity.json`,
made by `scripts/identity_fixtures.py` on `draft/v1-full`): words, WIF, pubkey,
address, scripthash, `wallet.yaml`; a current and an old vault with their
password and a wrong one; a WIF-only file; a file whose stored pubkey does not
match. `identity-js.json` holds signatures and a vault made by this JS code that
satorilib accepted. `satorilib-edges.json` (`scripts/satorilib_edges.py`, run
on the satorilib source with Docker's package versions): a Latin-1 password
vault, the unencrypted vault satorilib saves for a `€` password, and a
signature flagged uncompressed with what python-evrmorelib verifies it
against.

## Deviations from Docker, and why

- **Words at setup.** Docker never shows words; a browser's storage can be
  cleared by the browser itself, so the vault's words are shown and checked at
  setup.
- **No zip.** Docker downloads one zip; the browser downloads the two files
  (no zip dependency). Import takes the two files.
- **Words import.** Docker has none; it is the browser's other way back.
- **Wrong password is an error**, not a silently encrypted vault.
- **A vault must be encrypted.** satorilib opens a plain-text `vault.yaml`
  with any password and saves one when the password is outside Latin-1. The
  browser refuses both: Unlock would protect nothing.
- **Passphrases are Latin-1 only** at setup, because Docker can't encrypt with
  other characters (above). Docker only asks for ≥ 4 characters.
- **Stored fields that don't match the key are refused**, where satorilib
  warns and goes on. The vault's address shown while locked is the stored one,
  so a mismatch would show an address the key can't spend from.
- **A WIF-only file reads** (from its 52-char WIF); satorilib fails on it.
- **The identity and the vault must be different keys** (Docker never checks;
  the same key twice would put the funds' key unencrypted on disk).
- **Ticks run from page load with no login.** Docker's UI needs login, but its
  neuron process also runs on `wallet.yaml` alone (`start.py:75`).
- **Not yet:** `nostr.yaml` (Nostr step) and the Base address (Base step).
