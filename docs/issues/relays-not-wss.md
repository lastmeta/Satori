# No relay reachable from an HTTPS page

**Status:** open; worked around for this repo's deployment · **Blocks:** central's relays in a deployed (https) app · **Fix in:** relay hosting and central

Nostr is built (step 5, [../design/nostr.md](../design/nostr.md)) and
works from the dev server, which is plain `http://localhost:5180`, against
`ws://` relays. A deployed app is served over https and can't reach today's
only listed relay.

## Precondition

The app is served over HTTPS (any real deployment). Browsers block `ws://`
from an HTTPS page as mixed content, before the CSP is consulted; only
`ws://localhost` and `ws://127.0.0.1` are exempt. The app's CSP allows
`connect-src … wss: ws:` (`csp.js`); `ws:` is only of use to the http dev
page. On an https page the app shows such a relay as **blocked** and does not
try it.

## Finding (verified)

- Central's relay list, probed 2026-10-15 (prod and central2), holds one relay:
  `ws://satorian.satorinet.io:7777`. Port 7777 has no TLS and
  `https://satorian.satorinet.io:443` did not answer (2026-10-14).
- How central builds that list: relays are discovered from NIP-65 (kind 10002)
  events (`central/relay_watcher/nip65.py:169-211`) into `discovered_relays`.
  `/peer/relays` returns only those with `relay_daily_scores` traffic
  (`messages_received > 0`) in the last 7 days, falling back to all discovered
  relays only when no such rows exist (`central/src/api/v1/endpoints/peer.py:125-150`).
- A Docker neuron's NIP-65 lists the relays it is **connected to**
  (`neuron/neuron-lite/start.py:370-383`), and it connects only to relays
  central lists or its own DB entries. One neuron already lists a wss relay
  in its 10002 (`wss://satori-home.net-hub.de`, seen on satorian 2026-10-15),
  but central does not list it.

So a new wss URL is not listed just because someone announces it: it also needs
traffic, and neurons won't connect to it until it is listed.

## Fix

1. Put TLS in front of satorian (Caddy or nginx → `wss://satorian.satorinet.io`).
2. Get it listed and scored, one of:
   - central rewrites `ws://satorian.satorinet.io:7777` to the wss URL in
     `/peer/relays` (same relay, so its scores carry over) — simplest;
   - central seeds the wss URL into `discovered_relays` and scores it with the
     ws one;
   - operators add it as a user relay on Docker neurons so traffic builds.
3. Optional: sort `wss://` entries first in `/peer/relays`.

Meanwhile a user can add a `wss://` relay under Settings (written to and read
from), and the dev server reads satorian over `ws://`. The deployment at
satori.satorinet.io and neuron.satorinet.io does that by default: its build
sets `VITE_NOSTR_RELAYS=wss://app.satorinet.io/relay`, Satori's public relay
behind TLS ([../design/deploy.md](../design/deploy.md#build-variables)).
Central's own list still holds only the `ws://` relay, which those pages
show as blocked.
