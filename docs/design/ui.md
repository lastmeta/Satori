# UI

[← OVERVIEW](OVERVIEW.md)

ArrowJS (`@arrow-js/core` 1.0.6: `reactive`, `html`, `component`, `watch`) on the
main thread. State arrives from the neuron worker as snapshots; actions go to it
as messages. Charts read Arrow tables from DuckDB queries run in the worker.

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
| **Unlock** | passphrase; "remember on this device" for the identity; idle auto-lock wipes the vault from memory | `/login` (`routes.py:462-568`) |
| **Lock** | Lock / unlock toggle and status (locked, unlock time); identity and vault Base addresses with QR and ETH balance; gas warning | Settings "Staking" card (`settings.html:744-870`) |
| **Claim** | claimable merkle reward, airdrop, on-chain prediction rewards; one button each | dashboard claim cards (`dashboard.html:2184-2258`) |
| **Predictions** | per stream: observations vs predictions chart, error, chosen model; last Base batch and its games | `/local-predictions` (`local_predictions.html:695-960`) |
| **Status** | neuron active/sleeping, relays (wss reachable or not), central, last poll/batch, next due, storage used | dashboard monitoring (`routes.py:850-979`) |
| **Backup** | show words (passphrase required), export legacy `wallet.yaml`/`vault.yaml` and `nostr.yaml` | `/api/wallet/download` (`routes.py:3214-3258`) |
| **Settings** | central URL, Base RPC URL, extra relays | Settings page |

The page is called **Lock**, never "Stake": the Docker "Stake" page is the
legacy central pool/lender page (`neuron/web/templates/stake.html`), a different
thing. A small "Add SATORI to MetaMask" button
(`wallet_addEthereumChain`/`wallet_watchAsset`, `dashboard.html:3625-3710`) is
cheap and kept.

Named games have no page in Docker (grep of templates for "game": 0 hits); they
show up only as games in the Base batch list.

## Security

- Strict CSP: scripts from our origin only; no third-party scripts at runtime.
- Keys never reach the main thread. Words and private keys are rendered only on
  the Backup page after re-entering the passphrase.

## Later

Pub/sub management, marketplace, bounties, channels, Evrmore send, data
sources, pool/lender, reward address.

## Dropped

Host metrics (psutil), the local relay sidecar settings, the broken
"Relay registration" card (POSTs to `/api/relay`, which has no route:
`settings.html:1608`).
