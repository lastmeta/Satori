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
3. **Publish to central**: login, register, predictions batch ([design/central.md](design/central.md)).
4. **Base**: delegate, daily batch, claims ([design/chain.md](design/chain.md)).
5. **Nostr**: subscribe to streams, publish `_pred` ([design/transport.md](design/transport.md)). This needs a wss relay.
6. **Better engine**: SES and backtest-driven selection ([design/engine.md](design/engine.md)).
7. **Runtime hardening**: catch-up, worker isolation of keys ([design/runtime.md](design/runtime.md)).

## Noticed while building

- A forgotten vault passphrase: the neuron keeps running on the identity, and
  the vault comes back only by restoring its 24 words. There is no "replace the
  vault" button on Home yet (setup is the only path).
- The unlocked vault and the identity live on the main thread; moving them
  into a worker is part of step 7.
- Ticks are spaced from the start of the last run; there is no catch-up for
  missed intervals while the tab was closed (step 7).
- Ticks fit on observation times, so a gap is honest, but a window that spans
  a long gap mixes old and new regimes. A better engine (step 6) may want to
  drop observations older than some multiple of the interval.
- ✅ `node_modules` was removed from `main`'s history (owner approved the
  force-push).
