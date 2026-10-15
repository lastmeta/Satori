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

1. **MVP** (now): keys, db, linear engine, local publish, basic UI.
2. **Docker key import/export**: wallet.yaml and vault.yaml, from the draft branch.
3. **Publish to central**: login, register, predictions batch ([design/central.md](design/central.md)).
4. **Base**: delegate, daily batch, claims ([design/chain.md](design/chain.md)).
5. **Nostr**: subscribe to streams, publish `_pred` ([design/transport.md](design/transport.md)). This needs a wss relay.
6. **Better engine**: SES and backtest-driven selection ([design/engine.md](design/engine.md)).
7. **Runtime hardening**: catch-up, worker isolation of keys ([design/runtime.md](design/runtime.md)).

## Noticed while building the MVP

- A forgotten passphrase leaves only one way back: import the 24 words. The
  MVP has no "use different words" button on Unlock; add one (it replaces the
  sealed key, keeps the data).
- The key lives on the main thread while unlocked; moving signing into a
  worker is part of step 7.
- Ticks are spaced from the start of the last run; there is no catch-up for
  missed intervals while the tab was closed (step 7).
- Ticks fit on observation times, so a gap is honest, but a window that spans
  a long gap mixes old and new regimes. A better engine (step 6) may want to
  drop observations older than some multiple of the interval.
- **Open decision (owner):** commit 2b6f30e pushed `node_modules` (~50 MB pack)
  into `main`'s history; e9cc109 untracked it. Removing it needs
  `git filter-repo --path node_modules --invert-paths` and a force-push of
  `main`, which is easiest while the repo is new.
