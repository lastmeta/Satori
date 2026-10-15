# satori: overview

This is the source of truth for what is built (steps 1–2). Intent: [../intent/INTENT.md](../intent/INTENT.md).
Later steps: [../future/README.md](../future/README.md).

## The flow

```
source ──fetch──▶ observations ──▶ engine (linear) ──▶ prediction ──sign──▶ publish
 (URL + JSON path)  (DuckDB)        least squares        (DuckDB)   (identity key)  (local outbox)
```

Each stream runs one **tick** every `interval_s` seconds (10 s to 1 day;
default 60 s), and once right away when the page loads (no passphrase needed:
the identity key is unencrypted, as in Docker):
1. Fetch the stream's URL, read the number at its JSON path, and store it as an observation.
2. Fit a straight line to the last 20 observations against their timestamps
   (ordinary least squares) and evaluate it at `target_ts = ts + interval`.
   Fitting on time means a gap (closed tab, failed fetches) is a gap on
   the line, not one step.
3. Sign the prediction with the identity key and store it.
4. Publish it. In step 1 the publisher only marks the prediction as published.
   It has the same shape a central or Nostr publisher will use later.

## Parts

| Part | Folder | Does |
|---|---|---|
| keys | `src/keys/` | Satori's two keys ([keys.md](keys.md)): the **identity** (`wallet.yaml`, unencrypted, signs on its own) and the **vault** (`vault.yaml`, fields encrypted with the passphrase as Docker does, holds funds). Create, restore from words, import/export the Docker files, Unlock/Lock the vault, sign and verify Evrmore messages. |
| db | `src/db/` | DuckDB-WASM 1.32.0 stored in OPFS (`opfs://satori-mvp.duckdb`; `satori.duckdb` on this origin holds the old draft's schema), with tables `meta`, `streams`, `observations`, `predictions`. |
| engine | `src/engine/` | `predict(points, at)` fits the OLS line to `[x, y]` points and returns it at `x = at` (null if no finite result). It is a pure function. |
| neuron | `src/neuron/` | tick: source → db → engine → sign → publish; the scheduler; one tab only (a Web Lock). |
| ui | `src/ui/` | ArrowJS screens: Setup (create / restore from words / import Docker files), Home (both addresses, Unlock/Lock, streams with latest values and predictions, add stream, backup). |
| agents | `src/main.js`, `public/llms.txt` | `window.satori`: the same actions as the UI for an AI agent in the page (status, setup, streams, predictions, verify, unlock/lock, backup, Docker files). `/llms.txt` tells an agent what the app is, how to drive it, where the code is, and that pull requests are welcome. |

## Rules

- Two keys, as Satori Lite ([keys.md](keys.md)). The identity is stored
  unencrypted so the neuron runs from page load and signs predictions with it.
  The vault is stored encrypted; **Unlock** (passphrase) decrypts it into
  memory and **Lock** wipes it. Ticks don't depend on the vault.
- Backup (both keys' words and private keys, `wallet.yaml` and `vault.yaml`
  downloads) needs Unlock, as Docker's dashboard needs login.
- **Remove** stops the stream's tick and waits for one in flight before it
  deletes the stream's data.
- A database from a newer app version is refused, not migrated. The step-1
  prototype's single sealed key (`meta.vault`) is not converted: setup says
  so, and restoring its 24 words as the vault keeps it.
- Only one tab opens the database. Other tabs say "Satori is open in another tab".
- Default stream: BTC-USD spot from `api.coinbase.com`, which allows browser
  calls (`Access-Control-Allow-Origin: *`).
- The page is sent with a strict CSP header: no inline script, `'wasm-unsafe-eval'` for DuckDB.

## Tech (pinned)

`@duckdb/duckdb-wasm` 1.32.0 (newer `latest` builds don't write to OPFS),
`@arrow-js/core` 1.0.6, `@noble/curves` 1.9.7, `@noble/hashes` 1.8.0,
`@scure/base` 1.2.6, `@scure/bip39` 1.6.0, `js-yaml` 5.4.2 (step 2: reads and
writes Docker's `wallet.yaml`/`vault.yaml`, whose PyYAML output folds long
lines), `vite` 8.3.1, `vitest` 4.1.11,
`@playwright/test` 1.63.0.

## Verify

- `npm test` (vitest, `--maxWorkers=2`): keys (satorilib parity vectors,
  Docker `wallet.yaml`/`vault.yaml` incl. old vaults, WIF-only, mismatched and
  wrong-password files; the two-key model), engine, db, neuron and ui.
- `npm run e2e` (Playwright, system Chrome, one worker): create → ticks signed
  by the identity → second tab refused → reload runs with no passphrase →
  Unlock (wrong passphrase refused) → backup words and both files downloaded
  and read back → Lock, ticks go on; Docker import (wrong password refused) with
  a failing source beside a working one; restore from words; the agent API.
  Also an OPFS persistence smoke under the CSP.
- Dev app: `npm run dev` → http://localhost:5180
