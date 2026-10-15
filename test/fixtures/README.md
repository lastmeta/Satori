Parity vectors for `src/keys/`. Throwaway keys.

- `identity-parity.json`: made from satorilib (the Docker neuron's code) by
  `scripts/identity_fixtures.py` on branch `draft/v1-full`: words, WIF, pubkey,
  address, scripthash, `wallet.yaml`, Evrmore message signatures; current and
  old vaults with their password and a wrong one; a WIF-only and a mismatched
  file; a Nostr key (for step 5).
- `identity-js.json`: signatures, a `wallet.yaml` and a `vault.yaml` made by
  this JS code, which satorilib accepted
  (`scripts/identity_crossverify.py` on `draft/v1-full`).
- `satorilib-edges.json`: edge cases from satorilib's own code
  (`scripts/satorilib_edges.py`, run against the satorilib source with
  Docker's package versions): a vault whose password is Latin-1 (pycryptodome
  turns a str password into Latin-1 bytes), the plain-text vault satorilib
  saves when the password is outside Latin-1, and a signature flagged
  uncompressed with what python-evrmorelib verifies it against.
