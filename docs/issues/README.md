# Issues

Blockers and flaws that need a change **outside this repo**, plus the browser
limits that no change can remove. Paths are relative to `/code/Satori/`.
Design: [../design/OVERVIEW.md](../design/OVERVIEW.md).

## Fixable — blocks v1

| Issue | Where the fix goes | Blocks |
|---|---|---|
| [relays-not-wss.md](relays-not-wss.md) | relay operators (+ optionally central) | following streams, publishing `_pred` |
| [central-prod-missing-base-routes.md](central-prod-missing-base-routes.md) | central deploy | merkle claim on prod; live Base config |

## Fixable — flaws to fix, not blocking v1

| Issue | Where | Precondition |
|---|---|---|
| [central-login-replayable.md](central-login-replayable.md) | central | someone sees one login header set |
| [central-register-unauthenticated.md](central-register-unauthenticated.md) | central | someone knows a wallet pubkey (public) |
| [base-batch-one-bad-game-reverts-all.md](base-batch-one-bad-game-reverts-all.md) | Docker neuron | a subscribed stream with no new value since the last prediction |
| [central-health-no-cors.md](central-health-no-cors.md) | central nginx | browser wants `/health` |
| [satorilib-checkout-behind.md](satorilib-checkout-behind.md) | local checkout | reading satorilib as the reference |

## Fixable — needed for later scope

| Issue | Where | Needed for |
|---|---|---|
| [relayer-predict-fee.md](relayer-predict-fee.md) | relayer fee policy (owner ruling) | gasless predictions |
| [mundo-no-cors.md](mundo-no-cors.md) | Mundo | EVR-less SATORIEVR sends, channel claims |
| [electrumx-wss.md](electrumx-wss.md) | ElectrumX operators | Evrmore balances/sends with redundancy |
| [satorilib-paid-observation-parse.md](satorilib-paid-observation-parse.md) | satorilib | fetching latest value of a paid stream |

## Inherent browser limits

Accepted behaviour; designed around, not fixable.

- No tab open, no neuron: a day with no open tab misses that day's Base batch
  ([runtime.md](../design/runtime.md)).
- iOS suspends a backgrounded page within seconds: foreground-only on iPhone.
- A browser cannot host a Nostr relay (no listening sockets).
- Arbitrary data-source URLs are subject to CORS (affects publishing own
  data sources, later).
- Browser storage can be evicted; backup words are mandatory.
- Signing keys are JS bytes in worker memory while unlocked (no secp256k1 in
  WebCrypto).
