# satori

The Satori neuron in the browser: one static web app that holds the keys,
forecasts streams, submits predictions to central and Base, delegates the
vault's prediction power and claims rewards. No server of our own.

Design (source of truth): [docs/design/OVERVIEW.md](docs/design/OVERVIEW.md).
External blockers: [docs/issues/README.md](docs/issues/README.md).

## Run

```sh
npm install
npm run dev       # http://localhost:5180, sends the production CSP header
npm test          # vitest (unit), --maxWorkers=2
npm run e2e       # playwright in system Chrome, 1 worker, against :5180
npm run build && npm run preview   # built app on :5181, same CSP header
```

## Layout

| Path | Owns |
|---|---|
| `src/identity/` | keys, backup words, encryption at rest, Docker import/export |
| `src/store/` | DuckDB-WASM on OPFS, schema, migrations |
| `src/central/` | central login, register, observations, predictions |
| `src/chain/` | Base reads/writes (viem) |
| `src/engine/` | forecaster and Base direction rule |
| `src/runtime/` | leader lock, scheduler, catch-up |
| `src/ui/` | ArrowJS pages |
| `src/worker.js` | neuron worker entry |
| `src/main.js`, `index.html` | page entry |
| `csp.js` | the CSP (kept equal to docs/design/ui.md by `test/csp.test.js`) |
| `test/fixtures/` | parity vectors and recorded responses |
| `e2e/` | playwright specs; `e2e/opfs/` is the DuckDB OPFS probe |

Unit tests sit next to their module (`src/<module>/*.test.js`).

The CSP has `style-src 'self'`: styles must come from `.css` files linked from
HTML, not inline `style=` or JS-injected `<style>`.
