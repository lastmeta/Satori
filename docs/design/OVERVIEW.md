# satori: overview

This is the source of truth for what is built (steps 1–6, the finishing
pass, the installable app and the deployment). Intent: [../intent/INTENT.md](../intent/INTENT.md). The roadmap and
what is left: [../plans/README.md](../plans/README.md). Open issues:
[../issues/](../issues/README.md). Questions for the owner:
[../inbox/QUESTIONS.md](../inbox/QUESTIONS.md). For agents, and the one
reference for `window.satori`: [/llms.txt](../../public/llms.txt).

Component docs: [keys.md](keys.md), [central.md](central.md),
[engine.md](engine.md), [nostr.md](nostr.md), [base.md](base.md),
[storage.md](storage.md), [pwa.md](pwa.md) (the installed app),
[deploy.md](deploy.md) (the image at neuron.satorinet.io, and the build
variables).

## The flow

The neuron runs central's data flow the way Satori Lite (the Docker neuron)
does ([central.md](central.md)):

```
page load ──▶ register with central (identity + vault public keys)
first poll 5–30 min later, then every 11 h (or Poll now):
  GET observations ──▶ store (DuckDB) ──▶ history for new streams ──▶ forecast streams with a new row ──▶ queue ──▶ login (identity) ──▶ POST predictions
                       insert or ignore    once per stream (central)    each one's bvar spec, evolved      pending      signs the challenge    batch; kept on failure
```

1. **Register** on every page load: `wallet-pubkey` (identity), `vault-pubkey`
   (read from `vault.yaml` while locked), `nostr-pubkey` and `neuron-version`. The result is
   shown on Home, with a **vault mismatch** if central holds another vault for
   this identity.
2. **Poll** central's observations batch (the latest observation of each
   stream, under 48 h old). The next poll time is stored, so a reload keeps
   the 11 h cadence; a due one waits Lite's 5–30 min start jitter.
3. **Store** each observation once per (stream, whole second).
4. **History**: a stream seen for the first time gets its past from central
   (`/observations/history`, an addition beyond Lite; up to 1,000 hourly rows),
   stored older than its newest polled row, so it never triggers a prediction
   ([central.md](central.md#history-an-addition-beyond-lite)). Central2 answers
   404 today: remembered for a day, then asked again.
5. **Forecast** only the streams that got a new row, from all their stored
   history ([engine.md](engine.md)): `t1` 12 h ahead and `t2` 24 h ahead.
   Each target has its **own spec**, drawn from the identity: `bvar`, a
   Bayesian VAR(1) of the target and 1–3 companion streams (namaste_club's
   Minnesota prior with the spec's λ1 and λ2), faded toward persistence by its
   own backtest. After each poll one mutation of each spec (swap, add or drop
   a companion, move λ1 or λ2) is scored on the same backtest and kept only if
   it beats the champion by the margin, so neurons start differently and each
   keeps what predicts better. A spec that can't fit yet falls back to `bar1`
   (the AR(1) of the target alone), then `naive` (the last value); the
   prediction's `model` says which. `bar1` needs 6 lag pairs of back-to-back
   12 h buckets (about 4 days of 11 h polls without history); `bvar` 7–9
   aligned rows.
6. **Submit** everything pending right after the poll, as Lite's payload
   (`value` = t2, `t1_value`, `observed_at`, `hash`, byte-identical strings).
   A batch central rejects (`successful == 0`) or a failed call keeps the
   predictions for the next poll; ones older than 2 × 11 h are dropped.
   A network error, a timeout or a 5xx is resent once.

No passphrase is needed: the identity key is unencrypted, as in Docker.

Next to it, the neuron follows Satori streams on Nostr relays and publishes a
prediction stream for each, as Lite does ([nostr.md](nostr.md)). Relay
streams are kept apart from central's: relay predictions go only to Nostr.

```
relays = central's /peer/relays + Settings      subscribe (Network streams): 34602 + `<stream>_pred` 34600
REQ follow {kinds:[34601], authors:[p], #d:[…]} ──▶ verify ──▶ store once ──▶ forecast (one cadence ahead) ──▶ `<stream>_pred` 34601, seq + 1
on each (re)connect and hourly: announce `<stream>_pred`; hourly: relay list, reconnect; daily: NIP-65
```

On the dev server central's relays (satorian, production) are **read only**
(REQ, never EVENT) and the user's relays default to the test relay
`ws://localhost:7778` (`scripts/test-relay.mjs`); a build writes to central's
relays, and its own relays are `VITE_NOSTR_RELAYS` (none unless set; the
deployment's: `wss://app.satorinet.io/relay`).

On Base the neuron predicts as Lite does ([base.md](base.md)): the vault
delegates its prediction power to the identity once (Unlock), and the
identity sends one batch of up/down predictions each UTC round on its own.

```
status (no key): one multicall ── ETH ×2, the vault's SATORI, delegation, fee, lock, round, claimables
Unlock ─▶ Delegate: identity setPredictorFee(0), setAllowedDelegator(vault) ─▶ vault delegatePredictionPower(identity)
each round, first check: power > 0, no batch yet ─▶ registry streams with a game ─▶ engine (≥ 24 h ahead) vs latest: UP/DOWN
     ─▶ simulate each game alone ─▶ predictMultipleWithPayloads(the ones that pass) ─▶ receipt ─▶ persist
Unlock ─▶ Claim: hub.claim() · merkle (central's proof) · airdrop      Send: ETH; SATORI when not transfer-locked
```

On the dev server the Base RPC is `/rpc`, which Vite proxies to a local
anvil fork of Base Sepolia (`scripts/fork.mjs`); a build uses central's RPC
(`https://sepolia.base.org`) with publicnode as a fallback, or `VITE_BASE_RPC`
alone when the build sets it.

## Parts

| Part | Folder | Does |
|---|---|---|
| keys | `src/keys/` | Satori's two keys ([keys.md](keys.md)): the **identity** (`wallet.yaml`, unencrypted, signs on its own) and the **vault** (`vault.yaml`, fields encrypted with the passphrase as Docker does, holds funds). Create, restore from words, import/export the Docker files, Unlock/Lock the vault, sign and verify Evrmore messages. Each key's Base (EVM) address and transaction signatures (`signDigest`), inside the signer so Lock still wipes it ([base.md](base.md#keys-on-base)). Also the **Nostr key** (`nostr.yaml`, random, plaintext as in Docker; [nostr.md](nostr.md)). |
| central | `src/central/` | Central's API as Lite calls it ([central.md](central.md)): `register`, `observations`, `submitPredictions` (login, one retry on 401); `predictionItem` (the payload and its hash, with Python's float strings from `src/py.js`); `normalizeObservation` (Lite's `EPOCH` bounds); for Base `baseConfig`, `merkleProof`. 15 s timeouts; network errors wrapped. |
| chain | `src/chain/` | The D6 contracts on Base Sepolia over viem ([base.md](base.md)): the bundled addresses with central's config over them (`config.js`), minimal ABIs (`abi.js`), and `createChain`: the status multicall, delegate/stop, the batch's pieces, streams kept by voting weight, claims, sends; every write simulated first, one at a time, with gas over the estimate for contract calls. Its test doubles (a fake D6 behind JSON-RPC) are in `test/`. |
| db | `src/db/` | DuckDB-WASM 1.32.0 on OPFS (`opfs://satori-mvp.duckdb`), tables `meta`, `streams`, `observations`, `predictions`, `model_specs`, and for Nostr `relay_streams`, `relay_observations`, `relay_predictions`; ordered migrations; every call one at a time ([storage.md](storage.md): tables, migrations, every meta key, the checkpoint rule). Times are unix seconds. |
| engine | `src/engine/` | `forecast(points, { step, horizon }) → {model, t1, t2, value, horizon, phi?, weight?} \| null` ([engine.md](engine.md)): `bar1`, `bar1d` (the same on changes, for a series with a value ≤ 0) or `naive`; step 12 h for central, a relay stream's cadence; `value` one cadence ahead (24 h for central: t2). For central's streams `runModels` (`evolve.js`): each target's spec (identity-seeded), one mutation per poll kept by the margin, and its `bvar` forecast (`bvar.js`, a Bayesian VAR(1) with 1–3 companions) or the fallback. Pure (sha256 from `@noble/hashes` for the seeded draws). |
| nostr | `src/nostr/` | NIP-01 events over `@noble/curves` schnorr (`event.js`), Satori's events and parsing byte for byte as satorilib (`satori.js`), one relay over a WebSocket with reconnect (`relay.js`) ([nostr.md](nostr.md)). |
| neuron | `src/neuron/` | `register`, `cycle` (poll → store → history → forecast → submit), `history.js` (central's history for new streams), central's status, the poll schedule (`createPoller` over `schedule.js`, which the Base check shares), one tab only (a Web Lock); `nostr.js`: relays, discover, subscribe, intake → `_pred`, reconcile; `base.js`: the daily batch and its schedule, delegate, claims, sends, the Base settings. |
| ui | `src/ui/` | ArrowJS screens: Setup (create / restore from words / import Docker files), Home (the keys with their Evrmore, Base and Nostr identifiers, Unlock/Lock, the storage line and Install Satori; Central with Poll now and the collapsed streams; Nostr; Network streams; Base; Settings; Backup). `format.js`: display text. |
| pwa | `src/pwa/`, `public/manifest.webmanifest` | The installed app ([pwa.md](pwa.md)): the manifest and the Satori icons; the service worker (`sw.js`, written to `dist/sw.js` by a build-only Vite plugin; none on the dev server): precaches the page and the hashed assets (DuckDB's wasm and worker), cache first for `/assets/`, network first for the page, nothing else touched; "Update ready, reload"; Install Satori (Chromium's prompt, Safari's Add to Dock / Home Screen); persistent storage asked for at start, shown on Home. It never runs the neuron while closed. |
| agents | `src/main.js`, `public/llms.txt` | `window.satori`: the same actions as the UI for an AI agent in the page, under the same guards; `<body data-screen>` and `data-test` on what carries data or an action. [/llms.txt](../../public/llms.txt) is the one reference for both: what the app is, how to drive it, what's possible, where the code is, and that pull requests are welcome. |
| config | `src/config.js` | Settings' defaults ([deploy.md](deploy.md#build-variables)): the dev server's (central2, the test relay, central's relays read only, `/rpc`) or a build's (prod central, no user relay, central's relays written to, central's RPC), each replaced by its `VITE_*` variable when the build sets one. `vite.config.js` runs the same check before a build, so a bad value stops it; a build's bundle holds only its own defaults. |
| deploy | `deploy/`, `scripts/deploy-image.sh` | The static image ([deploy.md](deploy.md)): nginx serving `dist/` behind central's nginx-proxy (TLS there), the CSP from `csp.js` on every response, immutable `/assets/`, `no-cache` for the rest, gzipped copies, the SPA fallback. |
| shared | `src/util.js`, `src/py.js` | `serial()` (one at a time, in order: the db, the chain's writes, Nostr's intake and outbox), `isHttps()`, `isRelayUrl()`; Python's `str(float)` and `json.dumps` texts, byte for byte (central's payloads, every Nostr event's content). |
| tests | `test/`, `e2e/` | Parity fixtures and test doubles (a fake D6 behind JSON-RPC, an in-memory DuckDB); Playwright specs and their one stub central (`e2e/stub.js`). |

## Rules

- Two keys, on purpose, as Satori Lite ([keys.md](keys.md)). The identity
  is stored unencrypted so the neuron runs from page load and signs on its
  own: central's login, its Nostr announcements' `wallet_pubkey`, the daily
  Base batch. The vault is stored encrypted and holds the funds; **Unlock**
  (the passphrase, in the Keys card) decrypts it into memory and **Lock**
  (in the header while unlocked) wipes it. The neuron never needs the vault.
- Backup (both keys' words and private keys, the `wallet.yaml`,
  `vault.yaml` and `nostr.yaml` downloads) needs Unlock, as Docker's
  dashboard needs login.
- **Central URL** (Settings, `meta.central_url`): https only. Empty means the
  default: `https://central2.satorinet.io` on the dev server (so nobody writes
  to prod from a dev checkout), `https://network.satorinet.io` in a build, or
  the build's `VITE_CENTRAL_URL` ([deploy.md](deploy.md#build-variables); the
  deployment: central2 for now).
  Saving registers there at once; a different URL drops the pending
  predictions and the stream list (another central has other uuids), which
  refill with the next poll.
- **Poll now** (and `window.satori.poll()`) runs a cycle at once; the next
  poll is then 11 h later. One cycle runs at a time. A cycle never throws:
  central's errors and local ones (the database) are logged and shown as the
  last poll or submission.
- Predictions are not signed one by one: as in Lite, the login signature
  authenticates the batch.
- A database from a newer app version is refused, not migrated. Setup writes
  only its own rows (`meta.wallet_yaml`, `meta.vault_yaml`, `meta.nostr_yaml`)
  and leaves any other row as it is.
- One setup runs at a time, from the UI or an agent (`window.satori.setup`):
  both take the same guard, and a second one is refused.
- Import takes `wallet.yaml` only in plain text and `vault.yaml` only
  encrypted; files in each other's slots are refused as swapped. The vault is
  never stored in plain text. Passphrases are Latin-1 only, as Docker's
  encryption needs ([keys.md](keys.md#the-files)).
- Only one tab opens the database. Other tabs say "Satori is open in another tab";
  an installed app's window counts as a tab ([pwa.md](pwa.md#one-neuron)).
- The service worker exists only in a build and caches only this origin's
  `/assets/` and the page; a new version waits for **Update ready, reload**
  and never reloads the page on its own. The neuron asks for persistent
  storage after setup and on each load until it is kept ([pwa.md](pwa.md)).
- OPFS keeps what DuckDB has checkpointed, so every write that must survive
  a closed tab is checkpointed at once ([storage.md](storage.md#the-checkpoint-rule)).
- The page is sent with a strict CSP header: no inline script,
  `'wasm-unsafe-eval'` for DuckDB, `connect-src 'self' https: wss: ws:` for the
  chosen central and the relays. An https page still can't open `ws://`
  (mixed content), so a deployed app needs `wss://` relays
  ([issue](../issues/relays-not-wss.md)).
- The Nostr key is stored unencrypted like the identity, so the neuron signs
  its events on its own. `nostr.yaml` downloads need Unlock, as the other
  files: they are private keys.
- Base: the identity signs the daily batch on its own; the vault signs only
  after Unlock (delegate, stop, claims, sends). Transactions go only to the
  configured RPC (Settings, `meta.base_rpc_url`: https or a same-origin path);
  the dev server's default is the local fork, so by default a checkout does
  not send to a public chain; an RPC on another chain is refused
  ([base.md](base.md#config)). The unattended batch has a max-fee ceiling.

## Tech (pinned)

`@duckdb/duckdb-wasm` 1.32.0 (newer `latest` builds don't write to OPFS),
`@arrow-js/core` 1.0.6, `@noble/curves` 1.9.7, `@noble/hashes` 1.8.0 (also
the payload hash), `@scure/base` 1.2.6, `@scure/bip39` 1.6.0, `js-yaml` 5.4.2
(step 2: reads and writes Docker's `wallet.yaml`/`vault.yaml`, whose PyYAML
output folds long lines), `vite` 8.3.1, `vitest` 4.1.11, `@playwright/test`
1.63.0. Steps 3 and 4 added no dependency. Step 5 added only a dev dependency,
`ws` 8.22.0, for the test relay and the node-side scripts (the browser has
WebSocket); nostr-tools was not needed ([nostr.md](nostr.md#deviations-from-satori-lite-and-why)).
Step 6 added `viem` 2.37.0 (released 2025-09-02, as the parked design
planned): ABI encoding, multicall, transaction serialization and the RPC
client for Base; signing stays in `src/keys` (`@noble/curves`). The
installable app added none (no Workbox: the service worker is about 25 lines).
`bvar` added none (plain JS k×k solves; its seeded draws use `@noble/hashes`'
sha256, already a dependency). The deploy image added none to npm; it is
`nginx:1.30.5-alpine3.24` (2026-09-23), pinned by digest in `deploy/Dockerfile`.

## Verify

- `npm test` (vitest, `--maxWorkers=2`): keys (satorilib parity vectors,
  Docker `wallet.yaml`/`vault.yaml` incl. old vaults, WIF-only, mismatched and
  wrong-password files, Latin-1 passwords, uncompressed-flag signatures; files
  in the wrong slots and plain-text vaults refused; the two-key model);
  central (Python float strings and payload hashes against the Docker-image
  fixture, register, login, the 401 retry, the one resend, timeouts and
  network errors, with a mocked fetch); neuron (storage and dedupe,
  forecasting only new rows, the kept queue and its cap, a failed poll, a
  local failure, register and mismatch, the schedule, its jitter and a failed
  save); engine (namaste_club's own tests ported, recovery and shrinkage,
  minimum data, gaps, a random-walk guard, and parity with namaste_club's code:
  `scripts/engine_parity.py`; the step: the same series on any grid gives the
  same model; the horizon in 1, 2 and 3 steps); bvar (every equation's
  posterior mean, σ² and prior against namaste_club's `bvar.py` to 9 decimals,
  `scripts/bvar_parity.py`; with no companions it is bar1; a leading
  companion learned; gaps; per-series transforms; the fallbacks; no
  look-ahead in the backtest); evolution (the identity-seeded RNG, the first
  draw, each mutation, the margin, one proposal per poll, a leading
  companion found, neurons diverging); central's history (200, 404 held for a
  day, partial lists, 4 calls at a time, backfilled rows never predicted);
  db (migrations from steps 2–6, a change of central, the relay tables and
  their dedupe, specs, history inserts, doubles bit for bit); nostr (every event rebuilt byte for byte
  against satorilib's own client and nostr-sdk's signatures, Lite's value
  unwrapping on its own function's outputs, Lite's pinned relay uuid, the
  catalog, intake parsing, the relay client's REQ/EOSE/OK and reconnect backoff
  with a fake socket, the test relay over real sockets, and the whole flow
  with fake relays: read-only relays, discover paging, subscribe refusals and
  the cap, intake dedupe and echo, `_pred` seq, announce on open, reconcile,
  NIP-65, unsubscribe); Base (the keys' Base addresses against satorilib's
  `ethAddress` and viem, `signDigest` against viem's `sign`; every ABI entry
  against the D6 build output; the config overlay and its cache; the chain
  module against a fake D6: the status multicall, the transfer lock's `>=`,
  delegate and stop, simulates, sends, claims; the batch: due rules, the
  engine's step, Lite's direction, named games' 24 h, per-game simulation,
  the hash kept at send and waited for, persisted only after the receipt, the
  max-fee ceiling, the schedule, the config cache per central, the settings
  checked before either is saved; claims' and sends' branches); the CSP; ui
  text; `serial()`; the service worker's routing (`src/pwa/sw.test.js`); the
  build variables: unset keeps each default, set replaces it, a bad one is
  refused (`src/config.test.js`).
- `npm run e2e` (Playwright, system Chrome, one worker), central2 routed to a
  stub and prod blocked: create → register (headers checked) → first poll
  5–30 min out → Poll now: two streams stored, forecast and sent after an
  identity-signed login (payload strings and hashes checked) → second tab
  refused → reload keeps the schedule and registers again → Unlock (wrong
  passphrase refused) → backup words and both files → Lock, polls go on; the
  agent API (dedupe, a failed batch kept and resent, a 401 retried, the
  central URL setting: another central drops the queue and the list, which
  refill from it, after a poll still running with the old one; one Unlock at a
  time; the engine: naive until 8 back-to-back buckets of 12 h, then bar1 with
  node's numbers; a central with history: bvar for every stream on the first
  Poll now, with node's specs and numbers); Docker import with a vault mismatch and Settings
  (https only, an unreachable central shown); restore from words; two setups
  at once (one wins) leaving other `meta` rows alone. Also an OPFS persistence
  smoke under the CSP. Nostr (`e2e/nostr.spec.js`) against two test relays,
  7782 as central's (read only) and 7781 as the user's: a provider's stream
  discovered and subscribed in the UI, its stored and live observations
  forecast and published as `_pred` (read back from 7781 and checked, with
  the 34600 and the 34602), nothing on 7782 from the app, kept over a reload,
  unsubscribed with the tombstone; Docker import with `nostr.yaml`. Satorian
  and the dev relay are routed to nothing in every test. Base
  (`e2e/base.spec.js`) against a fake D6 behind `/rpc` and a stub central
  serving a merkle proof: Unlock → Delegate, the identity's batch on its own,
  claims and the next batch a round later, Stop delegating, the lock through
  round N, sends, Lock, the low-ETH warning only once delegated; the Base
  settings (nothing half-saved); the other specs keep off `/rpc`. Every spec
  uses the one stub central (`e2e/stub.js`) and opens and reloads the app
  through `e2e/load.js`, which waits up to 30 s for `<body data-screen>` to
  leave `loading` (DuckDB-WASM takes seconds to start on a busy box). The dev
  server registers no service worker and removes one left on its origin.
- `npm run e2e:pwa` (a build on `vite preview` :5181, `e2e/pwa.spec.js`, each
  test in its own Chrome profile with every host but localhost unresolvable):
  the manifest valid and installable, the worker served with the CSP and
  controlling the page, Install and the storage line, `persist()` after
  setup; offline the page, DuckDB and the stored neuron load while central and
  Base fail and say so; a new version waits for Update; an app window and a
  tab run one neuron ([pwa.md](pwa.md#verify)).
- `npm run e2e:deploy` (the deploy image at `DEPLOY_URL`, :8090 by default;
  `e2e/deploy.spec.js`): the CSP and nosniff on every kind of response, the
  cache headers and types, the SPA fallback and the gzipped wasm; then in a
  fresh profile the page under the CSP, DuckDB, the worker, the manifest, and
  a neuron on the deployment's central and relays ([deploy.md](deploy.md#verify)).
- Live, in a fresh browser profile on the dev server: central2 (writes
  allowed) for register, Poll now and the batch; prod only for read-only GETs.
  Nostr: satorian read only (its full catalog discovered: 924 live of 1,061
  announcements; only REQ and CLOSE sent to it), the dev relay on 7778 for
  every write. Base: the dev app against an anvil fork of Base Sepolia
  (delegate, the batch on its own, claims including `hub.claim`, stop, the
  lock, a send: [base.md](base.md#live-in-the-running-app-2026-10-15)); and
  `src/chain/fork.test.js` runs the chain module against the real D6
  contracts on a fork (`BASE_FORK`).
- Load time on the dev server (headless Chrome, the dev box, 2026-10-15):
  the page paints "Opening…" at 0.3 s (`index.html`); a fresh profile reaches
  Setup in ~4.5 s and a reload reaches Home in ~3.5 s (5.6–6.0 s and 4.7–4.9 s
  before apache-arrow was pre-bundled and DuckDB's worker sent raw). What
  remains: ~0.75 s of modules, ~1.8 s for DuckDB to fetch and compile its
  34 MB wasm (a cacheable wasm did not help), ~0.4 s to open the OPFS file,
  ~0.15 s of migrations, ~0.3 s to start the neuron.
- Parity vectors come from satorilib, the Docker image and namaste_club
  (`test/fixtures/README.md`; `scripts/`).
- `node scripts/backtest.mjs`: the engine against persistence at 24 h on real
  history, read only, and 5 simulated neurons running bvar with evolution on
  21 crypto pairs at once ([engine.md](engine.md#measured)): all three tie on
  400 days.
- Dev app: `npm run dev` → http://localhost:5180; for Base, `node scripts/fork.mjs start`
  (an anvil fork on 8545, which the dev server proxies as `/rpc`). The
  installable app: `npm run build && npm run preview` → http://localhost:5181.
  The deploy image: `./scripts/deploy-image.sh`, then
  `docker run --rm -p 8090:80 satori-neuron:latest` → http://localhost:8090.
