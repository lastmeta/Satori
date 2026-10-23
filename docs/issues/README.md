# Issues

Blockers and flaws that need a change **outside this repo**, plus the browser
limits that no change can remove. Paths are relative to `/code/Satori/`.
Design: [../design/OVERVIEW.md](../design/OVERVIEW.md).

## Fixable — blocks v1

| Issue | Where the fix goes | Blocks |
|---|---|---|
| [central-prod-missing-base-routes.md](central-prod-missing-base-routes.md) | central deploy | merkle claim on prod; live Base config (the app uses the bundled addresses there) |

## Fixable — flaws to fix, not blocking

| Issue | Where | Precondition |
|---|---|---|
| [relays-not-wss.md](relays-not-wss.md) | central (lists a `wss://` address itself; waits on the relay redesign) | a page served over https (any deployment) can't open central's `ws://satorian.satorinet.io:7777`. Worked around 2026-10-20: the app reaches it through its wss stand-in, `wss://relay.satorinet.io` (a TLS front on central's nginx-proxy); any other `ws://` relay central lists stays blocked there |
| [token-hook-gas-estimate.md](token-hook-gas-estimate.md) | contracts: fixed on `humble` (86e2bdb3), live on D7 (2026-10-23) | on D6, a staked wallet receives SATORI (a claim, a transfer, from anyone: 1 wei is enough) with an estimated gas limit: it can't unstake, and its SATORI can't be sent. The app pads its own writes, offers staking as advice with the risk said, and detects the frozen state exactly |
| [central-login-replayable.md](central-login-replayable.md) | central | someone sees one login header set |
| [central-register-unauthenticated.md](central-register-unauthenticated.md) | central: fix in progress (the wallet's link) | someone knows an alias's pubkey (public) |
| [base-batch-one-bad-game-reverts-all.md](base-batch-one-bad-game-reverts-all.md) | Docker neuron (the browser simulates each game) | a game with no new value since our last prediction on it |
| [duckdb-wasm-opfs-wal.md](duckdb-wasm-opfs-wal.md) | DuckDB (replay), DuckDB-WASM (the OPFS WAL); worked around here | a write committed without a checkpoint on OPFS: lost on reload, or (an ALTER on a table with a nextval default) the database does not open |

## Fixable — needed for later scope

| Issue | Where | Needed for |
|---|---|---|
| [relayer-predict-fee.md](relayer-predict-fee.md) | relayer fee policy (owner ruling) | gasless predictions |
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
  alias and the Nostr key always, the wallet only while unlocked (Unlock
  to Lock). Today that memory is the main thread's; a worker is planned
  ([runtime.md](../plans/runtime.md)).
