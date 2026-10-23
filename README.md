# satori

The Satori neuron as a client-side browser app: no server of our own, built to
be driven by people and by AI agents alike.

## Quick start

Node `^20.19` or `>=22.12` (Vite 8's range), then:

```sh
npm install
npm run dev                          # the app on http://localhost:5180
node scripts/test-relay.mjs 7778     # a local Nostr relay to publish to; without it the Nostr card shows ws://localhost:7778 "Disconnected (…); retrying"
node scripts/fork.mjs start          # a local fork of Base Sepolia (needs Foundry's anvil); without it the Base card says "The chain did not answer"
```

Open the app, **Create a new neuron**, and it runs: it registers with the
Satori Network, polls it, forecasts, sends its predictions back. AI agents: read
[/llms.txt](public/llms.txt); the page exposes `window.satori`.

**Words.** What people see, and what the code calls it
([intent](docs/intent/ui.md)): the **Satori Network** ("Network") is central,
free to submit to; the **Satori contract** ("Contract") is the Base
contracts, which cost gas; the **Satori relays** ("Relays") are the Nostr
relays. Base is the chain's own name (ETH on Base, Base addresses). This
README, the design docs and the code keep the code's names.

## What it does

Satori's two keys (alias and wallet; a Dockerized Neuron's import), a DuckDB-WASM
database in the browser, central's data flow as the Docker neuron (Satori
Lite) runs it, Lite's Nostr flow (subscribe to streams, publish
`<stream>_pred`), and Lite's Base flow (the wallet stakes with this neuron,
whose alias sends a batch of up/down predictions every UTC round on its
own):

```
register ─▶ poll central (at once when due, then every 11 h) ─▶ store ─▶ forecast what is not predicted yet ─▶ submit the batch
relays ─▶ subscribed stream's observation (34601) ─▶ store ─▶ forecast two cadences ahead (t2) ─▶ publish <stream>_pred (34601)
Base: Unlock ─▶ stake ─▶ each round the alias: registry streams ─▶ forecast ─▶ UP/DOWN ─▶ one batch tx; claims, sends
```

The **alias** is stored unencrypted, so the neuron runs and signs from page
load; the **wallet** holds the funds, encrypted with your passphrase. **Unlock**
opens the wallet (needed for backup and Base's stake, claims and sends);
**Lock** wipes it from memory. The keys are stored in this app's own format
(the wallet: PBKDF2-SHA256 and AES-256-GCM, any Unicode passphrase of 8 or
more); each key's address is its Base address. Setup can also restore from
words or import a Docker neuron's `wallet.yaml`, `vault.yaml` and
`nostr.yaml`, translated into that format ([keys](docs/design/keys.md)). Only one tab
runs the neuron; others say so. The engine (`bar1`, after the owner's
`namaste_club`) is a Bayesian AR(1) on 12 h returns, faded toward the last
value as far as its own backtest says it trails it ([engine](docs/design/engine.md)).

**Home** answers one question at a glance: is the neuron predicting every
day on its own, and is anything broken? One status (predicting, was asleep,
needs you, problem), at most one thing to do, the last 14 days, and the
Network, Contract and Relays connections (the Satori Network, free; the
Satori contract, which uses gas; the Satori relays); on a computer it is a dashboard with
the streams, the wallet and the activity ([health](docs/design/health.md)).
Streams, Wallet and Settings hold the rest.

<img src="docs/screenshots/home-ok-phone-light.png" alt="Home on a phone: predicting" width="320"> <img src="docs/screenshots/home-warn-phone-dark.png" alt="Home on a phone, dark: Base needs one step" width="320">

![Home on a computer](docs/screenshots/home-ok-desktop-light.png)

![The Nostr card, subscribed to the demo stream](docs/screenshots/nostr.png)

![The Base card on the local fork: staked, the last batch](docs/screenshots/base.png)

## The dev server

The dev server talks to the dev central, `https://central2.satorinet.io`; a
build (`npm run build`) defaults to `https://network.satorinet.io`, or to
`VITE_CENTRAL_URL` when set ([Deploy](#deploy)). Change it under **Settings**.

**Nostr.** On the dev server central's relay (`ws://satorian.satorinet.io:7777`,
production) is read only: the app reads the real catalog and streams and
never writes there; it writes to the test relay on 7778. For a stream to
follow there:

```sh
node scripts/provider.mjs ws://localhost:7778 demo-walk 60   # a demo stream, a value a minute
```

Open **Streams on the relays**, search `demo-walk`, **Subscribe**: the Satori
relays card shows the latest observation and our `_pred`. Tick **Publish to
the Satori Network's relays** under Settings to write to satorian too (a build does by default).
An https page can't open `ws://`: there the app reaches satorian through its wss stand-in,
`wss://relay.satorinet.io`, as central's relay ([docs/design/nostr.md](docs/design/nostr.md#relays-and-the-read-only-flag)).

**Base.** The dev server's RPC is `/rpc`, proxied to the anvil fork on
127.0.0.1:8545 (the real D7 addresses; by default a dev checkout sends
nothing to a public chain). Fund the neuron's Base addresses (in the Keys
card), then Unlock and **Stake with this neuron**:

```sh
node scripts/fork.mjs fund 0xALIAS                  # gas for the daily batch
node scripts/fork.mjs fund 0xWALLET --satori 100        # gas, and SATORI: the prediction power
node scripts/fork.mjs --help                           # airdrop, merkle, advance, predict, stream, stop
```

A build uses the RPC it pins (`VITE_BASE_RPC`; the deployment's
`https://sepolia.base.org`), then publicnode, or, pinning none, central's;
any https RPC can be set under **Settings**, and so can the max fee every
transaction is held to (2 gwei by default).

## The installed app (PWA)

A build can be installed as an app: it keeps your keys (installed apps get
persistent storage; Safari otherwise deletes a site's data after 7 days
of use without a visit), runs in its own window, and starts offline from its cache.
It does not run the neuron while closed. The dev server has no service
worker, so try it on a build:

```sh
npm run build && npm run preview     # the build on http://localhost:5181
```

Open http://localhost:5181 in Chrome or Edge and click **Install Satori**
(on Setup, or on Home under the keys) or the install icon in the address bar;
the app opens in its own window. Safari: File › Add to Dock (on iOS, Share ›
Add to Home Screen); its app has its own storage, so set it up there. Home
shows **Storage: kept** once the browser keeps the data. A new build shows
**Update ready, reload** in the header. A build talks to the production
central (`network.satorinet.io`) and writes to central's relays (change the
central under Settings), and the data on :5181 is not the dev server's
(:5180 is another origin). Details: [docs/design/pwa.md](docs/design/pwa.md).

![Home on a build: the storage line and Install Satori](docs/screenshots/pwa.png)

## Deploy

A build bakes in the defaults that Settings starts from. Each of these
variables, when set and not empty, replaces one; a bad value stops the build
([docs/design/deploy.md](docs/design/deploy.md#build-variables)):

| Variable | A build's default | Sets |
|---|---|---|
| `VITE_CENTRAL_URL` | `https://network.satorinet.io` | central (https) |
| `VITE_NOSTR_RELAYS` | none | the user's relays, a comma list (`wss://…`) |
| `VITE_NOSTR_WSS` | `ws://satorian.satorinet.io:7777=wss://relay.satorinet.io` | relays' wss stand-ins, a comma list of `ws://…=wss://…` pairs: where a page can't open the `ws://` relay, it opens the `wss://` one as that relay |
| `VITE_NOSTR_CENTRAL_WRITE` | `true` | whether central's relays are written to |
| `VITE_BASE_RPC` | central's RPC, then publicnode | the Base RPC (https, then publicnode; or a path on the site); central never overrides it |

The app is served at https://app.satorinet.io (https://neuron.satorinet.io and
https://satori.satorinet.io redirect there): one static image, `satori-neuron` (nginx), behind
the nginx-proxy on Satori's central server, which terminates TLS. Its build
uses `deploy/build.env` (the dev central, `wss://nostr.satorinet.io` and
`https://sepolia.base.org` for now). The image sends the CSP, nosniff and
HSTS on every response:

```sh
./scripts/deploy-image.sh                  # npm ci if needed, build, satori-neuron:<git sha> and :latest, checked
docker run --rm -p 8090:80 satori-neuron:latest
npm run e2e:deploy                         # in another shell: headers, CSP, DuckDB, the worker, the manifest, the defaults
```

## Test

```sh
npm test           # vitest (2 workers): parity with satorilib and namaste_club; the keys and every earlier version's stored keys; central, the neuron, the engine, the db, Nostr, Base against a fake D6, ui text
npm run e2e        # playwright, system Chrome: the app against a stub central, two test relays (7781/7782) and a fake chain behind /rpc
npm run e2e:pwa    # builds, then the installed app on vite preview :5181: manifest, service worker, offline, Update, one neuron
npm run e2e:deploy # the deploy image on :8090 (DEPLOY_URL): every response's headers, then the app in a fresh profile
node scripts/fork.mjs start --port 8546 && BASE_FORK=http://127.0.0.1:8546 npx vitest run src/chain/fork.test.js   # the chain module against the real contracts
node scripts/backtest.mjs   # the engine vs persistence at 24 h on real history (read only)
```

Run the suites one after the other. Playwright starts Chrome without its
sandbox (its default), so the e2e also runs as root or in a container; Chrome
launched by hand there needs `--no-sandbox`.

## Docs

- Intent: [docs/intent/INTENT.md](docs/intent/INTENT.md)
- Design, the source of truth, with the file map:
  [docs/design/OVERVIEW.md](docs/design/OVERVIEW.md) (keys, central, engine,
  Nostr, Base, storage, the installed app, the deployment)
- For agents, and the `window.satori` reference: [public/llms.txt](public/llms.txt)
  (its Safety section first); what changed for them: [public/llms-changelog.txt](public/llms-changelog.txt)
- Roadmap and what is left: [docs/plans/README.md](docs/plans/README.md);
  issues outside this repo: [docs/issues/](docs/issues/README.md); questions
  for the owner: [docs/inbox/QUESTIONS.md](docs/inbox/QUESTIONS.md)

MIT licensed. Pull requests are welcome at https://github.com/lastmeta/Satori.
