# Central's register names the vault only by its Evrmore address

**Status:** open · **Kind:** foundation fix (proposal) · **Fix in:** central

## Today (verified on `central` base-upgrade f4d72f5, and live on central2 2026-10-16)

`POST /api/v1/peer/register` answers `{success, peer_id, wallet_address,
vault_address, eth_wallet_address, nostr_pubkey, message}`
(`PeerRegisterResponse`, `central/src/models/schemas.py:217-225`):

- `wallet_address` and `vault_address` are satorilib's `generateAddress` of
  each pubkey, an Evrmore P2PKH address (`central/src/main.py:821,858-859`);
- `eth_wallet_address` is never set by register (null in central2's answer).
  Where it is set (the login's answer, `Peer.__init__`) it is the identity's
  reverse-bridge burn address, its Base address with the last four
  characters replaced by `DEAD` (`central/src/utils/eth_address.py:60`), not
  the vault.

Central keeps the first vault registered for an identity and silently drops
one that conflicts (`central/src/main.py:816-833,862-878`), and payouts go to
the registered vault's Base address
(`central/src/scripts/distribution.py:48-53`). So the browser neuron checks
that central has its vault and shows a vault mismatch when it doesn't
(Satori Lite does not check: it ignores register's answer,
`satorilib/src/satorilib/server/server.py:402-405`). With only the Evrmore
form in the answer, the neuron must derive the Evrmore address of its vault
pubkey to compare: `centralAddress` in `src/central/index.js`
(base58check(0x21 ‖ ripemd160(sha256(pubkey)))). It is the last Evrmore code
in the app.

## Proposal

Also return the vault in a non-Evrmore form. An added field breaks no
client:

- `vault_pubkey`: central already stores it (`Peer.vault_pubkey`,
  `central/src/models/peer.py:19`); or
- `vault_base_address`: `derive_base_address_from_pubkey(vault_pubkey)`
  (`central/src/utils/eth_address.py:37`), the address the reward merkle
  tree is keyed by.

## What it would remove here

`centralAddress` and its test: the neuron compares the pubkey (or its Base
address) instead. The app then imports neither `@noble/hashes/legacy`
(ripemd160) nor `@scure/base`'s base58check, and has no Evrmore code at all.
