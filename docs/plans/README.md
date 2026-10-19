# Roadmap

The steps, as the owner set them (2026-10-15: [../intent/INTENT.md](../intent/INTENT.md)),
and what is left. What is built is in [../design/](../design/OVERVIEW.md); this
folder keeps what is left of each part, researched against Satori Lite
(`../neuron`), satorilib, central and the contracts, with file:line evidence:
[runtime](runtime.md), [Nostr transport](transport.md), [chain](chain.md),
[engine](engine.md). Blockers outside this repo: [../issues/](../issues/README.md).
Questions for the owner: [../inbox/QUESTIONS.md](../inbox/QUESTIONS.md).

## Steps

1. ✅ **MVP**: keys, db, linear engine, local publish, basic UI.
2. ✅ **Two keys**: identity (unencrypted) and vault (passphrase); a
   Dockerized Neuron's files imported ([../design/keys.md](../design/keys.md)).
   Since step 10 in this app's own format, with no export back.
3. ✅ **Central data flow**: register, poll, store, forecast, predictions batch, as Lite does it ([../design/central.md](../design/central.md)).
4. ✅ **Engine**, inspired by `../namaste_club`: `bar1`, a Bayesian AR(1) on 12 h returns faded toward persistence; then `bvar`, each central stream's own Bayesian VAR(1) with 1–3 companion streams, drawn from the identity and evolved after each poll, with history from central ([../design/engine.md](../design/engine.md)); left for later: [engine.md](engine.md).
5. ✅ **Nostr**: the Nostr key, discover, subscribe, intake, publish `_pred`, as Lite does it ([../design/nostr.md](../design/nostr.md)); left for later: [transport.md](transport.md). A deployed app needs a wss relay ([issue](../issues/relays-not-wss.md)).
6. ✅ **Base**: stake with this neuron, the identity's daily batch, claims (`hub.claim`, merkle, airdrop), sends, as Lite does it and the dapp in `../contract/satori-ui` goes further ([../design/base.md](../design/base.md)); left for later: [chain.md](chain.md). A local fork for the dev server: `scripts/fork.mjs`.
7. ✅ **Finishing pass**: simpler code that follows what Lite and satorilib
   already do (one schedule, one serial line, one stub central, shared
   constants, no dead code), a Home grouped by key, and agents first
   (`/llms.txt`, `<body data-screen>`, `data-test` on every action).
8. ✅ **Installable app (PWA)**: the manifest, a service worker in builds
   (the page and DuckDB's wasm precached; offline start), Install Satori,
   Update ready, and persistent storage for the keys, shown on Home
   ([../design/pwa.md](../design/pwa.md)). It does not run the neuron while
   closed.
9. ✅ **Deploy**: one static image (nginx serving the build) behind central's
   nginx-proxy at https://neuron.satorinet.io (satori.satorinet.io redirects there);
   Settings' defaults set at build time (`VITE_*`), the CSP from `csp.js` on
   every response ([../design/deploy.md](../design/deploy.md)).
10. ✅ **Migrate in, never back** (owner, 2026-10-16): the keys in one record
   of this app's own (the vault sealed with PBKDF2-SHA256 and AES-256-GCM,
   any Unicode passphrase of 8 or more), a Dockerized Neuron's files
   translated on import, every earlier profile carried forward (the vault at
   its next Unlock), Backup as words, private keys and the Nostr key, no
   Docker export; Base addresses only; central's payload and Nostr content as
   plain JS text, after an audit of what central, satorilib and Lite parse
   ([../design/keys.md](../design/keys.md),
   [../design/central.md](../design/central.md#the-protocol-audit),
   [../design/nostr.md](../design/nostr.md#the-protocol-audit)). Then
   central's login as EIP-191, as central and Lite now sign it; register's
   vault check on the Base address central pays (`vault_base_address`,
   central d8a2085), so no Evrmore code is left
   ([../design/central.md](../design/central.md#the-vault-in-registers-answer)).
11. ✅ **Home: is it predicting, is anything broken?** (owner, 2026-10-16:
   [../intent/ui.md](../intent/ui.md), the approved
   [mockup](../design/home-mockup.html)): an activity log, one health status
   with at most one action card, the day strip, the Central/Base/Network
   chips; four tabs, phone first, a dashboard on a computer; the inline
   Unlock; `window.satori.health()` and `go()`
   ([../design/health.md](../design/health.md)).
12. ✅ **Models tab** (owner, 2026-10-18: [../intent/ui.md](../intent/ui.md)):
   the engine's status (working or resting, the models by kind, when they
   trained and run next, how they do against no change), every model named
   for the stream it predicts (central's, the Base batch's, the Nostr
   `_pred`s), and a model's drill-in: In (each input's share of its
   forecast), the Model, Out (a list of outputs, each with its chart and
   where it went); `window.satori.models()` and `model(id)`
   ([../design/models.md](../design/models.md)). Then the same day: a
   training pass, so the neuron never rests with a model unscored; Sort as
   a menu; the tab in plain words; the words people see (the Satori
   Network, the Satori contract, the Satori relays); icons only where they
   are understood. ✅ **Retrain**: a model's drill-in asks the neuron to keep
   training it until one beats no change on recent data it never chose on,
   then stop ([../design/models.md](../design/models.md#retrain)).
13. **Runtime hardening**: ✅ the catch-up pass after the device sleeps,
   and ✅ failures retried in minutes (2026-10-19,
   [runtime.md](runtime.md#catch-up-pass), [../design/central.md](../design/central.md#errors));
   left: the keys in a worker ([runtime.md](runtime.md)).
14. **Later**, in rough order of value per effort: the Models tab showing
   the real-world score (central's scoring of what was sent) next to the
   backtest, once central serves a neuron's scores
   ([models.md](../design/models.md#quality-against-no-change)); bounties (the predictor's side first); the gasless relay (needs a
   ruling, [issue](../issues/relayer-predict-fee.md)); paid streams (their
   payment on Base, to design); own data sources. Also:
   importing a Docker neuron's keys is a move (both would predict for one
   identity; the chain refuses a second batch per round), so Import could say
   to stop the Docker neuron.

## Noticed while building

### Fixable (each with when it bites)

- **A forgotten vault passphrase.** When the user forgets it, the neuron keeps
  running on the identity, but the vault comes back only by restoring its 24
  words, and Setup is the only path: Home has no "replace the vault". Fix: a
  restore-the-vault flow on Home.
- **Keys on the main thread.** When a script runs in the page (an XSS, a
  malicious extension), it can read the identity, the Nostr key and an
  unlocked vault. Fix: the keys and signing in a worker (step 13).
- **Words that open in a standard wallet.** The 24 words are satorilib's
  scheme (the secret as BIP39 entropy), so MetaMask derives another account
  from them; Backup shows the private key for that. Whether new neurons use
  BIP32 paths is an owner decision ([../inbox/QUESTIONS.md](../inbox/QUESTIONS.md)).
- **A new default central keeps the old central's data.** When a build
  changes its default central (the deployment's planned move from central2 to
  prod), a browser that never saved one follows it but keeps central2's
  streams, specs and pending predictions, and its next submission sends
  central2's uuids to prod. Only Settings resets them. Fix: remember the
  central the data is from and reset at start when it differs
  ([../design/deploy.md](../design/deploy.md#moving-to-the-production-central)).
- **The token's hook starves on an estimated gas limit.** When a staked
  vault receives SATORI (any claim, any transfer to it) in a transaction sent
  with `eth_estimateGas`'s limit, the token's try/catch hook fails silently
  and the vault can never unstake (Panic 0x11); anyone can do it to any
  staked vault with 1 wei. The app pads its own writes by 500,000 gas,
  which protects only those. Fixed in the contracts (`humble` 86e2bdb3),
  live once D7 deploys; until then the app offers staking as advice with the
  risk said and detects a stake out of sync
  ([issue](../issues/token-hook-gas-estimate.md)).
- ~~Every browser neuron votes DOWN on Base for now.~~ Resolved 2026-10-19:
  a tie (a forecast equal to the latest value) follows the stream's last
  move, and only a flat history is DOWN
  ([../design/base.md](../design/base.md#the-daily-batch-the-identity-on-its-own)).
  The seeded slope rule stays parked ([engine.md](engine.md)).
- **`StaleValue` every other round.** When a daily stream is written later in
  hour 0 than the 00:01 batch, the contract (which compares clock hours)
  refuses the game every other round; the batch still goes at the first check
  of the round ([../design/base.md](../design/base.md#when-in-the-round)).

### Inherent (as in Lite, or the browser's)

- Central's batch holds only each stream's latest observation and the neuron
  polls every 11 h, so without central's history (`/observations/history`,
  404 on central2 until it is deployed) local history grows by about two
  points per stream a day (Lite has the same limit). The engine needs an
  observation every 12 h (6 lag pairs of back-to-back 12 h buckets): with
  11 h polls a stream gets `bar1` after about 4 days and `bvar` a little
  later. A daily stream (`crypto_fear_greed`) or a tab open only part of the
  day (one poll a day) stays `naive`; gaps are not bridged.
- Browsers throttle timers in background tabs: a poll can run late, never
  early. A tab closed past its poll time polls 5–30 min after the next load.
- A relay keeps one of two replaceable events with the same `created_at`
  (NIP-01): two `_pred` of one stream in one second lose one, as in Lite
  ([../design/nostr.md](../design/nostr.md#inherent-as-in-lite)).
- A vault's staking share of the identity's wins shows on the lens only
  after its loyalty builds (on the fork: 9 rounds after staking, with the
  default stream moving), so the first rounds' Claim finds 0 on-chain rewards.
- On a fork moved ahead in time the Base card's times are the chain's (days
  ahead of the wall clock), while the next check is local time.
