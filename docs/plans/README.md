# Roadmap

The steps, as the owner set them (2026-10-15: [../intent/INTENT.md](../intent/INTENT.md)),
and what is left. What is built is in [../design/](../design/OVERVIEW.md); this
folder keeps what is left of each part, researched against Satori Lite
(`../neuron`), satorilib, central and the contracts, with file:line evidence:
[runtime](runtime.md), [Nostr transport](transport.md), [chain](chain.md),
[engine](engine.md). Blockers outside this repo: [../issues/](../issues/README.md).
Questions for the owner: [../inbox/QUESTIONS.md](../inbox/QUESTIONS.md).

## Steps

1. ✅ **MVP**: keys, db, linear engine, local publish, basic UI.
2. ✅ **Two keys + Docker import/export**: identity (unencrypted) and vault
   (passphrase), `wallet.yaml`/`vault.yaml` ([../design/keys.md](../design/keys.md)).
3. ✅ **Central data flow**: register, poll, store, forecast, predictions batch, as Lite does it ([../design/central.md](../design/central.md)).
4. ✅ **Engine**, inspired by `../namaste_club`: `bar1`, a Bayesian AR(1) on 12 h returns faded toward persistence ([../design/engine.md](../design/engine.md)); left for later: [engine.md](engine.md).
5. ✅ **Nostr**: the Nostr key, discover, subscribe, intake, publish `_pred`, as Lite does it ([../design/nostr.md](../design/nostr.md)); left for later: [transport.md](transport.md). A deployed app needs a wss relay ([issue](../issues/relays-not-wss.md)).
6. ✅ **Base**: delegate prediction power, the identity's daily batch, claims (`hub.claim`, merkle, airdrop), sends, as Lite does it and the dapp in `../contract/satori-ui` goes further ([../design/base.md](../design/base.md)); left for later: [chain.md](chain.md). A local fork for the dev server: `scripts/fork.mjs`.
7. ✅ **Finishing pass**: simpler code that follows what Lite and satorilib
   already do (one schedule, one serial line, one stub central, shared
   constants, no dead code), a Home grouped by key, and agents first
   (`/llms.txt`, `<body data-screen>`, `data-test` on every action).
8. **Runtime hardening**: catch-up on resume, the keys in a worker,
   `navigator.storage.persist()` ([runtime.md](runtime.md)).
9. **Later**, in rough order of value per effort: a per-stream chart and model
   view; bounties (the predictor's side first); the gasless relay (needs a
   ruling, [issue](../issues/relayer-predict-fee.md)); Evrmore balances and
   SATORIEVR sends; paid streams and payment channels; own data sources. Also:
   importing a Docker neuron's keys is a move (both would predict for one
   identity; the chain refuses a second batch per round), so Import could say
   to stop the Docker neuron.

## Noticed while building

### Fixable (each with when it bites)

- **A forgotten vault passphrase.** When the user forgets it, the neuron keeps
  running on the identity, but the vault comes back only by restoring its 24
  words, and Setup is the only path: Home has no "replace the vault". Fix: a
  restore-the-vault flow on Home.
- **Keys on the main thread.** When a script runs in the page (an XSS, a
  malicious extension), it can read the identity, the Nostr key and an
  unlocked vault. Fix: the keys and signing in a worker (step 8).
- **The token's hook starves on an estimated gas limit.** When a delegated
  vault receives SATORI (any claim, any transfer to it) in a transaction sent
  with `eth_estimateGas`'s limit, the token's try/catch hook fails silently
  and the vault can never undelegate (Panic 0x11); anyone can do it to any
  delegated vault with 1 wei. The app pads its own writes by 500,000 gas,
  which protects only those; the fix belongs in the contracts
  ([issue](../issues/token-hook-gas-estimate.md)).
- **Every browser neuron votes DOWN on Base for now.** When a forecast equals
  the latest value (`naive`, or `bar1` with weight or φ 0), Lite's rule
  (UP if t2 > the latest, else DOWN) votes DOWN; D6's one stream has two
  values, so every browser neuron is `naive` there. A seeded slope rule is
  parked as an option ([engine.md](engine.md)).
- **`StaleValue` every other round.** When a daily stream is written later in
  hour 0 than the 00:01 batch, the contract (which compares clock hours)
  refuses the game every other round; the batch still goes at the first check
  of the round ([../design/base.md](../design/base.md#when-in-the-round)).

### Inherent (as in Lite, or the browser's)

- Central's batch holds only each stream's latest observation and the neuron
  polls every 11 h, so local history grows by about two points per stream a
  day (Lite has the same limit). The engine needs an observation every 12 h
  (6 lag pairs of back-to-back 12 h buckets): with 11 h polls a stream gets
  `bar1` after about 4 days. A daily stream (`crypto_fear_greed`) or a tab
  open only part of the day (one poll a day) stays `naive`; gaps are not
  bridged.
- Browsers throttle timers in background tabs: a poll can run late, never
  early. A tab closed past its poll time polls 5–30 min after the next load.
- A relay keeps one of two replaceable events with the same `created_at`
  (NIP-01): two `_pred` of one stream in one second lose one, as in Lite
  ([../design/nostr.md](../design/nostr.md#inherent-as-in-lite)).
- A vault's delegator share of the identity's wins shows on the lens only
  after its loyalty builds (on the fork: 9 rounds after delegating, with the
  default stream moving), so the first rounds' Claim finds 0 on-chain rewards.
- On a fork moved ahead in time the Base card's times are the chain's (days
  ahead of the wall clock), while the next check is local time.
