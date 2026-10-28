# Intent

An alternative to the Docker neuron (`../neuron`, Satori Lite): the Satori
neuron as an app that lives entirely in the browser. It runs client-side and
needs no server of our own.

- The Docker neuron stays. This is a second way to run a neuron, not a replacement.
- The owner's preferred toolkit for client-side apps is ArrowJS and DuckDB-WASM.
- The end goal is full neuron behaviour in the browser ("it'll do it all").
- It is named `satori` (lowercase) inside `Satori/` because the earlier names are
  taken and earlier codebases are not to be changed.

## Build it in steps (owner, 2026-10-15)

Lay an essentialist foundation first, then evolve it quickly.

**Step 1 — MVP (minimal viable prototype):** a client-side app with:
- **key management**, the most important part;
- a basic UI;
- basic data management in a database (DuckDB-WASM is preferred; IndexedDB is
  acceptable), which must work really well;
- the core flow: get data from somewhere → pass it to the engine → build a model
  → extract a prediction → publish the prediction;
- a linear model as the engine, kept absolutely simple.

**Later:** Nostr, Base, central, a better engine, and so on. The full design for
these is already researched and parked in [../plans/](../plans/README.md).

## The owner's direction (2026-10-15)

Set by the owner; quoted where these are the owner's own words.

- **Two keys, on purpose.** The **alias** is stored unencrypted so the
  neuron signs on its own (central's login, predictions, Nostr, the Base
  batch). The **wallet** is encrypted with the passphrase and holds the funds.
  The Docker neuron keeps them in `wallet.yaml` and `vault.yaml`; so does
  this app.
- **Follow what Satori already made, simplified.** Satori Lite (the Docker
  neuron), satorilib and central are the patterns: their behaviour, cadence,
  protocols and payloads, simplified, not new flows. Any deviation is written
  down with its reason in the design docs. For the finishing pass: "Simplify
  refactor essentialism but follow what we already made".
- **Migrate in, never back (owner, 2026-10-16).** "This is a new repo. This
  is a new day." Do things the most correct way. Import what users bring from
  the Dockerized Neuron and translate it into this app's own way. Don't keep
  old formats, limits or exports only so things can move back. Satori Lite is
  the reference for how the network behaves (protocols central and peers
  rely on), not a compatibility target for local formats.
- **The order of steps:** keys → central's data flow → an engine inspired by
  `namaste_club` → Nostr → Base last, integrating what the dapp
  (`contract/satori-ui`) does → a finishing pass.
- **Agents are a core purpose.** It is client-side so AI agents can drive it.
  `/llms.txt` says what the app is and how an agent drives it, what's
  possible, where the code lives (the repository and a file map), and that
  pull requests to github.com/lastmeta/Satori are welcome; it and
  `window.satori` stay current with every step.
- **MIT** licensed.
- **A reward address (owner, 2026-10-19).** "We need to be able to specify a
  reward address, in the settings or in the wallet." It is where the Satori
  Service sends the neuron's rewards instead of the wallet, such as a pool: a
  Base (0x) address. With none set, rewards go to the wallet. It has nothing
  to do with staking.
- **The neuron is for automatic play.** It predicts on its own, off-chain
  through central and on-chain through the alias's daily Base batch.
  Manual on-chain play belongs to a separate slim app, **Satori Daily**. A
  wallet staked with the neuron can't also play by hand in the same round.
- **The engine:** every neuron builds models that are unique for a good
  reason, in their algorithm, priors and, above all, data. See
  [engine.md](engine.md).
- **Wallet and alias (owner, 2026-10-23).** "The Satori app", not "neuron".
  The **wallet** is the person's identity: the key only they hold, in the app
  (encrypted) or in an outside wallet they connect (MetaMask or another). Its
  **alias** is the app's own signing key, made by the app, unencrypted,
  replaceable, and not something people need to think about. The wallet
  signs a link to its alias for the Satori Service. One app holds several
  wallets, one active at a time; the models and the engine do not change. See
  [../design/wallets.md](../design/wallets.md).
- **The network (owner, 2026-10-20):** the Satori Service is the relays,
  where anyone publishes and anyone subscribes, predictions included; next,
  a market of data streams. See [network.md](network.md).
