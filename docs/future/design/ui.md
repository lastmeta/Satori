# UI

[← OVERVIEW](OVERVIEW.md)

ArrowJS (`@arrow-js/core` 1.0.6: `reactive`, `html`, `component`, `watch`) on the
main thread. State arrives from the neuron worker as snapshots; actions go to it
as messages.

## What it replaces (verified)

The Docker UI is Flask with server-rendered Jinja pages and inline JS
(`neuron/web/app.py:13-53`, started by `neuron/neuron-lite/start.py:5261-5268`).
Each session holds its own `WalletManager`, the vault password sits
Fernet-encrypted in the session cookie (`neuron/web/routes.py:134-234`), and the
browser logs out after 5 idle minutes (`neuron/web/templates/base.html:2103-2150`).
Flask routes become function calls into the worker; there is no server session.

## v1 pages

| Page | Does | Docker counterpart |
|---|---|---|
| **Welcome** | create (show 24 words, confirm), import (wallet.yaml / vault.yaml / nostr.yaml, words, WIF), set passphrase | `/vault-setup`, `/api/wallet/import` (`routes.py:570-622,2281-2492`) |
| **Sign in** | passphrase; "remember on this device" for the identity; idle timeout wipes the vault from memory | `/login` (`routes.py:462-568`) |
| **Delegate** | Delegate / Revoke and status ("transfers locked until"); identity and vault Base addresses with QR and ETH balance; gas warning; vault SATORI vs the 250 central gate | Settings "Staking" card (`settings.html:744-870`) |
| **Claim** | merkle reward ("no drop published yet" vs "not in the drop"), airdrop, on-chain prediction rewards; one button each | dashboard claim cards (`dashboard.html:2184-2258`) |
| **Status** | neuron active/sleeping, central and register state, last central batch, this round's Base batch and its games, next due, 250 gate, storage used | dashboard monitoring (`routes.py:850-979`) |
| **Backup** | show words (passphrase required), export legacy `wallet.yaml`/`vault.yaml` and `nostr.yaml` | `/api/wallet/download` (`routes.py:3214-3258`) |
| **Settings** | central URL, Base RPC URL | Settings page |

Never "Stake": the Docker "Stake" page is the legacy central pool/lender page
(`neuron/web/templates/stake.html`). Delegation words: OVERVIEW decision 1.

Later: per-stream chart and model view, "Add SATORI to MetaMask"
(`dashboard.html:3625-3710`), relay settings, pub/sub, marketplace, bounties,
channels, Evrmore send, data sources, pool/lender, reward address.

## Security

Content-Security-Policy, sent as an **HTTP response header** on the HTML and on
every worker script (a dedicated worker's CSP comes from its own response, not
the page's `<meta>`):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
connect-src 'self' https: ; img-src 'self' data:; style-src 'self';
object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

- `'wasm-unsafe-eval'` is required: without it WebAssembly is blocked, which
  stops DuckDB (MDN CSP `script-src`).
- `connect-src https:` because central and the RPC are user-chosen URLs; Nostr
  parity adds `wss:`.
- The host must set headers ([OVERVIEW](OVERVIEW.md#tech-stack-pinned)).
- Playwright asserts DuckDB and key derivation run under this exact policy.
- Keys never reach the main thread. Words and private keys are rendered only on
  Backup after re-entering the passphrase.

## Dropped

Host metrics (psutil), the local relay sidecar settings, the broken
"Relay registration" card (POSTs to `/api/relay`, which has no route:
`settings.html:1608`).
