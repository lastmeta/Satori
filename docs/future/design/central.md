# Central (what is left for later steps)

[← OVERVIEW](OVERVIEW.md)

Step 3 built register, the observations poll and the predictions batch:
[../../design/central.md](../../design/central.md) is the source of truth for
those, with Satori Lite's file:line evidence.

Still parked, for later steps:

| Call | Auth | Evidence | Step |
|---|---|---|---|
| `nostr-pubkey` header on `POST /api/v1/peer/register` (64 lowercase hex) | none | `central/src/main.py:722-735` | 5, Nostr ([transport.md](transport.md)) |
| `GET /api/v1/peer/relays`, `/api/v1/peer/relay-config` | none | `satorilib/src/satorilib/server/server.py:468` | 5, Nostr |
| `GET /api/v1/base/config` | none | `central/src/api/v1/endpoints/base.py:15-19` | 6, Base ([chain.md](chain.md)): boot, cached 1 h, bundled fallback |
| `GET /api/v1/merkle/root`, `GET /api/v1/merkle/proof/{vaultEthAddress}` | none | `central/src/api/v1/endpoints/merkle.py:26,45-58` | 6, Base: the Claim page ([chain.md](chain.md#claims)) |

Prod central answers 404 for the Base and merkle routes today; central2 serves
them ([issue](../issues/central-prod-missing-base-routes.md)). `draft/v1-full`
has `baseConfig()` (404 → null) and `merkleProof()` (root first, so the Claim
page can tell "route missing", "no drop" and "not in the drop" apart) with
tests: `git show draft/v1-full:src/central/index.js`.

Central-lite is earning-critical: its scored predictions become
`base_earnings` for the Base address derived from the registered vault pubkey,
which is what the merkle drop pays ([OVERVIEW](OVERVIEW.md#how-v1-earns-verified)).
