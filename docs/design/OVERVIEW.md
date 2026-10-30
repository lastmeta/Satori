# satori: overview

This is the source of truth for what is built (steps 1–6, the finishing
pass, the installable app and the deployment). Intent: [../intent/INTENT.md](../intent/INTENT.md). The roadmap and
what is left: [../plans/README.md](../plans/README.md). Open issues:
[../issues/](../issues/README.md). Questions for the owner:
[../inbox/QUESTIONS.md](../inbox/QUESTIONS.md). For agents, and the one
reference for `window.satori`: [/llms.txt](../../public/llms.txt).

Component docs: [health.md](health.md) (Home: is the neuron predicting, is
anything broken), [models.md](models.md) (the Models tab: the engine's
status, every model, a model's In, Model and Out), [keys.md](keys.md),
[wallets.md](wallets.md) (a wallet, its alias, and several accounts), [central.md](central.md),
[engine.md](engine.md), [nostr.md](nostr.md), [base.md](base.md),
[market.md](market.md) (paid streams, step 3 of the market: selling and
buying streams over the relays, `src/neuron/market.js`, on the
payment-channel client, `src/chain/channels.js`),
[storage.md](storage.md), [track-record.md](track-record.md) (every
prediction stream on the relays scored against no change from what this
neuron saw arrive), [pwa.md](pwa.md) (the installed app), [push.md](push.md) (the daily push),
[deploy.md](deploy.md) (the image at app.satorinet.io, and the build
variables).

## The flow

The neuron runs central's data flow the way Satori Lite (the Docker neuron)
does ([central.md](central.md)):

```
page load ──▶ register with central (alias + wallet public keys)
first poll at once (unless one is still ahead), then every 11 h (or Poll now):
  GET observations ──▶ store (DuckDB) ──▶ history for new streams ──▶ forecast streams not predicted yet ──▶ queue ──▶ login (alias) ──▶ POST predictions
                       insert or ignore    once per stream (central)    each one's bvar spec, evolved         pending      signs the challenge    batch; kept on failure
```

1. **Register** on every page load: `alias-pubkey`, the wallet's link to the alias
   (`wallet-link`, `wallet-signature`: [wallets.md](wallets.md)), `nostr-pubkey` and `neuron-version`
   (`browser-<package version>+<git short sha>`, stamped by `vite.config.js`; also in Settings › This
   device and `status().version`). The result is
   shown on Streams, and on Home as a **wallet mismatch** (with both
   addresses) if central pays this wallet's rewards to another Base address,
   or as **wallet not linked** if it has none (register's `wallet_address`).
   A central that does not send that field leaves it unknown: no mismatch.
2. **Poll** central's observations batch (the latest observation of each
   stream, under 48 h old), right after register: a new neuron, or one
   reopened with a poll due, polls at once (Lite waits a random 5–30 min;
   browser opens are not synchronized). The next poll time is stored, so a
   reload keeps the 11 h cadence.
3. **Store** each observation once per (stream, whole second).
4. **History**: a stream seen for the first time gets its past from central
   (`/observations/history`, an addition beyond Lite; up to 1,000 hourly rows),
   stored older than its newest polled row, so it never triggers a prediction
   ([central.md](central.md#history-an-addition-beyond-lite)). Central2 answers
   404 today: remembered for a day, then asked again.
5. **Forecast** each stream whose latest observation has no prediction
   made from it (a new row, or one a reload mid-poll stored and never
   forecast; each observation once), from all their stored history ([engine.md](engine.md)): `t1` 12 h ahead and `t2` 24 h ahead.
   Each target has its **own spec**, drawn from the alias: `bvar`, a
   Bayesian VAR(1) of the target and 1–3 companion streams (namaste_club's
   Minnesota prior with the spec's λ1 and λ2), faded toward persistence by its
   own backtest. After each poll one mutation of each spec (swap, add or drop
   a companion, move λ1 or λ2) is scored on the same backtest and kept only if
   it beats the champion by the margin, so neurons start differently and each
   keeps what predicts better. A spec that can't fit yet falls back to `bar1`
   (the AR(1) of the target alone), then `naive` (the last value); the
   prediction's `model` says which. `bar1` needs 6 lag pairs of back-to-back
   12 h buckets (about 4 days of 11 h polls without history); `bvar` 7–9
   aligned rows.
6. **Submit** everything pending right after the poll, as Lite's payload
   (`value` = t2, `t1_value`, `observed_at`, `hash`; numbers as JS prints
   them, which central reads with `float()`: [the protocol audit](central.md#the-protocol-audit)).
   A batch central rejects (`successful == 0`) or a failed call keeps the
   predictions for the next poll; ones older than 2 × 11 h are dropped.
   A network error, a timeout or a 5xx is resent once.

No passphrase is needed: the alias key is unencrypted, as in Docker.

Next to it, the neuron follows Satori streams on Nostr relays and publishes a
prediction stream for each, as Lite does ([nostr.md](nostr.md)). Relay
streams are kept apart from central's: relay predictions go only to Nostr.

```
relays = central's /peer/relays + Settings      subscribe (Network streams): 34602 + `<stream>_pred` 34600
REQ follow {kinds:[34601], authors:[p], #d:[…]} ──▶ verify ──▶ store once ──▶ forecast (one cadence ahead) ──▶ `<stream>_pred` 34601, seq + 1
on each (re)connect and hourly: announce `<stream>_pred`; hourly: relay list, reconnect; daily: NIP-65
```

It also watches every prediction stream the relays announce (`<name>_pred`
naming its source, up to 200) and each one's source, and keeps a **verified
track record** for each: its predictions against no change, counting only
those this app received before the outcome ([track-record.md](track-record.md)).
Watching only reads; the Streams tab and `records()` show it.

```
relays open, then hourly at most every 6 h: scan the catalog ─▶ `_pred` streams + sources ─▶ watch_streams
follow REQ: subscriptions ∪ watched ─▶ 34601 verified ─▶ watched: watch_observations (when it arrived) ─▶ records()
```

On the dev server central's relays (satorian, production) are **read only**
(REQ, never EVENT) and the user's relays default to the test relay
`ws://localhost:7778` (`scripts/test-relay.mjs`); a build writes to central's
relays, and its own relays are `VITE_NOSTR_RELAYS` (none unless set; the
deployment's: `wss://nostr.satorinet.io`).

On Base the neuron predicts as Lite does ([base.md](base.md)): the wallet
stakes with this app once (Unlock; on-chain its
`delegatePredictionPower(alias)`), and the alias sends one batch of
up/down predictions each UTC round on its own.

```
status (no key): one multicall ── ETH ×2, the wallet's SATORI, the stake, fee, lock, round, claimables
Unlock ─▶ Stake: alias setPredictorFee(0), setAllowedDelegator(wallet) ─▶ wallet delegatePredictionPower(alias)
each round, first check: power > 0, no batch yet ─▶ registry streams with a game ─▶ engine (≥ 24 h ahead) vs latest: UP/DOWN
     ─▶ simulate each game alone ─▶ predictMultipleWithPayloads(the ones that pass) ─▶ receipt ─▶ persist
Unlock ─▶ Claim: hub.claim() · merkle (central's proof) · airdrop      Send: ETH; SATORI when it can be sent
```

On the dev server the Base RPC is `/rpc`, which Vite proxies to a local
anvil fork of Base Sepolia (`scripts/fork.mjs`); a build uses its pinned
`VITE_BASE_RPC` (the deployment: `https://sepolia.base.org`) with publicnode
as a fallback, which central's config never overrides; a build that pins none
uses central's `rpcUrl`, then publicnode.

## Parts

| Part | Folder | Does |
|---|---|---|
| keys | `src/keys/` | Satori's two keys and the Nostr key in one record of this app's own, `meta.keys` ([keys.md](keys.md)): the **alias** (plain text, signs on its own), the **wallet** (sealed with the passphrase: PBKDF2-SHA256 600,000 and AES-256-GCM, any Unicode passphrase of 8 or more; holds funds; its public key in clear) and the **Nostr key** (random, plain text). Create, restore from words, import a Dockerized Neuron's files (read only, translated: `docker.js`), Unlock/Lock (an earlier version's wallet is re-encrypted at its next Unlock; it locks on its own after 5 min without interaction, `autolock.js`), backup and send with the passphrase each time. Each key's Base address and transaction signatures (`signDigest`), inside the signer so Lock still wipes it ([base.md](base.md#keys-on-base)); the alias's central login signature (EIP-191). |
| central | `src/central/` | Central's API as Lite calls it ([central.md](central.md)): `register`, `observations`, `submitPredictions` (login, one retry on 401); `rewardAddress`, `setRewardAddress` (signed in the same way); `predictionItem` (the payload and its hash); `normalizeObservation` (Lite's `EPOCH` bounds); for Base `baseConfig`, `merkleProof`. 15 s timeouts; network errors wrapped. `login.js`: central's login signature, EIP-191 by the alias ([central.md](central.md#login-signature)). |
| chain | `src/chain/` | The D7 contracts on Base Sepolia over viem ([base.md](base.md)): the bundled addresses, which central's config is checked against and never overrides (`config.js`), minimal ABIs (`abi.js`), and `createChain`: the status multicall, stake/unstake, the batch's pieces, streams kept by voting weight, claims, sends; every write simulated first, one at a time, with gas over the estimate for contract calls, under the max fee; CCIP-read off. Its test doubles (a fake D6 behind JSON-RPC) are in `test/`. |
| db | `src/db/` | DuckDB-WASM 1.32.0 on OPFS (`opfs://satori-mvp.duckdb`, a file per wallet: [wallets.md](wallets.md)), tables `meta`, `streams`, `observations`, `predictions`, `model_specs`, and for Nostr `relay_streams`, `relay_observations`, `relay_predictions`, `watch_streams`, `watch_observations` (the track record, migration 14), and `activity` (Home's log, [health.md](health.md)); ordered migrations (each marked additive or not, so an older build can open a newer database that only added); every call one at a time; every commit checkpointed; a WAL an older version left set aside before the open, and a database file that won't open set aside on the person's word (`recover.js`) ([storage.md](storage.md): tables, migrations, every meta key, the checkpoint rule, recovery). Times are unix seconds. |
| engine | `src/engine/` | `forecast(points, { step, horizon }) → {model, t1, t2, value, horizon, phi?, weight?} \| null` ([engine.md](engine.md)): `bar1`, `bar1d` (the same on changes, for a series with a value ≤ 0) or `naive`; step 12 h for central, a relay stream's cadence; `value` one cadence ahead (24 h for central: t2). For central's streams `runModels` (`evolve.js`): each target's spec (alias-seeded), one mutation per poll kept by the margin, and its `bvar` forecast (`bvar.js`, a Bayesian VAR(1) with 1–3 companions) or the fallback. Pure (sha256 from `@noble/hashes` for the seeded draws). |
| nostr | `src/nostr/` | NIP-01 events over `@noble/curves` schnorr (`event.js`), Satori's events and parsing byte for byte as satorilib (`satori.js`), one relay over a WebSocket with reconnect (`relay.js`) ([nostr.md](nostr.md)). The engine reads a relay stream's last 400 cadences, and older observations are pruned daily ([nostr.md](nostr.md#data-growth)). |
| neuron | `src/neuron/` | `register` (and its wallet check: register's `wallet_address` against the wallet's Base address, [central.md](central.md#the-wallets-link)), `cycle` (poll → store → history → forecast → submit), `history.js` (central's history for new streams), central's status, the poll schedule (`createPoller` over `schedule.js`, which the Base check shares), one tab only (a queued Web Lock: the next tab takes over when it closes); `nostr.js`: relays, discover, subscribe, intake → `_pred`, reconcile, the scan for prediction streams and the intake's routing (watched, subscribed, both); `records.js`: the track record ([track-record.md](track-record.md)): which prediction streams are watched, the follow filters, the verified-order scoring, `records()` and `record()`; `market.js`: paid streams ([market.md](market.md#selling-and-buying-over-the-relays)): sell, deliver, buy, vouchers, settle, stop; `base.js`: the daily batch and its schedule, stake, claims, sends, the Base settings; `reward.js`: the reward address, checked (0x, its checksum, not zero), read and set ([central.md](central.md#the-reward-address)). |
| train | `src/neuron/train.js` | The training pass ([models.md](models.md#the-training-pass)): every model without a current fit (a spec's stored fit key not its data's, a `_pred` or Base game with no backtest kept) is fit from stored history on load, after a poll and whenever the list changes; never a prediction or a submission; Home's "Scoring models · k of n". |
| retrain | `src/neuron/retrain.js`, `src/engine/retrain.js` | Retrain ([models.md](models.md#retrain)): a user's request to keep training one Satori Service model until it beats no change. The search (pure): a seeded hill-climb over its companions, λ's and the single-stream AR, scored on the older backtest origins, its best looked at once on the last two weeks (20 % less error than no change). The runner: one at a time, kept with the spec (migration 13), paced in slices, waiting while a poll runs, resumed on open; never a prediction; Home's "Retraining eth · tried 40". |
| models | `src/neuron/models.js` | The Models tab's data ([models.md](models.md)): every model (central's, the Base batch's, the Nostr `_pred`s) with its quality against no change (the engine's backtest medians: better, tie or worse by evolution's 5 % margin), its inputs by influence (the fitted bvar's standardized coefficients) and its outputs, a list, each with where it went; the engine's status; one model's drill-in recomputed from its stored spec and history. |
| health | `src/neuron/health.js`, `src/neuron/activity.js`, `src/neuron/work.js`, `src/ui/hold.js` | Home's answer ([health.md](health.md)): `activity.js` writes the activity log (migration 8: sessions with a heartbeat, central cycles, Base checks, Nostr publishes, history runs, wallet actions, errors; 90 days); `health.js` turns it and the current statuses into one status (`ok`, `idle`, `warn`, `bad`), its tone (the three greens, amber, red, grey for off), title and line, at most one action (the reasons in priority order, each bad, warn, idle or advice: a suggestion for the card that never colours the hero), the day strip, the three chips and the feed. Pure. `work.js`: what the neuron is doing now, one entry per task `{ task, step, done, total, since, critical }`, set by the cycle, the history, the engine, the Base batch and the actions; `hold.js` paces Home's hero (its turning ring and its step) so each step can be read ([health.md](health.md#work-what-it-is-doing-now)). |
| ui | `src/ui/` | ArrowJS, phone first: six tabs, on a phone a bar of Game, Home and Menu (☰) of Models, Streams, Market, Wallet, Settings, a top nav on a computer (≥ 1024 px), hash routes `#game` (blank for now; the app opens to it when it was entered last) `#home` `#models` (and `#models/<id>`) `#streams` `#wallet` `#settings` (`view.js`, the shell, with Setup and the screens before Home). **Models** (`models.js`, its words and chart in `drill.js`; [models.md](models.md)): the engine's status (working, in Home's hero's words without a second ring; resting; amber only when the engine failed), the models by kind and against no change, every model named for the stream it predicts (its mark against no change, kind, inputs by influence, latest → forecast, where it goes; filter by destination, sort by quality or name) and a model's drill-in: In (each input's share), the Model, Out (a list of outputs, each with its chart and destinations). **Home** (`home.js`): the health, the one action card, the day strip (14 days; 30 on a computer), the Central/Base/Network chips, claimable rewards with Claim; on a computer also a streams table with trend lines, the wallet and the activity feed, as the approved mockup ([home-mockup.html](home-mockup.html)). **Streams** (`streams.js`): central's facts and Poll now, each stream (forecast, model, companions; its history on a tap), the Nostr subscriptions, the prediction streams' track records ([track-record.md](track-record.md#ui-streams)), Network streams. **Wallet** (`wallet.js`): Base. **Settings** (`settings.js`): the keys with Unlock/Lock, Backup, the reward address (read when Settings opens; Save, Clear: [central.md](central.md#the-reward-address)), Appearance (System, Light, Dark: `theme.js`, kept on this device and read before the first paint by `public/theme.js`), this device (storage, Install, Update), and folded under Advanced at the bottom the central URL, relays, Base RPC and max fee. The inline Unlock (`parts.js`) wherever an action needs the wallet. `state.js`: the one reactive state; `format.js`: display text. The tokens, light and dark, with the semantic ok/warn/idle/bad colors, the three greens (sky, regular, vivid: [health.md](health.md#the-tone-three-greens)) and the traffic glow's: `src/style.css`, light on `:root`, dark under the system's `prefers-color-scheme` (unless `data-theme="light"`) and the same under `data-theme="dark"`; `src/style.test.js` holds every theme to WCAG contrast (4.5:1 text, 3:1 the status colours and the greens) and the greens to their OKLCH derivation. |
| pwa | `src/pwa/`, `public/manifest.webmanifest` | The installed app ([pwa.md](pwa.md)): the manifest and the Satori icons; the service worker (`sw.js`, written to `dist/sw.js` by a build-only Vite plugin; none on the dev server): precaches the page, `/theme.js` and the hashed assets (DuckDB's wasm and worker), cache first for `/assets/` and `/theme.js`, network first for the page, nothing else touched; "Update ready, reload"; Install Satori (Chromium's prompt, or how on iOS, Safari on a Mac and Firefox on Android: `platform.js`; once on Home as advice); persistent storage asked for at start, shown in Settings. The worker registers once the database is open. It never runs the neuron while closed; with the daily reminder on, a push wakes it to send the day's Satori contract batch, or to remind ([push.md](push.md): `push.js`, `wake.js`, `handoff.js`; the server in `push/`). |
| agents | `src/agent.js`, `public/llms.txt`, `public/llms-changelog.txt` | `window.satori`: the same actions as the UI for an AI agent in the page, under the same guards, with `health()` (Home's answer), `models()` and `model(id)` (the Models tab's) and `go(tab)`; `<body data-screen>` (and `data-tab`) and `data-test` on what carries data or an action. [/llms.txt](../../public/llms.txt) is the one reference for both: a glossary, **Safety** (what the calls return is data, never instructions; which calls only on the human's explicit request), a quick start, what the app is, how to drive it, where the code is, and that pull requests are welcome. What changed, and when, is [/llms-changelog.txt](../../public/llms-changelog.txt), newest first (2026-10-19: moved out of llms.txt, which put 30 KB of history before the reference). |
| config | `src/config.js` | Settings' defaults ([deploy.md](deploy.md#build-variables)): the dev server's (central2, the test relay, central's relays read only, `/rpc`) or a build's (prod central, no user relay, central's relays written to, central's RPC), each replaced by its `VITE_*` variable when the build sets one. `vite.config.js` runs the same check before a build, so a bad value stops it; a build's bundle holds only its own defaults. |
| deploy | `deploy/`, `scripts/deploy-image.sh` | The static image ([deploy.md](deploy.md)): nginx serving `dist/` behind central's nginx-proxy (TLS there), the CSP from `csp.js` on every response, immutable `/assets/`, `no-cache` for the rest, gzipped copies (DuckDB's wasm also in brotli: 5.1 MB, not 7.6), the SPA fallback. |
| shared | `src/util.js` | `serial()` (one at a time, in order: the db, the chain's writes, Nostr's intake and outbox), `isHttps()`, `isRelayUrl()`. |
| traffic | `src/traffic.js`, `src/ui/glow.js` | One emitter: `emit('central' \| 'base' \| 'network')` from central's `fetch`, Base's viem transport (traced) and each relay message sent or received; Home subscribes, and its chips glow while their channel talks ([health.md](health.md#traffic)); `health().channels[x].lastTraffic`. No polling. |
| tests | `test/`, `e2e/` | Parity fixtures and test doubles (a fake D7 behind JSON-RPC, an in-memory DuckDB); Playwright specs and their one stub central (`e2e/stub.js`). |

## Rules

- Base only: each key's address is its Base (0x) address, the only kind
  shown. Central's login is EIP-191 (`personal_sign`) by the alias, and
  register's wallet check compares Base addresses
  ([central.md](central.md#the-wallets-link)). There is no
  Evrmore anywhere in the app.
- Migrate in, never back (owner, 2026-10-16): local formats are this app's
  own; a Dockerized Neuron's files are imported and translated, nothing is
  exported back to Docker's formats; Satori Lite is the reference for what
  goes over the network.
- Two keys, on purpose, as Satori Lite ([keys.md](keys.md)). The alias
  is stored unencrypted so the neuron runs from page load and signs on its
  own: central's login, its Nostr announcements' `alias_pubkey`, the daily
  Base batch. The wallet is stored encrypted and holds the funds; **Unlock**
  (the passphrase, in Settings › Keys, or in place where an action needs it) decrypts it into memory and **Lock**
  (in the header while unlocked) wipes it. The neuron never needs the wallet.
- Backup (both keys' words and private keys, the Nostr key's `nsec` and hex;
  no files) needs Unlock, as Docker's dashboard needs login. Every action that
  needs the wallet (Stake, Claim, Send, Backup) asks for the passphrase in
  place, as one inline prompt, then does the action.
- Home answers one question, "is my neuron predicting every day on its own,
  and is anything broken?", from the activity log and the statuses
  ([health.md](health.md)): exactly one status, at most one action card (the
  highest-priority reason with a button; advice, such as Back up, only when
  nothing is wrong, and it never colours the hero), the day strip, three
  chips, the feed.
  Being closed is never an error: a browser neuron runs only while open.
- **Words people see** (owner, 2026-10-18, [../intent/ui.md](../intent/ui.md)):
  central is the **Satori Service** ("Network", free to submit to), the
  Base contracts the **Satori contract** ("Contract", it uses gas), the
  Nostr relays the **Satori Network** ("Relays"). The UI never says
  "central" or "server", except Settings' "Satori Service address", the one
  place a URL shows; Base stays the chain's name (ETH on Base, Base
  addresses). Agents' channel and destination keys use the words
  (`health().channels.{network, contract, relays}`, `destinations[].to`);
  the code's identifiers, method names and `status().central` keep theirs.
- **Icons over words, only when instantly understood** (owner, 2026-10-18,
  [../intent/ui.md](../intent/ui.md)): an icon stands alone only when its
  meaning is obvious to someone new, or when the same icon is paired with
  its word nearby; else the word, or the icon and the word. The audit
  ([below](#icons)).
- **The Satori Service address** (Settings, `meta.central_url`, the code's "central URL"): https only. Empty means the
  default: `https://central2.satorinet.io` on the dev server (so nobody writes
  to prod from a dev checkout), `https://network.satorinet.io` in a build, or
  the build's `VITE_CENTRAL_URL` ([deploy.md](deploy.md#build-variables); the
  deployment: central2 for now).
  Saving registers there at once; a different URL drops the pending
  predictions and the stream list (another central has other uuids), which
  refill with the next poll.
- **Poll now** (and `window.satori.poll()`) runs a cycle at once; the next
  poll is then 11 h later. One cycle runs at a time. A cycle never throws:
  central's errors and local ones (the database) are logged and shown as the
  last poll or submission.
- Predictions are not signed one by one: as in Lite, the login signature
  authenticates the batch.
- A database from a newer app version is not migrated: it opens as it is when
  every migration this version doesn't know is additive (`meta.schema_min`),
  else it is refused in plain words. A database file that won't open offers
  "Set aside and start again" (renamed, never deleted; then Restore or
  Import) ([storage.md](storage.md#recovery)). Setup writes only its own row
  (`meta.keys`) and leaves any other row as it is.
- One setup runs at a time, from the UI or an agent (`window.satori.setup`):
  both take the same guard, and a second one is refused.
- Import takes `wallet.yaml` only in plain text and `vault.yaml` only
  encrypted; files in each other's slots are refused as swapped. The wallet is
  never stored in plain text. A new passphrase is any Unicode, at least 8
  characters; the Docker wallet password is reused when it meets that
  ([keys.md](keys.md#import-translate)).
- Only one tab opens the database. Other tabs say "Satori is open in another tab"
  and wait in the Web Lock's queue: when that tab closes, the next takes over
  and runs the neuron, with no reload; an installed app's window counts as a
  tab ([pwa.md](pwa.md#one-neuron)).
- The service worker exists only in a build and caches only this origin's
  `/assets/` and the page; a new version waits for **Update ready, reload**
  and never reloads the page on its own. The neuron asks for persistent
  storage after setup and on each load until it is kept ([pwa.md](pwa.md)).
- OPFS keeps what DuckDB has checkpointed, so DuckDB checkpoints every
  commit itself (`checkpoint_threshold = '0b'`) and the WAL stays empty: a
  reload or a closed tab at any moment keeps every committed write, the keys
  included. A WAL an older version left is set aside, never deleted, before
  the database opens, with a notice when it held changes DuckDB can't replay
  ([storage.md](storage.md#the-checkpoint-rule), [recovery](storage.md#recovery)).
- The page is sent with a strict CSP header: no inline script,
  `'wasm-unsafe-eval'` for DuckDB, `connect-src 'self' https: wss:` for the
  chosen central, the RPC and the relays (the dev server adds `ws:` for its
  test relay), `form-action 'none'`. An https page can't open `ws://` (mixed
  content), so a deployed app needs `wss://` relays
  ([issue](../issues/relays-not-wss.md)): central's `ws://satorian…` is
  reached through its wss stand-in, `wss://relay.satorinet.io`
  ([nostr.md](nostr.md#relays-and-the-read-only-flag)). The deployment also sends HSTS
  ([deploy.md](deploy.md#what-it-sends)).
- A change of the Satori Service's address, the Base RPC or the reward
  address, from Settings or an agent, is logged and noted quietly on Home for
  24 h ([health.md](health.md#address-changes)).
- **The reward address** (Settings › Reward address, `setRewardAddress`):
  where the Satori Service sends this neuron's rewards instead of the wallet,
  such as a pool's. Base only (0x, checked and sent checksummed; never this
  neuron's alias, as the app claims only from the wallet); none set: the
  wallet. The Satori Service keeps it; the alias signs it in, so it is
  free and needs no Unlock. It is not staking. In Settings, not the Wallet:
  the Wallet is the wallet's, on-chain and paid in gas
  ([central.md](central.md#the-reward-address)).
- The Nostr key is stored unencrypted like the alias, so the neuron signs
  its events on its own. Its backup needs Unlock, as the others: they are
  private keys.
- Base: the alias signs the daily batch on its own; the wallet signs only
  after Unlock (stake, unstake, claims, sends). Transactions go only to the
  configured RPC (Settings, `meta.base_rpc_url`: https or a same-origin path);
  the dev server's default is the local fork, so by default a checkout does
  not send to a public chain; an RPC on another chain is refused
  ([base.md](base.md#config)). Every transaction, the batch's and the
  wallet's, has a max-fee ceiling (Settings, 2 gwei by default). Central's
  contract addresses are never used, only checked.

## Icons

Every icon and symbol in the UI, 2026-10-18, by the rule above:

| Icon or symbol | Where | Verdict | Why |
|---|---|---|---|
| Tab icons (controller, house, menu; in the menu flow, line, wallet, gear) | the phone's tab bar | keep | each has its word under or beside it |
| ✓ in the hero's ring | Home | keep | beside the title, "Predicting" |
| Three dots and the turning arc | Home's hero | keep | beside the step's words, "Scoring models · 12 of 81" |
| ! and × in the hero's ring | Home | keep | understood, and the title and the line say what |
| ✓, dots, !, × on the chips' discs | Home | keep | beside the channel's name and its words |
| A moon on an "off" chip | Home | **replace** | read as sleep or dark mode, not "not used": a plain grey disc now; the words say why ("Not staked", "No streams") |
| ✓ ! × in the activity feed | Home | keep | each line says what happened |
| A moon on an idle feed line | Home | **replace** | as above: a plain grey disc |
| Quality marks (✓ = − in circles, "−3%", "new") | Models | **replaced** | words in the mark's colour: "7% better", "Same as no change", "12% worse", "Not scored yet" |
| Destination pictograms (server, block, broadcast) | Models | **replaced** | tags: "Network", "Contract", "Relays" |
| ↑ ↓ → after a forecast | Models rows, Out | keep | after "in 24 h 3,141.01", where the way it goes from now belongs; the row's tooltip says it in words |
| → before a Nostr model's `x_pred` | Models rows | **replace** | "publishes x_pred" |
| "+eth" input chips | Models rows | **pair** on a phone | a computer's "Inputs" column header says it; a phone now says "reads +eth +gold" |
| ← before "Models" | the drill-in | keep | beside the word |
| Arrows between In, Model and Out | the drill-in | keep | between the stages' headings |
| The chart's open and filled circles | the drill-in | **paired** | labelled "12 h", "24 h" on the chart |
| The status bar's segments | Models | keep | its legend under it, in the rows' words |
| The sort icon (stacked lines) | Models | keep | beside "Sort" |
| The chips' glow | Home | keep | ambient traffic, never information: the chip's words carry the state |
| The day strip's colours | Home | keep | the summary says it in words ("11 of 14 full days"), a computer shows the legend, each day's tooltip names it |
| Sparklines | Home (a computer), Streams | keep | under "Trend", or beside the stream |
| The engine's state disc | Models | keep | beside "Resting", "Working" |
| The track record's pill | Streams' Prediction streams | keep | the Models tab's: words in the mark's colour ("12% better") |
| The chart's solid and dashed lines | a prediction stream's detail | **paired** | "Actual" and "Predicted" beside their lines |
| The small turning ring | Streams' Prediction streams | keep | beside the scan's step, "Finding prediction streams · …" |

Settings, Wallet and Streams have no other icons: their buttons and badges
are words ("Copy", "Lock", "Sent", "Connected").

## Tech (pinned)

`@duckdb/duckdb-wasm` 1.32.0 (newer `latest` builds don't write to OPFS),
`@arrow-js/core` 1.0.6, `@noble/curves` 1.9.7, `@noble/hashes` 1.8.0 (also
the payload hash), `@scure/base` 1.2.6, `@scure/bip39` 1.6.0, `js-yaml` 5.4.2
(reads a Dockerized Neuron's `wallet.yaml`/`vault.yaml`/`nostr.yaml` at
import, and earlier versions' rows at migration 7; PyYAML folds long lines),
`vite` 8.3.1, `vitest` 4.1.11, `@playwright/test`
1.63.0. Steps 3 and 4 added no dependency. Step 5 added only a dev dependency,
`ws` 8.22.0, for the test relay and the node-side scripts (the browser has
WebSocket); nostr-tools was not needed ([nostr.md](nostr.md#deviations-from-satori-lite-and-why)).
Step 6 added `viem` 2.37.0 (released 2025-09-02, as the parked design
planned): ABI encoding, multicall, transaction serialization and the RPC
client for Base; signing stays in `src/keys` (`@noble/curves`). The
installable app added none (no Workbox: the service worker is about 25 lines).
`bvar` added none (plain JS k×k solves; its seeded draws use `@noble/hashes`'
sha256, already a dependency). Home's health and the tabs added none (icons are inline SVG and CSS masks); nor did the Models tab (its chart is plain SVG).
The deploy image added none to npm; it is
`nginx:1.30.5-alpine3.24` (2026-09-23), pinned by digest in `deploy/Dockerfile`.

## Verify

- `npm test` (vitest, `--maxWorkers=2`): health (every status and reason
  from fabricated logs, the action priority, open time and missed work, the
  day codes, the chips, the feed; the activity log's sessions, heartbeat,
  wake, merges, prune and caught up); keys (satorilib parity vectors for
  words, public keys and Base addresses; the wallet encryption: round trips,
  another implementation opening it, wrong passphrases, NFC, non-Latin and
  emoji passphrases, the rule; Docker `wallet.yaml`/`vault.yaml` read for
  import incl. old wallets, no-entropy, mismatched and wrong-password files,
  Latin-1 passwords; files in the wrong slots and plain-text wallets refused;
  the record; every earlier version's stored keys carried forward, at load
  and at Unlock, also through migration 7 on DuckDB); central (the payload
  and its hash, the EIP-191 login signature against central's vector and
  viem's `verifyMessage`, register, login, the 401 retry, the one resend, timeouts and
  network errors, with a mocked fetch); neuron (storage and dedupe,
  forecasting each observation once, an interrupted poll's rows forecast
  by the next poll, the kept queue and its cap, a failed poll, a
  local failure, register and mismatch, the schedule (at once when due) and
  a failed save); engine (namaste_club's own tests ported, recovery and shrinkage,
  minimum data, gaps, a random-walk guard, and parity with namaste_club's code:
  `scripts/engine_parity.py`; the step: the same series on any grid gives the
  same model; the horizon in 1, 2 and 3 steps); bvar (every equation's
  posterior mean, σ² and prior against namaste_club's `bvar.py` to 9 decimals,
  `scripts/bvar_parity.py`; with no companions it is bar1; a leading
  companion learned; gaps; per-series transforms; the fallbacks; no
  look-ahead in the backtest; influence); evolution (the alias-seeded RNG, the first
  draw, each mutation, the margin, one proposal per poll, a leading
  companion found, neurons diverging); central's history (200, 404 held for a
  day, partial lists, 4 calls at a time, backfilled rows never predicted);
  db (migrations from steps 2–6, a change of central, the relay tables and
  their dedupe, specs, history inserts, doubles bit for bit, a poll's
  predictions in one transaction, every commit checkpointed: a database file
  keeps nothing in its WAL; `recover.js`: a WAL set aside as checkpointed or
  unreplayed, any other failure left alone, the rename retried while held); nostr (every event rebuilt byte for byte
  against satorilib's own client and nostr-sdk's signatures, Lite's value
  unwrapping on its own function's outputs, Lite's pinned relay uuid, the
  catalog, intake parsing, the relay client's REQ/EOSE/OK and reconnect backoff
  with a fake socket, the test relay over real sockets, and the whole flow
  with fake relays: read-only relays, discover paging, subscribe refusals and
  the cap, intake dedupe and echo, `_pred` seq, announce on open, reconcile,
  NIP-65, unsubscribe); Base (the keys' Base addresses against satorilib's
  `ethAddress` and viem, `signDigest` against viem's `sign`; every ABI entry
  against the D7 build output; the config overlay and its cache; the chain
  module against a fake D7: the status multicall, the transfer lock's `>=`,
  stake and unstake, simulates, sends, claims; the batch: due rules, the
  engine's step, Lite's direction, named games' 24 h, per-game simulation,
  the hash kept at send and waited for, persisted only after the receipt, the
  max-fee ceiling, the schedule, the config cache per central, the settings
  checked before either is saved; claims' and sends' branches); the CSP; ui
  text; `serial()`; the service worker's routing (`src/pwa/sw.test.js`); the
  build variables: unset keeps each default, set replaces it, a bad one is
  refused (`src/config.test.js`). Since the review's last fixes
  (2026-10-19): the build's CSP and the dev server's (`src/csp.test.js`);
  central's contract addresses checked never used, a pinned RPC, the max fee
  on every write and quote, CCIP-read off (`src/chain/*.test.js`,
  `src/neuron/base.test.js`); address changes noted (`health.test.js`,
  `activity.test.js`); the reward address (`src/neuron/reward.test.js`, `src/central/central.test.js`,
  `health.test.js`, `work.test.js`; e2e `reward.spec.js` against the stub central); forged catalog events dropped, the relay window and
  its prune (`nostr.test.js`, `db.test.js`); the queued tab lock
  (`neuron.test.js`); a newer additive schema opened, a damaged file set
  aside (`db.test.js`, `recover.test.js`); the import's cap and its YAML
  errors, secrets wiped (`twokeys.test.js`, `wipe.test.js`); the version
  (`config.test.js`, `central.test.js`); every `window.satori` method in
  /llms.txt and its Safety section (`src/llms.test.js`). In the e2e: the
  max fee and the RPC's notice (`base.spec.js`), the track record
  (`records.test.js`, `nostr.test.js`, `db.test.js`; e2e `records.spec.js`:
  [track-record.md](track-record.md#verify)), the central's notice, the
  version, the second tab taking over, the backup's words blanked
  (`app.spec.js`), a damaged database set aside (`wal.spec.js`), HSTS, the
  pinned RPC and the version on the image (`deploy.spec.js`).
- The Models tab ([models.md](models.md#verify)): `npm test` (quality,
  the list, the status, the drill-in recomputed, a two-output model drawn,
  influence, `explainForecast`, `explainModel`, migration 11) and
  `e2e/models.spec.js` (central, Base and Network models, filter, sort, a
  drill-in and back, a deep link, the phone's width; `SHOTS=1` writes
  `docs/screenshots/models-*.png`).
- `npm run e2e` (Playwright, system Chrome, one worker), central2 routed to a
  stub and prod blocked: create → register (headers checked) → the first
  poll at once, after register, no Poll now: two streams stored, forecast and sent after an
  alias-signed EIP-191 login (the stub verifies EIP-191 only; payload
  strings and hashes checked) → second tab
  refused → reload keeps the schedule and registers again → Unlock (wrong
  passphrase refused; created with a non-Latin passphrase) → backup words,
  private keys and the Nostr key, and the stored record → Lock, polls go on; the
  agent API (dedupe, a failed batch kept and resent, a 401 retried, the
  central URL setting: another central drops the queue and the list, which
  refill from it, after a poll still running with the old one; one Unlock at a
  time; the engine: naive until 8 back-to-back buckets of 12 h, then bar1 with
  node's numbers; a central with history: bvar for every stream on the first
  Poll now, with node's specs and numbers); Dockerized Neuron import with a wallet mismatch and Settings,
  and with a Docker password under 8 characters (a new passphrase asked);
  earlier versions' profiles on OPFS (`e2e/migrate.spec.js`: the alias and
  Nostr key at load, the wallet at Unlock, the finish screen, the step-1 row)
  (https only, an unreachable central shown); restore from words; two setups
  at once (one wins) leaving other `meta` rows alone. Also an OPFS persistence
  smoke under the CSP, and reloads and crashes with no checkpoint
  (`e2e/wal.spec.js`): a fresh profile reloaded on Setup and while it loads,
  no WAL left, setup's keys in the database file itself as setup returns and
  after Chrome is killed, and the WALs older versions left (the owner's,
  which DuckDB can't replay: Setup with the notice; a set-up neuron's, set
  aside silently; keys checkpointed under an unreplayable WAL: kept). Nostr (`e2e/nostr.spec.js`) against two test relays,
  7782 as central's (read only) and 7781 as the user's: a provider's stream
  discovered and subscribed in the UI, its stored and live observations
  forecast and published as `_pred` (read back from 7781 and checked, with
  the 34600 and the 34602), nothing on 7782 from the app, kept over a reload,
  unsubscribed with the tombstone; Dockerized Neuron import with `nostr.yaml`; an https
  page, where a `ws://` relay is blocked and not counted and satorian is reached at
  its wss stand-in (routed to 7782). Satorian, the real stand-in
  (`wss://relay.satorinet.io`) and the dev relay are routed to nothing in every test. Base
  (`e2e/base.spec.js`) against a fake D6 behind `/rpc` and a stub central
  serving a merkle proof: Unlock → Stake, the alias's batch on its own,
  claims and the next batch a round later, Unstake, SATORI not sendable
  through round N, sends, Lock, the low-ETH warning only once staked,
  `stake()` and `unstake()` from the agent API; the Base
  settings (nothing half-saved); the other specs keep off `/rpc`. Every spec
  uses the one stub central (`e2e/stub.js`) and opens and reloads the app
  through `e2e/load.js`, which waits up to 60 s for `<body data-screen>` to
  leave `loading` (DuckDB-WASM takes seconds to start on a busy box). The dev
  server registers no service worker and removes one left on its origin.
- Home (`e2e/home.spec.js`, the stub central and a fake chain): ok after a
  month of seeded activity and a poll; warn when the wallet gets SATORI
  (Stake from the card, the inline Unlock, a wrong passphrase refused, the
  batch on its own, ok again); idle after two days closed (catching up, caught
  up, ok at the next cycle); bad after two refused batches, then a refused
  login whose card opens Settings; starting on a fresh neuron (the days
  before it outlined, "Before this app", not closed). At 390 × 844
  and 360 × 740 the answer is on the first screen, every tap target is 44 px
  and no tab scrolls sideways. `SHOTS=1` writes the screenshots below.
- `npm run e2e:pwa` (a build on `vite preview` :5181, `e2e/pwa.spec.js`, each
  test in its own Chrome profile with every host but localhost unresolvable):
  the manifest valid and installable, the worker served with the CSP and
  controlling the page, Install and the storage line, `persist()` after
  setup; offline the page, DuckDB and the stored neuron load while central and
  Base fail and say so; a new version waits for Update; an app window and a
  tab run one neuron ([pwa.md](pwa.md#verify)).
- `npm run e2e:deploy` (the deploy image at `DEPLOY_URL`, :8090 by default;
  `e2e/deploy.spec.js`): the CSP and nosniff on every kind of response, the
  cache headers and types, the SPA fallback and the gzipped wasm; then in a
  fresh profile the page under the CSP, DuckDB, the worker, the manifest, and
  a neuron on the deployment's central and relays ([deploy.md](deploy.md#verify)).
- Live, in a fresh browser profile on the dev server: central2 (writes
  allowed) for register, Poll now and the batch; prod only for read-only GETs.
  Nostr: satorian read only (its full catalog discovered: 924 live of 1,061
  announcements; only REQ and CLOSE sent to it), the dev relay on 7778 for
  every write. Base: the dev app against an anvil fork of Base Sepolia
  (stake, the batch on its own, claims including `hub.claim`, unstake, the
  lock, a send: [base.md](base.md#live-in-the-running-app-2026-10-15)); and
  `src/chain/fork.test.js` runs the chain module against the real D6
  contracts on a fork (`BASE_FORK`).
- Load time on the dev server (headless Chrome, the dev box, 2026-10-15):
  the page paints "Opening…" at 0.3 s (`index.html`); a fresh profile reaches
  Setup in ~4.5 s and a reload reaches Home in ~3.5 s (5.6–6.0 s and 4.7–4.9 s
  before apache-arrow was pre-bundled and DuckDB's worker sent raw). What
  remains: ~0.75 s of modules, ~1.8 s for DuckDB to fetch and compile its
  34 MB wasm (a cacheable wasm did not help), ~0.4 s to open the OPFS file,
  ~0.15 s of migrations, ~0.3 s to start the neuron.
- Parity vectors come from satorilib, the Docker image and namaste_club
  (`test/fixtures/README.md`; `scripts/`).
- `node scripts/backtest.mjs`: the engine against persistence at 24 h on real
  history, read only, and 5 simulated neurons running bvar with evolution on
  21 crypto pairs at once ([engine.md](engine.md#measured)): all three tie on
  400 days.
- Dev app: `npm run dev` → http://localhost:5180; for Base, `node scripts/fork.mjs start`
  (an anvil fork on 8545, which the dev server proxies as `/rpc`). The
  installable app: `npm run build && npm run preview` → http://localhost:5181.
  The deploy image: `./scripts/deploy-image.sh`, then
  `docker run --rm -p 8090:80 satori-neuron:latest` → http://localhost:8090.
