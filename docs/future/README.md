# Later steps (parked)

These were researched and reviewed on 2026-10-14/15 against Satori Lite
(`../neuron`), satorilib, central and the contracts. They are kept here so later
steps start from evidence, not from scratch.

- [design/OVERVIEW.md](design/OVERVIEW.md): the full v1 neuron that earns (central-lite, Base
  daily batch, delegate and claims, scheduler and catch-up, CSP), plus the
  component docs.
- [issues/](issues/README.md): blockers outside this repo. Prod central lacks
  the Base and merkle routes. The relay list is ws:// only, so a deployed
  (https) app can't connect to it; the http dev server can.
- Code: branch `draft/v1-full` holds half-built modules: Docker-compatible
  identity (with parity fixtures from the Python), the central client (with
  Python float/hash parity), Base chain reads, ABIs and transactions, and a
  naive/SES engine with a backtest.

## Suggested stair steps

1. ✅ **MVP**: keys, db, linear engine, local publish, basic UI.
2. ✅ **Two keys + Docker import/export**: identity (unencrypted) and vault
   (passphrase), `wallet.yaml`/`vault.yaml` ([../design/keys.md](../design/keys.md)).
3. ✅ **Central data flow**: register, poll, store, forecast, predictions batch, as Lite does it ([../design/central.md](../design/central.md)).
4. ✅ **Engine**, inspired by `../namaste_club`: `bar1`, a Bayesian AR(1) on 12 h returns faded toward persistence ([../design/engine.md](../design/engine.md)); left for later: [design/engine.md](design/engine.md).
5. ✅ **Nostr**: the Nostr key, discover, subscribe, intake, publish `_pred`, as Lite does it ([../design/nostr.md](../design/nostr.md)); left for later: [design/transport.md](design/transport.md). A deployed app needs a wss relay ([issue](issues/relays-not-wss.md)).
6. **Base** (last): delegate, daily batch, claims, as the dapp in `../contract/satori-ui` does ([design/chain.md](design/chain.md)).
7. **Finishing pass**, incl. runtime hardening: catch-up, worker isolation of keys ([design/runtime.md](design/runtime.md)).

## Noticed while building

- A forgotten vault passphrase: the neuron keeps running on the identity, and
  the vault comes back only by restoring its 24 words. There is no "replace the
  vault" button on Home yet (setup is the only path).
- The unlocked vault and the identity live on the main thread; moving them
  into a worker is part of step 7.
- Central's batch holds only each stream's latest observation and the neuron
  polls every 11 h, so local history grows by about two points per stream a
  day (Lite has the same limit). The engine needs an observation every 12 h
  (6 lag pairs of back-to-back 12 h buckets): with 11 h polls a stream gets
  `bar1` after about 4 days. A daily stream (`crypto_fear_greed`) or a tab
  open only part of the day (one poll a day) stays `naive`; gaps are not
  bridged.
- central2's scheduler is stale (newest observation 2026-10-14 23:00 UTC); its
  batch is empty once that is older than 48 h (about 2026-10-16 23:00 UTC), so
  dev polls then store nothing until central2 runs again.
- Browsers throttle timers in background tabs: a poll can run late, never
  early. A tab closed past its poll time polls 5–30 min after the next load.
- ✅ `node_modules` was removed from `main`'s history (owner approved the
  force-push).
- The brief's ids for the `_pred` 34601 and the 34602 (345fa77e…, 484c59ab…)
  hold only with compact JSON content; satorilib's `json.dumps` writes
  `", "` and `": "`, so Lite's ids for the same events are 3e82a076… and
  13dc7e51… (`test/fixtures/nostr-parity.json`, made by satorilib's own client).
- `_pred` ships t2: Lite's `predictForRelay` returns the first row of
  `_runForecast`'s second, autoregressed forecast (`engine-lite/engine.py:733-735,
  1176-1186`). (Step 5 first shipped t1; a review caught it.) Lite's bounty
  scorer, though, scores against the next observation: flagged in
  [../design/nostr.md](../design/nostr.md#the-engines-step).
- A relay keeps one of two replaceable events with the same `created_at`
  (NIP-01): two `_pred` of one stream in one second lose one, as in Lite
  ([../design/nostr.md](../design/nostr.md#inherent-as-in-lite)).
- Satorian's catalog, 2026-10-15: 1,061 announcements, 924 live (111 of them
  `_pred`) from 43 providers; e5e6… alone announces ~400 streams.
