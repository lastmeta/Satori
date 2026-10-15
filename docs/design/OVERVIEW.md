# satori MVP: overview

This is the source of truth for step 1. Intent: [../intent/INTENT.md](../intent/INTENT.md).
Later steps: [../future/README.md](../future/README.md).

## The flow

```
source ──fetch──▶ observations ──▶ engine (linear) ──▶ prediction ──sign──▶ publish
 (URL + JSON path)  (DuckDB)        least squares        (DuckDB)   (identity key)  (local outbox)
```

Each stream runs one **tick** every `interval_s` seconds (10 s to 1 day;
default 60 s), and once right away on Unlock:
1. Fetch the stream's URL, read the number at its JSON path, and store it as an observation.
2. Fit a straight line to the last 20 observations against their timestamps
   (ordinary least squares) and evaluate it at `target_ts = ts + interval`.
   Fitting on time means a gap (Lock, closed tab, failed fetches) is a gap on
   the line, not one step.
3. Sign the prediction with the identity key and store it.
4. Publish it. In step 1 the publisher only marks the prediction as published.
   It has the same shape a central or Nostr publisher will use later.

## Parts

| Part | Folder | Does |
|---|---|---|
| keys | `src/keys/` | create or import 24 words; seal them with a passphrase (PBKDF2 → AES-GCM); unlock; Evrmore address; sign and verify messages. The key format is the Docker neuron's: one 32-byte secret = entropy of the 24 words = private key. |
| db | `src/db/` | DuckDB-WASM 1.32.0 stored in OPFS (`opfs://satori-mvp.duckdb`; `satori.duckdb` on this origin holds the old draft's schema), with tables `meta`, `streams`, `observations`, `predictions`. |
| engine | `src/engine/` | `predict(points, at)` fits the OLS line to `[x, y]` points and returns it at `x = at` (null if no finite result). It is a pure function. |
| neuron | `src/neuron/` | tick: source → db → engine → sign → publish; the scheduler; one tab only (a Web Lock). |
| ui | `src/ui/` | ArrowJS screens: Setup, Unlock, Home (streams, latest values and predictions, add stream, backup words, lock). |

## Rules

- Keys exist in memory only while unlocked. The database holds only the sealed
  words. **Lock** wipes the keys from memory and stops every tick: a tick in
  flight stores nothing, and Backup words can't be shown once locked.
- **Remove** stops the stream's tick and waits for one in flight before it
  deletes the stream's data.
- A database from a newer app version is refused, not migrated.
- Only one tab opens the database. Other tabs say "Satori is open in another tab".
- Default stream: BTC-USD spot from `api.coinbase.com`, which allows browser
  calls (`Access-Control-Allow-Origin: *`).
- The page is sent with a strict CSP header: no inline script, `'wasm-unsafe-eval'` for DuckDB.

## Tech (pinned)

`@duckdb/duckdb-wasm` 1.32.0 (newer `latest` builds don't write to OPFS),
`@arrow-js/core` 1.0.6, `@noble/curves` 1.9.7, `@noble/hashes` 1.8.0,
`@scure/base` 1.2.6, `@scure/bip39` 1.6.0, `vite` 8.3.1, `vitest` 4.1.11,
`@playwright/test` 1.63.0.

## Verify

- `npm test` (vitest, `--maxWorkers=2`): unit tests for keys (including Docker
  key parity vectors from `draft/v1-full`), engine, db, neuron and ui.
- `npm run e2e` (Playwright, system Chrome, one worker): create → tick → reload
  → unlock → data still there → backup words → Lock, plus the second-tab check;
  and a failing source showing its error without stopping other streams. Also an
  OPFS persistence smoke under the CSP.
- Dev app: `npm run dev` → http://localhost:5180
