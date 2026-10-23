# Peer register accepts any pubkeys without a signature

**Status:** fix in progress (the wallet's link, central `base-upgrade`, 2026-10-23) · **Kind:** fixable flaw · **Fix in:** central

## Precondition

Someone knows an alias's pubkey (it is public). They can:

- attach a wallet to that peer first, if none is set yet
  (`central/src/main.py:754`, first write wins);
- overwrite its `nostr_pubkey` at any time (`central/src/main.py:769`).

## Finding (verified)

`POST /api/v1/peer/register` read the alias's and the wallet's pubkeys,
`nostr-pubkey` and `neuron-version` from headers with no auth dependency
(`central/src/main.py:705-800`).

## Fix

The wallet signs its link to the alias and register carries it; central pays
only a linked wallet ([../design/wallets.md](../design/wallets.md#the-satori-network-register-login-and-the-link)).
The Nostr pubkey is still unsigned.
