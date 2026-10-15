# Peer register accepts any pubkeys without a signature

**Status:** open · **Kind:** fixable flaw · **Fix in:** central

## Precondition

Someone knows a wallet pubkey (it is public). They can:

- attach a vault to that peer first, if none is set yet
  (`central/src/main.py:754`, first write wins);
- overwrite its `nostr_pubkey` at any time (`central/src/main.py:769`).

## Finding (verified)

`POST /api/v1/peer/register` reads `wallet-pubkey`, `vault-pubkey`,
`nostr-pubkey`, `neuron-version` from headers with no auth dependency
(`central/src/main.py:705-800`).

## Fix

Require the JWT (or a wallet signature over the three pubkeys) on register. The
browser app sends its JWT on register regardless, so it is forward-compatible.
