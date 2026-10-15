# satori — the Satori neuron in the browser

Source of truth for what this app is. Intent: [../intent/INTENT.md](../intent/INTENT.md).

## What it is

A Satori neuron that runs entirely client-side: one static web app, no server of
our own. It does what the Docker neuron (`../neuron`) does for a user: hold the
keys, forecast data streams, submit predictions to central and to Base, delegate
the vault's prediction power on Base, and claim rewards. The Docker neuron
stays. This is a second way to run a neuron. It talks to the same network
(central, Base, later Nostr relays) with the same keys, so a user can move
between the two.

"It'll do it all" is the end state. v1 is the smallest neuron that earns; the
rest of the Docker neuron's duties come later (see [Scope](#scope)).

## Conventions in these docs

- Paths in citations are relative to `/code/Satori/` (for example
  `neuron/neuron-lite/start.py:1143`). Each claim about the existing system
  cites file:line. **Verified** = read in code or probed live during research
  (2026-10-14/15). **Inferred** = a reading of the design, not traced end to end.
- Words. **Delegate / Revoke** = `hub.delegatePredictionPower(identity)` /
  `(0x0)`, the words Satori's dapp uses (`contract/satori-ui/src`). The token's
  transfer lock is shown as "transfers locked until". **Sign in** = entering the
  passphrase. Docker labels the delegation toggle "Staking"
  (`neuron/web/templates/settings.html:744-870`). Code identifiers keep their
  names. (Owner decision 1.)
- **identity** = the always-available key (Docker `wallet.yaml`); **vault** =
  the password-encrypted key (Docker `vault.yaml`).

## How v1 earns (verified)

Two paths, neither needs Nostr:

1. **Central-lite → merkle drop.** Central scores central-lite predictions in its
   daily run (`central/src/scripts/daily_run.py:1-8,25`), keeps a predictor only
   if it has a reward or balance + pool contribution ≥ `stake_requirement` = 250
   SATORI (`central/src/scripts/score.py:1992`, `central/src/scripts/mint.py:5`),
   and records payouts in `base_earnings` keyed by the Base address derived from
   the peer's registered **vault pubkey** (`central/src/scripts/distribution.py:48-53,278-280`;
   `central/src/services/base_distribution.py:55-66,84-130`). That ledger is what
   the merkle root publishes (`central/src/scripts/publish_merkle_root.py:1-6,34-37`).
   So peer register with the vault pubkey, and ≥ 250 SATORI on the vault's Base
   address (`central/src/scripts/base_balance_watcher.py:1-11`) or pool
   membership, are earning-critical.
2. **Base daily batch → on-chain rewards.** The identity, holding the vault's
   delegated power, submits one direction per binary game per UTC-day round;
   rewards are claimed with `hub.claim()` ([chain.md](chain.md)).

## Architecture

```
 ┌──────────────────────── browser tab (the "leader") ────────────────────────┐
 │  main thread: UI (ArrowJS)                                                   │
 │        │  postMessage (commands / state snapshots)                           │
 │        ▼                                                                     │
 │  neuron worker (owns everything stateful)                                    │
 │   ├─ keys        decrypted secrets in memory only           → identity.md    │
 │   ├─ store       DuckDB-WASM on OPFS (opfs://satori.duckdb) → storage.md     │
 │   ├─ central     fetch; login per batch                     → central.md     │
 │   ├─ base        viem: registry reads, delegate, batch, claims → chain.md    │
 │   ├─ scheduler   wall-clock deadlines + catch-up on resume  → runtime.md     │
 │   └─ engine      naive / SES + direction rule, t1+t2        → engine.md      │
 │                                                                              │
 │  service worker: precache app shell + DuckDB wasm only (no neuron logic)     │
 └──────────┬──────────────────────────────────────┬────────────────────────────┘
            │ HTTPS (CORS)                         │ HTTPS JSON-RPC (CORS)
            ▼                                      ▼
   central (network.satorinet.io)            Base Sepolia RPC
   auth, register, base/config,              registry / games / engine / hub /
   observations, predictions, merkle proof   rewards / merkle / airdrop / token

   later (Nostr parity): nostr worker module → wss relays, kinds 34600-34609, 10002
```

Only one tab per browser runs the neuron: it holds a Web Lock named
`satori-neuron`. Other tabs show "Satori is running in another tab" and wait in
the lock queue ([runtime.md](runtime.md)).

## Component docs

| Doc | Covers |
|---|---|
| [identity.md](identity.md) | keys, backup words, encryption at rest, Docker import/export, Evrmore message signing |
| [central.md](central.md) | login, peer register, base config, observations and predictions batch, merkle proof |
| [chain.md](chain.md) | Base: config, stream reads, delegate/revoke, daily batch, claims, balances; Evrmore later |
| [engine.md](engine.md) | forecaster, horizons, Base direction, per-node diversity |
| [storage.md](storage.md) | DuckDB-WASM on OPFS, schema, single-writer rule, durability |
| [runtime.md](runtime.md) | background execution, leader election, scheduling, catch-up |
| [ui.md](ui.md) | pages, ArrowJS, CSP and hosting |
| [transport.md](transport.md) | Nostr parity (after v1): wire protocol, reconcile, intake, `_pred` |
| [../issues/README.md](../issues/README.md) | blockers outside this repo, and inherent browser limits |

## Tech stack (pinned)

Pins are the newest release at least two weeks old on 2026-10-14, or the exact
version a research probe verified. The npm `latest` tag of DuckDB-WASM must not
be used (see storage.md).

| Package | Version | Why this pin |
|---|---|---|
| `@duckdb/duckdb-wasm` | 1.32.0 | `latest` (1.33.1-dev57.0) creates OPFS files but never writes them (duckdb.org/2026/09/18/opfs-wasm). |
| `apache-arrow` | 17.0.0 (the copy DuckDB resolves) | DuckDB 1.32.0 depends on `apache-arrow ^17.0.0`; a second copy (21.x) breaks `instanceof`. Inferred. |
| `@arrow-js/core` (ArrowJS) | 1.0.6 | UI runtime: `reactive`, `html`, `component`, `watch`. No dependencies. |
| `viem` | 2.37.0 | Base reads/writes; the version the identity parity vector was checked with. |
| `@noble/curves` | 1.9.7 | secp256k1 sign/recover for Evrmore messages; parity-verified. |
| `@noble/hashes` | 1.8.0 | sha256, ripemd160, pbkdf2; parity-verified. |
| `@scure/base` | 1.2.6 | base58check, base64; parity-verified. |
| `@scure/bip39` | 1.6.0 | 24 backup words (entropy ↔ words only); parity-verified. |
| `js-yaml` | 5.4.2 | read Docker `wallet.yaml` / `vault.yaml` / `nostr.yaml` on import. |
| `vite` | 8.3.1 | static build, worker bundling. |
| `vitest` | 4.1.11 | unit tests (parity vectors, engine, schema). 5.0.2 needs Node ≥ 22.12; the dev box runs Node 20.20 ([issue](../issues/toolchain-node20.md)). |
| `@playwright/test` | 1.63.0 | end-to-end tests in real Chromium (OPFS, workers, CSP, tab handover). Runs the system Google Chrome (`channel: 'chrome'`); no Playwright-managed Chromium is installed. |
| `nostr-tools` | 2.25.2 | Nostr parity only (after v1). Brings noble 2.x; collapse onto it once the parity vectors pass. |

No DuckDB extension is used at runtime: JSON is stored as `VARCHAR` and parsed
in JS, because the `json` extension is not built into the 1.32.0 wasm and
autoloads from `extensions.duckdb.org` (verified, [storage.md](storage.md#bundle)).

Hosting: a static HTTPS host **that can set response headers** (Cloudflare
Pages, Netlify `_headers`, nginx). The CSP that protects the keys must reach the
worker scripts as an HTTP header ([ui.md](ui.md#security)). No COOP/COEP: the
non-threaded DuckDB `eh` bundle is used.

"Arrow.js" in the intent is read as ArrowJS (`@arrow-js/core`), the reactive UI
runtime, used together with DuckDB-WASM. Apache Arrow is also used, as the
in-memory table format DuckDB returns. If the owner meant only Apache Arrow,
only [ui.md](ui.md) changes.

## Neuron duties → browser tech

| Docker duty | Evidence | Browser | v1? |
|---|---|---|---|
| Config (YAML) | `neuron/neuron-lite/satorineuron/config/__init__.py:3-95` | `settings` table in DuckDB | yes |
| Identity, vault, Nostr keys | `start.py:75-76,120-149`; `satorilib/src/satorilib/wallet/identity.py:309-320` | `@noble/*` + `@scure/*`, WebCrypto at rest | yes |
| Watchdogs, `os._exit` restarts | `start.py:102-118,4883-4892` | dropped | no (dropped) |
| Central check-in, login, register | `start.py:4972-5006`; `central/src/api/v1/endpoints/auth.py:21-86` | `fetch` | yes |
| Central observation poll + predictions batch (11 h) | `start.py:4766-4881`; `central/src/main.py:292-330,483-602` | `fetch` on a deadline | yes |
| Base stream selection | `start.py:453-543` | registry + games views over multicall (not Nostr) | yes (changed) |
| Base daily batch | `start.py:1143-1281`; `neuron/neuron-lite/satorineuron/base_predict.py:135-174` | viem; due per UTC round | yes (changed) |
| Delegate / revoke, merkle claim, airdrop claim | `base_predict.py:242-323`; `base_claim.py:84-121` | viem | yes |
| On-chain reward claim | none in Docker | `hub.claim()` | yes (new) |
| Engine + training queue | `neuron/engine-lite/engine.py:1253-1364` | small JS forecaster | yes (new engine) |
| Relay reconcile, observation intake | `start.py:200-302,4407-4547,621-667,1112-1137` | nostr-tools pool | parity, after v1 |
| `_pred` publish, 34600 announce, NIP-65 | `start.py:1276-1362,370-389,3454-3477` | nostr-tools | parity, after v1 |
| Bounties (host and join) | `start.py:669-882,1334-1362` | nostr-tools + DuckDB | later |
| Evrmore payment channels | `start.py:1589-3440` | JS P2SH/CSV port + WSS ElectrumX | later |
| Own data sources (publishing) | `start.py:3842-4016` | `fetch` (CORS-limited) | later |
| Evrmore send / balances | `neuron/web/routes.py:1531-1637` | WSS ElectrumX + JS asset tx | later |
| Local strfry relay | `neuron/neuron-lite/satorineuron/relay_manager.py:421-456` | impossible in a browser | never |
| Flask UI + TTY CLI | `start.py:5258-5287`; `neuron/neuron-lite/cli.py:957-1066` | the app itself | yes (replaced) |
| Central pool/lender "Stake" page, reward address | `neuron/web/routes.py:1151-1245` | `fetch` | later (legacy) |

## Scope

### v1 — a neuron that earns

1. **Keys.** Create or import identity, vault and Nostr key; back up; encrypted
   at rest; byte-compatible with Docker. ([identity.md](identity.md))
2. **Central.** Register all three pubkeys (earning-critical: the vault pubkey
   is the payee); observation poll and predictions batch, logging in once per
   batch; base config; merkle proof. ([central.md](central.md))
3. **Base streams.** Games from `registry.getAllDataStreams` +
   `games.binaryGameByStream`; history and latest values from registry views.
   ([chain.md](chain.md#base-streams))
4. **Engine.** Naive floor + SES per stream, t1 and t2; a separate Base
   direction rule that never defaults to a constant vote. ([engine.md](engine.md))
5. **Base.** Delegate / revoke, the daily batch signed by the identity (due
   whenever the current UTC round has none), merkle claim, airdrop claim,
   `hub.claim`, ETH and SATORI balances, the 250-SATORI central gate.
   ([chain.md](chain.md))
6. **Runtime.** One leader tab, queued handover; persisted deadlines; catch-up
   on open, resume and reconnect. ([runtime.md](runtime.md))
7. **UI.** Welcome, Sign in, Delegate, Claim, Backup, Status, Settings.
   ([ui.md](ui.md))

Free central streams and Base games only. No Nostr in v1.

### Next — Nostr parity ([transport.md](transport.md))

Relay reconcile and intake of free 34601 streams, `_pred` publish with its 34600
announcement, then NIP-65. Blocked on a wss relay
([issue](../issues/relays-not-wss.md)). Nothing in central or the contracts
reads `_pred` (verified: grep of `central/src`, `central/relay_watcher`; the Base
batch reads local predictions, `start.py:1201-1213`), so this is network
service, not earning.

### Later (in rough order of value per effort)

- Per-stream chart and model view; "Add SATORI to MetaMask".
- Manual subscribe/unsubscribe and a marketplace view.
- Bounty participation (predictor side: one NIP-04 DM per prediction).
- Gasless relay through `SatoriHub.relay` (needs an owner ruling, see issues).
- Evrmore balances over WSS ElectrumX; SATORIEVR send.
- Paid streams and Evrmore payment channels; bounty hosting and payouts.
- Own data sources (JS parsers instead of Python `exec`).
- Damped Holt or heavier models, only if a backtest on Satori's own histories
  shows a win.

### Never

Hosting a relay; host metrics; process restarts; the TTY CLI.

## Decisions for the owner

Each has a recommended default that the design already assumes, so work can
start without an answer.

1. **Words.** Docs use Delegate / Revoke (Satori dapp) and "Sign in" for the
   passphrase, so "unlock" never means three things. If you want "Lock" for
   delegation, only labels change; the passphrase page stays "Sign in".
2. **Identity at rest.** The identity signs without a prompt (central login, the
   daily batch). Docker keeps it in plaintext
   (`neuron/neuron-lite/satorineuron/init/wallet.py:94-111`). Default: one
   passphrase, plus opt-in "remember on this device" that wraps the identity
   only with a non-extractable WebCrypto key. The vault always needs the
   passphrase. ([identity.md](identity.md#at-rest))
3. **Which central.** Prod `network.satorinet.io` returns 404 for
   `/api/v1/base/config` and `/api/v1/merkle/*`; dev `central2` serves them.
   Default: bundle the Base addresses, target prod for register/predictions,
   claims blocked on prod until deployed.
   ([issue](../issues/central-prod-missing-base-routes.md))
4. **Base stream history source.** Default: registry views
   (`getHistoryPage`, up to 768 entries per stream), which match the value the
   contract anchors on. Your "events are the read model" rule points at
   `StreamValueUpdated` logs instead, but the public RPC caps `eth_getLogs` at
   200 blocks (~400 s on Base, probed), so that means the indexer
   (`https://app.satorinet.io/api`) as a dependency. Recommend registry views
   for v1; they are a contract API, not a reconstruction.
5. **Gas.** Both identity and vault need Base ETH, as in Docker. The live
   gasless relay could remove that, but its Predict fee (0.25 SATORI) would be
   paid by the identity, which holds none. Default: v1 needs ETH.
   ([issue](../issues/relayer-predict-fee.md))
6. **Same keys in both neurons.** Importing a Docker identity and running both
   means two nodes submitting for one identity. Default: import is a move; the
   app warns to stop the Docker neuron. The chain refuses a second batch per
   round (`contract/satori/contracts/next/SatoriEngine.sol:716`).

## Testing and verification

- Parity vectors (identity, message signing, vault decrypt including old vaults
  with encrypted `publicKey`/`address`, central-lite payload hash) are
  generated from the shipped Docker image and checked in as JSON fixtures;
  vitest asserts them. None exist yet. Signatures are checked by
  cross-verification, never byte equality ([identity.md](identity.md#signing)).
- Playwright runs the built app in Chromium, under the production CSP, against a
  local central and an anvil fork of Base Sepolia: fresh install → delegate →
  one batch; leader tab closes → follower takes over; DuckDB and PBKDF2 run
  under the CSP.
- OPFS round trip at startup (write, reopen, read) guards against DuckDB
  regressions ([storage.md](storage.md)).
