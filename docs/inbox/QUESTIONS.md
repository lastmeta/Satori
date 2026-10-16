# Questions for the owner

Open questions the code can't settle on its own. Each says what the app does
today, so nothing waits on an answer.

1. **Base direction: keep Lite's rule?** UP if the forecast > the latest
   value, else DOWN, so a forecast equal to the latest (`naive`, or `bar1` with weight or
   φ 0) always votes DOWN, and today every browser neuron is `naive` on D6's
   one stream. A seeded slope rule, with a seeded coin flip on a flat series,
   is parked as an option ([../plans/engine.md](../plans/engine.md)). Switch,
   or keep parity with Lite?
2. **The token hook: the rewards upgrade.** A delegated vault that receives
   SATORI in a transaction sent with a bare gas estimate can never undelegate
   (Panic 0x11), and anyone can cause it with 1 wei. A rewards UUPS upgrade
   that subtracts the delegator's booked balance fixes it now (tested on the
   fork); the root fix waits for a redeploy. Ship the upgrade?
   ([../issues/token-hook-gas-estimate.md](../issues/token-hook-gas-estimate.md))
3. **Prod central's Base and merkle routes.** `network.satorinet.io` answers
   404 for `/api/v1/base/config` and `/api/v1/merkle/proof/…`; central2 serves
   both. A build defaults to prod, so its merkle claim says the route is
   missing and the Base addresses are the bundled ones. Deploy those routers
   to prod? ([../issues/central-prod-missing-base-routes.md](../issues/central-prod-missing-base-routes.md))
4. **A wss relay.** Central lists only `ws://satorian.satorinet.io:7777`, which
   an https page can't open, so a deployed app has no Nostr until a `wss://`
   relay is listed (TLS in front of satorian, and central listing it). Who
   sets it up, and where? ([../issues/relays-not-wss.md](../issues/relays-not-wss.md))
5. **Per-node diversity.** Docker redraws hyperparameters on every fit, so its
   nodes differ; every browser neuron runs the same `bar1` on the same data
   and sends the same numbers. An RNG seeded from the identity could draw λ or
   a small posterior perturbation per node, at a bounded and measured accuracy
   cost ([../plans/engine.md](../plans/engine.md)). Wanted?
