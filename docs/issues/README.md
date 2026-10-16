# Issues

Blockers and flaws that need a change **outside this repo**, plus the browser
limits that no change can remove. Paths are relative to `/code/Satori/`.
Design: [../design/OVERVIEW.md](../design/OVERVIEW.md).

## Fixable — blocks v1

| Issue | Where the fix goes | Blocks |
|---|---|---|
| [central-prod-missing-base-routes.md](central-prod-missing-base-routes.md) | central deploy | merkle claim on prod; live Base config (the app uses the bundled addresses there) |

## Fixable — blocks Nostr in a deployed (https) app

| Issue | Where the fix goes | Blocks |
|---|---|---|
| [relays-not-wss.md](relays-not-wss.md) | relay hosting + central | central's relays from an https page (works on the http dev server; the deployment uses `wss://app.satorinet.io/relay` by default) |

## Fixable — flaws to fix, not blocking

| Issue | Where | Precondition |
|---|---|---|
| [token-hook-gas-estimate.md](token-hook-gas-estimate.md) | contracts (a rewards upgrade now; token and hub at the next redeploy) | a delegated vault receives SATORI (a claim, a transfer, from anyone: 1 wei is enough) with an estimated gas limit: it can never undelegate, and its SATORI stays locked. The browser app pads only its own writes |
| [central-login-replayable.md](central-login-replayable.md) | central | someone sees one login header set |
| [central-register-unauthenticated.md](central-register-unauthenticated.md) | central | someone knows a wallet pubkey (public) |
| [base-batch-one-bad-game-reverts-all.md](base-batch-one-bad-game-reverts-all.md) | Docker neuron (the browser simulates each game) | a game with no new value since our last prediction on it |
| [duckdb-wasm-opfs-wal.md](duckdb-wasm-opfs-wal.md) | DuckDB (replay), DuckDB-WASM (the OPFS WAL); worked around here | a write committed without a checkpoint on OPFS: lost on reload, or (an ALTER on a table with a nextval default) the database does not open |

## Fixable — needed for later scope

| Issue | Where | Needed for |
|---|---|---|
| [relayer-predict-fee.md](relayer-predict-fee.md) | relayer fee policy (owner ruling) | gasless predictions |
| [mundo-no-cors.md](mundo-no-cors.md) | Mundo | EVR-less SATORIEVR sends, channel claims |
| [electrumx-wss.md](electrumx-wss.md) | ElectrumX operators | Evrmore balances/sends with redundancy |
| [satorilib-paid-observation-parse.md](satorilib-paid-observation-parse.md) | satorilib | fetching latest value of a paid stream |

Housekeeping, not blocking: nginx answers central `/health` without CORS
(`central/nginx.conf:58-62,142-146`; the app calls neither `/health` nor `/`:
register's answer says whether central is up); the local
`/code/Satori/satorilib` checkout is behind `origin/base-upgrade` (dec62db).

## Inherent browser limits

Accepted behaviour; designed around, not fixable.

- No tab open, no neuron: a UTC day with no open tab misses that round's Base
  batch ([runtime.md](../plans/runtime.md)).
- iOS suspends a backgrounded page within seconds: foreground-only on iPhone.
- A browser cannot host a Nostr relay (no listening sockets).
- Arbitrary data-source URLs are subject to CORS (affects own data sources, later).
- Browser storage can be evicted; backup words are mandatory.
- Signing keys are JS bytes in memory (no secp256k1 in WebCrypto): the
  identity and the Nostr key always, the vault only while unlocked (Unlock
  to Lock). Today that memory is the main thread's; a worker is planned
  ([runtime.md](../plans/runtime.md)).
