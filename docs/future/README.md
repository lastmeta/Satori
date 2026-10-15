# Later steps (parked)

These were researched and reviewed on 2026-10-14/15 against Satori Lite
(`../neuron`), satorilib, central and the contracts. They are kept here so later
steps start from evidence, not from scratch.

- [design/OVERVIEW.md](design/OVERVIEW.md): the full v1 neuron that earns (central-lite, Base
  daily batch, delegate and claims, scheduler and catch-up, CSP), plus the
  component docs.
- [issues/](issues/README.md): blockers outside this repo. Prod central lacks
  the Base and merkle routes. The relay list is ws:// only, so a browser can't
  connect to it.
- Code: branch `draft/v1-full` holds half-built modules: Docker-compatible
  identity (with parity fixtures from the Python), the central client (with
  Python float/hash parity), Base chain reads, ABIs and transactions, and a
  naive/SES engine with a backtest.

## Suggested stair steps

1. ✅ **MVP**: keys, db, linear engine, local publish, basic UI.
2. ✅ **Two keys + Docker import/export**: identity (unencrypted) and vault
   (passphrase), `wallet.yaml`/`vault.yaml` ([../design/keys.md](../design/keys.md)).
3. ✅ **Central data flow**: register, poll, store, forecast, predictions batch, as Lite does it ([../design/central.md](../design/central.md)).
4. **Engine**, inspired by `../namaste_club` ([design/engine.md](design/engine.md)).
5. **Nostr**: subscribe to streams, publish `_pred` ([design/transport.md](design/transport.md)). This needs a wss relay.
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
  day (Lite has the same limit). The step-4 engine starts from little data.
- central2's scheduler is stale (newest observation 2026-10-14 23:00 UTC); its
  batch is empty once that is older than 48 h (about 2026-10-16 23:00 UTC), so
  dev polls then store nothing until central2 runs again.
- Browsers throttle timers in background tabs: a poll can run late, never
  early. A tab closed past its poll time polls 5–30 min after the next load.
- ✅ `node_modules` was removed from `main`'s history (owner approved the
  force-push).
