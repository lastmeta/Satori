# satori: overview

This is the source of truth for what is built (steps 1–3). Intent: [../intent/INTENT.md](../intent/INTENT.md).
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
   (read from `vault.yaml` while locked) and `neuron-version`. The result is
   shown on Home, with a **vault mismatch** if central holds another vault for
   this identity.
2. **Poll** central's observations batch (the latest observation of each
   stream, under 48 h old). The next poll time is stored, so a reload keeps
   the 11 h cadence; a due one waits Lite's 5–30 min start jitter.
3. **Store** each observation once per (stream, whole second).
4. **Forecast** only the streams that got a new row: `t1` one step ahead and
   `t2` the step after. Step 3's engine is a least-squares line over the last
   20 values (`ols-20`).
5. **Submit** everything pending right after the poll, as Lite's payload
   (`value` = t2, `t1_value`, `observed_at`, `hash`, byte-identical strings).
   A batch central rejects (`successful == 0`) or a failed call keeps the
   predictions for the next poll.

No passphrase is needed: the identity key is unencrypted, as in Docker.

## Parts

| Part | Folder | Does |
|---|---|---|
| keys | `src/keys/` | Satori's two keys ([keys.md](keys.md)): the **identity** (`wallet.yaml`, unencrypted, signs on its own) and the **vault** (`vault.yaml`, fields encrypted with the passphrase as Docker does, holds funds). Create, restore from words, import/export the Docker files, Unlock/Lock the vault, sign and verify Evrmore messages. |
| central | `src/central/` | Central's API as Lite calls it ([central.md](central.md)): `register`, `observations`, `submitPredictions` (login, one retry on 401); `pyFloatStr`/`predictionItem` (Python's float strings and the payload hash); `normalizeObservation`. 15 s timeouts; network errors wrapped. |
| db | `src/db/` | DuckDB-WASM 1.32.0 stored in OPFS (`opfs://satori-mvp.duckdb`; `satori.duckdb` on this origin holds the old draft's schema), with tables `meta`, `streams` (uuid, name, meta), `observations` (stream_uuid, ts, value), `predictions` (stream_uuid, made_at, model, t1, t2, observed_at, hash, status, sent_at). Times are unix seconds. |
| engine | `src/engine/` | `forecast(points) → {model, t1, t2} \| null`, the interface step 4 keeps. Pure. |
| neuron | `src/neuron/` | `register`, `cycle` (poll → store → forecast → submit), the poll schedule (`createPoller`), one tab only (a Web Lock). |
| ui | `src/ui/` | ArrowJS screens: Setup (create / restore from words / import Docker files), Home (both addresses, Unlock/Lock, central's status with Poll now, the streams with our t1/t2, Settings, backup). |
| agents | `src/main.js`, `public/llms.txt` | `window.satori`: the same actions as the UI for an AI agent in the page (status, setup, poll, streams, predictions, setCentral, unlock/lock, backup, Docker files). `/llms.txt` tells an agent what the app is, how to drive it, where the code is, and that pull requests are welcome. |

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
  Saving registers there at once.
- **Poll now** (and `window.satori.poll()`) runs a cycle at once; the next
  poll is then 11 h later. One cycle runs at a time.
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
  `'wasm-unsafe-eval'` for DuckDB, `connect-src 'self' https:` for the chosen central.

## Tech (pinned)

`@duckdb/duckdb-wasm` 1.32.0 (newer `latest` builds don't write to OPFS),
`@arrow-js/core` 1.0.6, `@noble/curves` 1.9.7, `@noble/hashes` 1.8.0 (also
the payload hash), `@scure/base` 1.2.6, `@scure/bip39` 1.6.0, `js-yaml` 5.4.2
(step 2: reads and writes Docker's `wallet.yaml`/`vault.yaml`, whose PyYAML
output folds long lines), `vite` 8.3.1, `vitest` 4.1.11, `@playwright/test`
1.63.0. Step 3 added no dependency.

## Verify

- `npm test` (vitest, `--maxWorkers=2`): keys (satorilib parity vectors,
  Docker `wallet.yaml`/`vault.yaml` incl. old vaults, WIF-only, mismatched and
  wrong-password files, Latin-1 passwords, uncompressed-flag signatures; files
  in the wrong slots and plain-text vaults refused; the two-key model);
  central (Python float strings and payload hashes against the Docker-image
  fixture, register, login, the 401 retry, timeouts and network errors, with a
  mocked fetch); neuron (storage and dedupe, forecasting only new rows, the
  kept queue, a failed poll, register and mismatch, the schedule and its
  jitter); engine; db (migration from step 2); ui.
- `npm run e2e` (Playwright, system Chrome, one worker), central2 routed to a
  stub and prod blocked: create → register (headers checked) → first poll
  5–30 min out → Poll now: two streams stored, forecast and sent after an
  identity-signed login (payload strings and hashes checked) → second tab
  refused → reload keeps the schedule and registers again → Unlock (wrong
  passphrase refused) → backup words and both files → Lock, polls go on; the
  agent API (dedupe, a failed batch kept and resent, a 401 retried, the
  central URL setting); Docker import with a vault mismatch and Settings
  (https only, an unreachable central shown); restore from words; two setups
  at once (one wins) leaving other `meta` rows alone. Also an OPFS persistence
  smoke under the CSP.
- Live, in a fresh browser profile on the dev server: central2 (writes
  allowed) for register, Poll now and the batch; prod only for read-only GETs.
- Parity vectors come from satorilib and the Docker image
  (`test/fixtures/README.md`; `scripts/`).
- Dev app: `npm run dev` → http://localhost:5180
