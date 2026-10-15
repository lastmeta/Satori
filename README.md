# satori

The Satori neuron as a client-side browser app: Satori's two keys (identity
and vault, Docker-compatible), a DuckDB-WASM database in the browser, and
central's data flow as the Docker neuron (Satori Lite) runs it:

```
register ─▶ poll central (5–30 min after start, then every 11 h) ─▶ store ─▶ forecast new rows ─▶ submit the batch
```

On every page load the neuron registers its identity and vault public keys
with central. It then polls central's observations, stores them, forecasts
each stream that got a new observation, and sends the predictions to central
after a login signed by the identity. The engine (`bar1`, after the owner's
`namaste_club`) is a Bayesian AR(1) on 12 h returns: shrunk toward "tomorrow
= today", iterated to t1 (12 h) and t2 (24 h), and faded toward the last value
as far as its own backtest says it trails it. With less than 4 days of history
it sends the last value (`naive`). Predictions central does not take are kept and sent with the next
poll. **Poll now** runs a cycle at once. No server of our own: the browser
talks to central directly.

![Home](docs/screenshots/central.png)

## Run

```sh
npm install
npm run dev        # http://localhost:5180 (CSP header on every response)
```

The dev server talks to the dev central, `https://central2.satorinet.io`; a
build (`npm run build`) defaults to `https://network.satorinet.io`. Change it
under **Settings** on Home.

Setup makes two keys, as the Docker neuron does: the **identity** (stored
unencrypted, so the neuron runs and signs in to central from page load) and
the **vault** (holds funds, encrypted with your passphrase). Create new ones,
restore from words, or import a Docker neuron's `wallet.yaml` + `vault.yaml`.
**Unlock** opens the vault (needed for backup and the Docker file downloads);
**Lock** wipes it from memory. Only one tab runs the neuron; others say so.

AI agents: read [/llms.txt](public/llms.txt); the page exposes `window.satori`.

## Test

```sh
npm test           # vitest: keys and central parity (Docker-image vectors), central client, neuron cycle and schedule, engine (namaste_club parity), db, ui helpers
npm run e2e        # playwright, system Chrome, against a stub central: full flow + OPFS persistence smoke
node scripts/backtest.mjs   # the engine vs persistence at 24 h on real history (read only)
```

## Code

| Folder | Does |
|---|---|
| `src/keys/` | identity + vault, 24 words / WIF ↔ secret, Docker `wallet.yaml`/`vault.yaml`, Evrmore address, sign/verify |
| `src/central/` | central's API as Lite calls it: register, observations batch, login, predictions batch; Python float strings and payload hash |
| `src/db/` | DuckDB-WASM on OPFS; schema with a version for migrations; small async API |
| `src/engine/` | `forecast(points) → {model, t1, t2, phi?, weight?}`: `bar1` (Bayesian AR(1) on 12 h returns, faded toward persistence) or `naive` |
| `src/neuron/` | `register`, `cycle` (poll → store → forecast → submit), the 11 h schedule, single-tab Web Lock |
| `src/ui/` + `src/main.js` | ArrowJS screens, app wiring, `window.satori` |
| `public/llms.txt` | how an AI agent drives the app |
| `scripts/` | parity vectors from satorilib's code, the Docker image and namaste_club (Python); `backtest.mjs` |

## Docs

- Intent: [docs/intent/INTENT.md](docs/intent/INTENT.md)
- Design (source of truth): [docs/design/OVERVIEW.md](docs/design/OVERVIEW.md),
  keys: [docs/design/keys.md](docs/design/keys.md),
  central: [docs/design/central.md](docs/design/central.md),
  engine: [docs/design/engine.md](docs/design/engine.md)
- Later steps, already researched: [docs/future/README.md](docs/future/README.md)
