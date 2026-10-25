# The Satori app (browser neuron)

Read `docs/BRIEF.md` first: where everything is, how the owner wants work done,
what's live, what's next. Satori-wide rules: `/code/Satori/CLAUDE.md`.

## Owner rulings
- **Stair-step MVPs.** The smallest working slice per step; propose the next
  step rather than bundling several. Research is parked in `docs/future/`; the
  half-built full v1 is on branch `draft/v1-full`.
- **Scope.** For the MVP the app predicts everything it sees, with no user
  controls. Long-term intent goes into `docs/intent/`, never into the next build
  step. After in-flight work finishes, propose a whole-setup review, not features.
- **Deploy without asking.** Finished, reviewed, tested work is deployed to
  app.satorinet.io and smoke-tested live (BRIEF: "Deploying app.satorinet.io"),
  then reported as done. **Deploy first, then test** (2026-10-25): once a
  change works in the dev app, deploy it right away and run the long test
  suites afterwards; fix and redeploy if they fail. The owner doesn't wait on
  suites.
- **Autonomous only.** The app plays off-chain (predictions to the Satori
  Network) and on-chain (the alias sends a daily batch once the wallet stakes its
  prediction power) automatically. No manual game UI: hand play is a separate
  slim app, "Satori Daily". A staked wallet can't play by hand
  (`SatoriEngine.sol` reverts `Delegated`); the Base card says so and links there.
- **Migrate in, never back.** Import and translate Dockerized Neuron (Lite) data;
  never keep legacy formats or limits so things can go back.
- **Waits aren't problems** (2026-10-25). When something the user can't fix
  just has to wait (the contract won't take a prediction yet, a retry is
  coming), say it calmly with what to do: "Unable to predict right now. Come
  back in about 3 hours." Never a warning colour or error wording. Orange/red
  are for things that are actually wrong.
- **No layout snaps** (2026-10-25). A box whose content changes with state
  (a status line appears or goes) must not jump the page under it. First
  choice: give it one static height that fits every state. If that can't
  work, animate between states (height eased, content faded), never an
  instant switch. A fixed height must not leave visible blank space in
  the short states; Home's hero couldn't, so it animates (main.js `smoothHero`).
- Before engine work read `docs/intent/engine.md`; before relay, Nostr or market
  work read `docs/intent/network.md` and `docs/plans/market.md`. Market
  contracts are built from this session in the contract repo. Hold the relay
  flaws found 2026-10-20 until the network design settles.
