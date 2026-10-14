# satori — the Satori neuron in the browser

Source of truth for what this app is. Intent: [../intent/INTENT.md](../intent/INTENT.md).

## What it is

A Satori neuron that runs entirely client-side: one static web app, no server of
our own. It does what the Docker neuron (`../neuron`) does for a user: hold the
keys, follow data streams, forecast them, publish predictions, lock on Base so
the daily on-chain prediction batch earns, and claim rewards. The Docker neuron
stays. This is a second way to run a neuron, and it talks to the same network
(central, Nostr relays, Base) with the same keys and wire formats, so a user can
move between the two.

"It'll do it all" is the end state. v1 is the smallest neuron that earns; the
rest of the Docker neuron's duties come later (see [Scope](#scope)).

## Conventions in these docs

- Paths in citations are relative to `/code/Satori/` (for example
  `neuron/neuron-lite/start.py:1143`). Each claim about the existing system
  cites file:line. **Verified** = read in code or probed live during research on
  2026-10-14. **Inferred** = a reading of the design, not traced end to end.
- "Lock" is the owner's word for delegating the vault's prediction power to the
  identity on Base (`hub.delegatePredictionPower`). The Docker UI labels the same
  toggle "Staking" (`neuron/web/templates/settings.html:744-870`); code
  identifiers keep their names.
- **identity** = the always-available key (Docker `wallet.yaml`); **vault** =
  the password-encrypted key (Docker `vault.yaml`).

## Architecture

```
 ┌───────────────────────────── browser tab (the "leader") ─────────────────────────────┐
 │                                                                                       │
 │  main thread: UI (ArrowJS components)  ◄── BroadcastChannel ──►  follower tabs         │
 │        │  postMessage (commands / state snapshots)                  ("running in       │
 │        ▼                                                             another tab")     │
 │  neuron worker (owns everything stateful)                                              │
 │   ├─ keys        unlocked secrets in memory only            → identity.md              │
 │   ├─ store       DuckDB-WASM on OPFS (opfs://satori.duckdb) → storage.md               │
 │   ├─ nostr       nostr-tools pool, wss:// relays only       → transport.md             │
 │   ├─ central     fetch + JWT                                → central.md               │
 │   ├─ base        viem: reads, lock, daily batch, claims     → chain.md                 │
 │   ├─ scheduler   wall-clock deadlines + catch-up on resume  → runtime.md               │
 │   └─ engine      naive / SES / damped Holt, t1+t2           → engine.md                │
 │                                                                                       │
 │  service worker: precache app shell + DuckDB wasm only (no neuron logic)               │
 └──────────┬───────────────────────┬──────────────────────────┬──────────────────────────┘
            │ HTTPS (CORS)          │ WSS                       │ HTTPS JSON-RPC (CORS)
            ▼                       ▼                           ▼
   central (network.satorinet.io)   Nostr relays (wss only)     Base Sepolia RPC
   auth, register, relays,          kinds 34600-34609, 10002    engine / hub / rewards /
   observations, predictions,                                   games / registry / merkle /
   base/config, merkle proof                                    airdrop / token
```

Only one tab per browser runs the neuron: it wins a Web Lock named
`satori-neuron` and spawns the neuron worker. Other tabs show state and send
commands ([runtime.md](runtime.md)).

## Component docs

| Doc | Covers |
|---|---|
| [identity.md](identity.md) | keys, backup words, encryption at rest, Docker import/export, Evrmore message signing |
| [central.md](central.md) | login/JWT, peer register, relays, base config, observations and predictions batch, merkle proof |
| [transport.md](transport.md) | Nostr wire protocol subset, relay reconcile, subscribe, intake, publish `_pred` |
| [storage.md](storage.md) | DuckDB-WASM on OPFS, schema, single-writer rule, durability |
| [engine.md](engine.md) | forecaster, horizons, per-node diversity |
| [chain.md](chain.md) | Base: config, lock/unlock, daily batch, claims, balances; Evrmore later |
| [runtime.md](runtime.md) | background execution, leader election, scheduling, catch-up |
| [ui.md](ui.md) | pages, ArrowJS, what replaces Flask |
| [../issues/README.md](../issues/README.md) | blockers outside this repo, and inherent browser limits |

## Tech stack (pinned)

Pins are the newest release at least two weeks old on 2026-10-14, or the exact
version a research probe verified. The npm `latest` tag of DuckDB-WASM must not
be used (see storage.md).

| Package | Version | Why this pin |
|---|---|---|
| `@duckdb/duckdb-wasm` | 1.32.0 | `latest` (1.33.1-dev57.0) creates OPFS files but never writes them (duckdb.org/2026/09/18/opfs-wasm). |
| `apache-arrow` | ^17 (the copy DuckDB resolves) | DuckDB 1.32.0 depends on `apache-arrow ^17.0.0`; a second copy (21.x) breaks `instanceof`. Inferred. |
| `@arrow-js/core` (ArrowJS) | 1.0.6 | UI runtime: `reactive`, `html`, `component`, `watch`. No dependencies. |
| `nostr-tools` | 2.25.2 | pool, `finalizeEvent`, `nip04`. |
| `viem` | 2.37.0 | Base reads/writes; the version the identity parity vector was checked with. |
| `@noble/curves` | 1.9.7 | secp256k1 sign/recover for Evrmore messages; parity-verified. |
| `@noble/hashes` | 1.8.0 | sha256, ripemd160, pbkdf2; parity-verified. |
| `@scure/base` | 1.2.6 | base58check, base64; parity-verified. |
| `@scure/bip39` | 1.6.0 | 24 backup words (entropy ↔ words only); parity-verified. |
| `js-yaml` | 5.4.2 | read Docker `wallet.yaml` / `vault.yaml` / `nostr.yaml` on import. |
| `vite` | 8.3.1 | static build, worker bundling. |
| `vitest` | 5.0.2 | unit tests (parity vectors, engine, schema). |
| `@playwright/test` | 1.63.0 | end-to-end tests in real Chromium (OPFS, workers, hidden-tab behaviour). |

nostr-tools 2.25.2 brings `@noble/curves` 2.0.1 / `@noble/hashes` 2.0.1 with it, so
two noble major versions ship. Accept that for v1; collapse onto noble 2.x once
the parity vectors pass on it (vectors, not version numbers, are the contract).

Hosting: any static HTTPS host. No COOP/COEP needed, because the non-threaded
DuckDB `eh` bundle is used ([storage.md](storage.md#bundle)).

"Arrow.js" in the intent is read as ArrowJS (`@arrow-js/core`), the reactive UI
runtime, used together with DuckDB-WASM. Apache Arrow is also used, as the
in-memory table format DuckDB returns. If the owner meant only Apache Arrow,
only [ui.md](ui.md) changes.

## Neuron duties → browser tech

Duty numbers follow the lifecycle map of `neuron/neuron-lite/start.py`.

| Docker duty | Evidence | Browser | v1? |
|---|---|---|---|
| Config (YAML) | `neuron/neuron-lite/satorineuron/config/__init__.py:3-95` | `settings` table in DuckDB | yes |
| Identity, vault, Nostr keys | `start.py:75-76,120-149`; `satorilib/src/satorilib/wallet/identity.py:309-320` | `@noble/*` + `@scure/*`, WebCrypto at rest | yes |
| Watchdogs, `os._exit` restarts | `start.py:102-118,4883-4892` | dropped; per-connection reconnect | no (dropped) |
| Central check-in, JWT, register | `start.py:4972-5006`; `central/src/api/v1/endpoints/auth.py:21-86` | `fetch` | yes |
| Central observation poll + predictions batch (11 h) | `start.py:4766-4881`; `central/src/main.py:292-330,438-602` | `fetch` on open and on a deadline | yes |
| Relay reconcile (hourly) | `start.py:200-302` | nostr-tools pool in the worker | yes |
| Base stream auto-selection | `start.py:453-543` | viem multicall + Nostr lookup | yes |
| Observation intake | `start.py:621-667,1112-1137` | WebSocket handler → DuckDB insert | yes |
| Relay prediction + `_pred` publish | `start.py:1276-1362` | engine in worker, nostr-tools publish | yes |
| Base daily batch | `start.py:1143-1281`; `neuron/neuron-lite/satorineuron/base_predict.py:135-174` | viem `writeContract` | yes |
| Lock / unlock, merkle claim, airdrop claim | `base_predict.py:242-323`; `base_claim.py:84-121` | viem | yes |
| Engine + training queue | `neuron/engine-lite/engine.py:1253-1364` | small JS forecaster, refit per observation | yes (new engine) |
| Bounties (host and join) | `start.py:669-882,1334-1362` | nostr-tools + DuckDB | later |
| Evrmore payment channels | `start.py:1589-3440` | needs JS P2SH/CSV port + WSS ElectrumX | later |
| Own data sources (publishing) | `start.py:3842-4016` | `fetch` (CORS-limited) | later |
| Evrmore send / balances | `neuron/web/routes.py:1531-1637` | WSS ElectrumX + JS asset tx | later |
| Local strfry relay | `neuron/neuron-lite/satorineuron/relay_manager.py:421-456` | impossible in a browser | never |
| Flask UI + TTY CLI | `start.py:5258-5287`; `neuron/neuron-lite/cli.py:957-1066` | the app itself | yes (replaced) |
| Central pool/lender "Stake" page, reward address | `neuron/web/routes.py:1151-1245` | `fetch` | later (legacy) |

## Scope

### v1 — a neuron that earns

1. **Keys.** Create or import identity, vault and Nostr key; back up; encrypted
   at rest; byte-compatible with Docker. ([identity.md](identity.md))
2. **Central.** Login, register (all three pubkeys), relay list, base config,
   observation poll and predictions batch. ([central.md](central.md))
3. **Streams.** Connect to wss relays; auto-select the Base bridge streams
   `satori-<chainId>-<id>`; ingest free observations; publish `<stream>_pred`.
   ([transport.md](transport.md))
4. **Engine.** Naive floor + SES + damped Holt, chosen per stream by rolling
   error; ship t1 and t2. ([engine.md](engine.md))
5. **Base.** Lock / unlock, the daily prediction batch signed by the identity,
   merkle claim, airdrop claim, ETH and SATORI balances. ([chain.md](chain.md))
6. **Runtime.** One leader tab; everything driven by persisted deadlines with a
   catch-up pass on open, resume and reconnect. ([runtime.md](runtime.md))
7. **UI.** Unlock, Lock, Claim, Backup/Import, Predictions, Status.
   ([ui.md](ui.md))

Free streams only. A v1 neuron is a subscriber and predictor; it does not
publish its own data sources or host bounties.

### Later (in rough order of value per effort)

- Manual subscribe/unsubscribe and a marketplace view (Nostr only; cheap).
- Bounty participation (predictor side: one NIP-04 DM per prediction).
- Gasless relay through `SatoriHub.relay` (needs an owner ruling, see issues).
- Evrmore balances over WSS ElectrumX; SATORIEVR send.
- Paid streams and Evrmore payment channels; bounty hosting and payouts.
- Own data sources (JS parsers instead of Python `exec`).
- Optional heavier models (Pyodide XGBoost, ONNX) if they ever beat naive.

### Never

Hosting a relay; host metrics; process restarts; the TTY CLI.

## Decisions for the owner

Each has a recommended default that the design already assumes, so work can
start without an answer.

1. **Identity at rest.** The identity has to sign without a prompt (central
   login, the daily batch). Docker keeps it in plaintext
   (`neuron/neuron-lite/satorineuron/init/wallet.py:94-111`). Default: one
   passphrase for both keys, plus an opt-in "remember on this device" that
   wraps the identity only with a non-extractable WebCrypto key, so a reloaded
   tab predicts without a prompt. The vault always needs the passphrase.
   ([identity.md](identity.md#at-rest))
2. **Tab-only runtime.** A browser neuron works only while a tab or installed
   PWA is open; a day with no open tab misses that day's batch. This is
   inherent. Default: accept it, catch up on open, and show "last active".
   ([runtime.md](runtime.md))
3. **Which central.** Prod `network.satorinet.io` returns 404 for
   `/api/v1/base/config` and `/api/v1/merkle/*`; dev `central2` serves them.
   Default: bundle the Base addresses, target prod for login/predictions, and
   treat claims as blocked on prod until it is deployed.
   ([issue](../issues/central-prod-missing-base-routes.md))
4. **Relays.** The only relay central lists is `ws://satorian.satorinet.io:7777`,
   which an HTTPS page cannot open. v1 cannot follow streams until at least one
   relay has a wss:// endpoint. ([issue](../issues/relays-not-wss.md))
5. **Gas.** Both the identity and the vault need Base ETH, as in Docker. The live
   gasless relay could remove that, but its Predict fee (0.25 SATORI) would be
   paid by the identity, which holds none. Default: v1 needs ETH; owner decides
   on a 0-fee Predict. ([issue](../issues/relayer-predict-fee.md))
6. **hub.claim.** Neither neuron calls `SatoriHub.claim` for on-chain prediction
   rewards today (`base_predict.py:67-75` has only `delegatePredictionPower`).
   Default: add it to the Claim page in v1 (one write). Owner confirms that
   these rewards are meant to be claimed from the neuron.
7. **Same keys in both neurons.** Importing a Docker identity and running both
   means two nodes with one Nostr pubkey publishing the same `_pred`
   coordinates. Default: import is a move; the app warns the user to stop the
   Docker neuron. The chain refuses a second batch the same day
   (`predictedStreamsCount`, `base_predict.py:209-240`).

## Testing and verification

- Parity vectors (identity, message signing, vault decrypt, addresses, payload
  hash, relay uuid5) are generated from the shipped Docker image and checked in
  as JSON fixtures; vitest asserts them. Signatures are checked by
  cross-verification, never byte equality ([identity.md](identity.md#signing)).
- Playwright runs the built app in Chromium against a local central and a local
  wss relay: unlock, observation in, `_pred` out, prediction batch on an anvil
  fork of Base Sepolia.
- OPFS round trip at startup (write, reopen, read) guards against DuckDB
  regressions ([storage.md](storage.md)).
