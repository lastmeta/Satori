# Central (what is left for later steps)

[← OVERVIEW](OVERVIEW.md)

Everything parked here is built: register, the observations poll and the
predictions batch (step 3, [../../design/central.md](../../design/central.md)),
the `nostr-pubkey` header and the relay list (step 5,
[../../design/nostr.md](../../design/nostr.md)), `GET /api/v1/base/config`
and the merkle root and proof (step 6, [../../design/base.md](../../design/base.md)).
Prod central still answers 404 for the Base and merkle routes; central2 serves
them ([issue](../issues/central-prod-missing-base-routes.md)).

Central-lite is earning-critical: its scored predictions become
`base_earnings` for the Base address derived from the registered vault pubkey,
which is what the merkle drop pays ([OVERVIEW](OVERVIEW.md#how-v1-earns-verified)).
