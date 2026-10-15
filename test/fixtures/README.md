Parity vectors for `src/keys/`. Throwaway keys.

- `identity-parity.json`: made from satorilib (the Docker neuron's code) by
  `scripts/identity_fixtures.py` on branch `draft/v1-full`: words, WIF, pubkey,
  address, scripthash, `wallet.yaml`, Evrmore message signatures; current and
  old vaults with their password and a wrong one; a WIF-only and a mismatched
  file; a Nostr key (for step 5).
- `identity-js.json`: signatures, a `wallet.yaml` and a `vault.yaml` made by
  this JS code, which satorilib accepted
  (`scripts/identity_crossverify.py` on `draft/v1-full`).
