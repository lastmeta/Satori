# satori: overview

This is the source of truth for what is built (steps 1–6). Intent: [../intent/INTENT.md](../intent/INTENT.md).
Later steps: [../future/README.md](../future/README.md).

## The flow

The neuron runs central's data flow the way Satori Lite (the Docker neuron)
does ([central.md](central.md)):

```
page load ──▶ register with central (identity + vault public keys)
first poll 5–30 min later, then every 11 h (or Poll now):
  GET observations ──▶ store (DuckDB) ──▶ forecast streams with a new row ──▶ queue ──▶ login (identity) ──▶ POST predictions
                       insert or ignore    engine: {model, t1, t2}            pending      signs the challenge    batch; kept on failure
```

1. **Register** on every page load: `wallet-pubkey` (identity), `vault-pubkey`
   (read from `vault.yaml` while locked), `nostr-pubkey` and `neuron-version`. The result is
   shown on Home, with a **vault mismatch** if central holds another vault for
   this identity.
2. **Poll** central's observations batch (the latest observation of each
   stream, under 48 h old). The next poll time is stored, so a reload keeps
   the 11 h cadence; a due one waits Lite's 5–30 min start jitter.
3. **Store** each observation once per (stream, whole second).
4. **Forecast** only the streams that got a new row, from all their stored
   history ([engine.md](engine.md)): `t1` 12 h ahead and `t2` 24 h ahead.
   `bar1` is a Bayesian AR(1) on 12 h returns after `../namaste_club`. It is
   shrunk toward the random walk, iterated two steps, each step clamped, and
   faded toward persistence by a weight from a rolling backtest. It is `naive`
   (the last value) until the stream has 6 lag pairs of back-to-back 12 h
   buckets, so it needs an observation every 12 h: about 4 days of 11 h polls.
   A stream central updates once a day, or a neuron that polls once a day,
   stays `naive`.
5. **Submit** everything pending right after the poll, as Lite's payload
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
REQ follow {kinds:[34601], authors:[p], #d:[…]} ──▶ verify ──▶ store once ──▶ forecast (step = cadence) ──▶ `<stream>_pred` 34601, seq + 1
on each (re)connect and hourly: announce `<stream>_pred`; hourly: relay list, reconnect; daily: NIP-65
```

On the dev server central's relays (satorian, production) are **read only**
(REQ, never EVENT) and the user's relays default to the test relay
`ws://localhost:7778` (`scripts/test-relay.mjs`); a build writes to central's
relays.

On Base the neuron predicts as Lite does ([base.md](base.md)): the vault
delegates its prediction power to the identity once (Unlock), and the
identity sends one batch of up/down predictions each UTC round on its own.

```
status (no key): one multicall ── ETH ×2, the vault's SATORI, delegation, fee, lock, round, claimables
Unlock ─▶ Delegate: identity setPredictorFee(0), setAllowedDelegator(vault) ─▶ vault delegatePredictionPower(identity)
each round, first check: power > 0, no batch yet ─▶ registry streams with a game ─▶ engine (t2) vs latest: UP/DOWN
     ─▶ simulate each game alone ─▶ predictMultipleWithPayloads(the ones that pass) ─▶ receipt ─▶ persist
Unlock ─▶ Claim: hub.claim() · merkle (central's proof) · airdrop      Send: ETH; SATORI when not transfer-locked
```

On the dev server the Base RPC is `/rpc`, which Vite proxies to a local
anvil fork of Base Sepolia (`scripts/fork.mjs`); a build uses central's RPC
(`https://sepolia.base.org`) with publicnode as a fallback.

## Parts

| Part | Folder | Does |
|---|---|---|
| keys | `src/keys/` | Satori's two keys ([keys.md](keys.md)): the **identity** (`wallet.yaml`, unencrypted, signs on its own) and the **vault** (`vault.yaml`, fields encrypted with the passphrase as Docker does, holds funds). Create, restore from words, import/export the Docker files, Unlock/Lock the vault, sign and verify Evrmore messages. Each key's Base (EVM) address and transaction signatures (`signDigest`), inside the signer so Lock still wipes it ([base.md](base.md#keys-on-base)). Also the **Nostr key** (`nostr.yaml`, random, plaintext as in Docker; [nostr.md](nostr.md)). |
| central | `src/central/` | Central's API as Lite calls it ([central.md](central.md)): `register`, `observations`, `submitPredictions` (login, one retry on 401); `pyFloatStr`/`predictionItem` (Python's float strings and the payload hash); `normalizeObservation`; for Base `baseConfig`, `merkleRoot`, `merkleProof`. 15 s timeouts; network errors wrapped. |
| chain | `src/chain/` | The D6 contracts on Base Sepolia over viem ([base.md](base.md)): the bundled addresses with central's config over them (`config.js`), minimal ABIs (`abi.js`), and `createChain`: the status multicall, delegate/stop, the batch's pieces, streams kept by voting weight, claims, sends; every write simulated first, one at a time, with gas over the estimate for contract calls. Test doubles: `fake-rpc.js`, `fake-satori.js`. |
| db | `src/db/` | DuckDB-WASM 1.32.0 stored in OPFS (`opfs://satori-mvp.duckdb`; `satori.duckdb` on this origin holds the old draft's schema), with tables `meta`, `streams` (uuid, name, meta), `observations` (stream_uuid, ts, value), `predictions` (stream_uuid, made_at, model, t1, t2, phi, weight, observed_at, hash, status, sent_at), and for Nostr `relay_streams`, `relay_observations`, `relay_predictions` ([nostr.md](nostr.md#storage-migration-4)). Times are unix seconds. |
| engine | `src/engine/` | `forecast(points, { step }) → {model, t1, t2, phi?, weight?} \| null` ([engine.md](engine.md)): `bar1` or `naive`; step 12 h for central, a relay stream's cadence. Pure, no dependency. |
| nostr | `src/nostr/` | NIP-01 events over `@noble/curves` schnorr (`event.js`), Satori's events and parsing byte for byte as satorilib (`satori.js`), one relay over a WebSocket with reconnect (`relay.js`) ([nostr.md](nostr.md)). |
| neuron | `src/neuron/` | `register`, `cycle` (poll → store → forecast → submit), the poll schedule (`createPoller`), one tab only (a Web Lock); `nostr.js`: relays, discover, subscribe, intake → `_pred`, reconcile; `base.js`: the daily batch and its schedule, delegate, claims, sends. |
| ui | `src/ui/` | ArrowJS screens: Setup (create / restore from words / import Docker files), Home (both addresses, Unlock/Lock, central's status with Poll now, the streams with our t1/t2, the Nostr card, the Base card, Network streams, Settings, backup). |
| agents | `src/main.js`, `public/llms.txt` | `window.satori`: the same actions as the UI for an AI agent in the page (status, setup, poll, streams, predictions, setCentral, unlock/lock, backup, Docker files; nostr, discover, subscribe, unsubscribe, setRelays; base, delegate, undelegate, claim, predictBase, send, setBaseRpc). `/llms.txt` tells an agent what the app is, how to drive it, where the code is, and that pull requests are welcome. |

## Rules

- Two keys, as Satori Lite ([keys.md](keys.md)). The identity is stored
  unencrypted so the neuron runs from page load and signs central's login
  with it. The vault is stored encrypted; **Unlock** (passphrase) decrypts it
  into memory and **Lock** wipes it. The neuron never needs the vault.
- Backup (both keys' words and private keys, `wallet.yaml` and `vault.yaml`
  downloads) needs Unlock, as Docker's dashboard needs login.
- **Central URL** (Settings, `meta.central_url`): https only. Empty means the
  default: `https://central2.satorinet.io` on the dev server (so nobody writes
  to prod from a dev checkout), `https://network.satorinet.io` in a build.
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
  only its own rows (`meta.wallet_yaml`, `meta.vault_yaml`) and leaves any
  other row as it is.
- One setup runs at a time, from the UI or an agent (`window.satori.setup`):
  both take the same guard, and a second one is refused.
- Import takes `wallet.yaml` only in plain text and `vault.yaml` only
  encrypted; files in each other's slots are refused as swapped. The vault is
  never stored in plain text. Passphrases are Latin-1 only, as Docker's
  encryption needs ([keys.md](keys.md#the-files)).
- Only one tab opens the database. Other tabs say "Satori is open in another tab".
- OPFS keeps what DuckDB has checkpointed, so the app checkpoints after each
  cycle and each schedule change.
- The page is sent with a strict CSP header: no inline script,
  `'wasm-unsafe-eval'` for DuckDB, `connect-src 'self' https: wss: ws:` for the
  chosen central and the relays. An https page still can't open `ws://`
  (mixed content), so a deployed app needs `wss://` relays
  ([issue](../future/issues/relays-not-wss.md)).
- The Nostr key is stored unencrypted like the identity, so the neuron signs
  its events on its own. `nostr.yaml` downloads need Unlock, as the other files.
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
client for Base; signing stays in `src/keys` (`@noble/curves`).

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
  same model); db (migrations from steps 2, 3 and 4, a change of central, the
  relay tables and their dedupe); nostr (every event rebuilt byte for byte
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
  Lite's resend, persisted only after the receipt, the schedule; claims' and
  sends' branches); the CSP; ui.
- `npm run e2e` (Playwright, system Chrome, one worker), central2 routed to a
  stub and prod blocked: create → register (headers checked) → first poll
  5–30 min out → Poll now: two streams stored, forecast and sent after an
  identity-signed login (payload strings and hashes checked) → second tab
  refused → reload keeps the schedule and registers again → Unlock (wrong
  passphrase refused) → backup words and both files → Lock, polls go on; the
  agent API (dedupe, a failed batch kept and resent, a 401 retried, the
  central URL setting: another central drops the queue and the list, which
  refills from it; the engine: naive until 8 back-to-back buckets of 12 h,
  then bar1 with node's numbers); Docker import with a vault mismatch and Settings
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
  round N, sends, Lock; the other specs keep off `/rpc`. Every spec opens and
  reloads the app through `e2e/load.js`, which waits up to 30 s for it to
  leave "Opening…" (DuckDB-WASM takes seconds to start on a busy box).
- Live, in a fresh browser profile on the dev server: central2 (writes
  allowed) for register, Poll now and the batch; prod only for read-only GETs.
  Nostr: satorian read only (its full catalog discovered: 924 live of 1,061
  announcements; only REQ and CLOSE sent to it), the dev relay on 7778 for
  every write. Base: the dev app against an anvil fork of Base Sepolia
  (delegate, the batch on its own, claims including `hub.claim`, stop, the
  lock, a send: [base.md](base.md#live-in-the-running-app-2026-10-15)); and
  `src/chain/fork.test.js` runs the chain module against the real D6
  contracts on a fork (`BASE_FORK`).
- Parity vectors come from satorilib, the Docker image and namaste_club
  (`test/fixtures/README.md`; `scripts/`).
- `node scripts/backtest.mjs`: the engine against persistence at 24 h on real
  history, read only ([engine.md](engine.md#measured)): a tie on 400 days of
  21 crypto pairs.
- Dev app: `npm run dev` → http://localhost:5180; for Base, `node scripts/fork.mjs start`
  (an anvil fork on 8545, which the dev server proxies as `/rpc`).
