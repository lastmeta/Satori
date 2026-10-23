# No relay reachable from an HTTPS page

**Status:** worked around (2026-10-20): `wss://relay.satorinet.io` fronts
satorian on central's nginx-proxy, and the app maps central's `ws://` entry
to it ([../design/nostr.md](../design/nostr.md#relays-and-the-read-only-flag)).
The remaining proper fix is central listing a `wss://` address itself, which
waits on the relay redesign the owner is holding
([../intent/network.md](../intent/network.md),
[../plans/market.md](../plans/market.md)) · **Fix in:** central

Nostr is built (step 5, [../design/nostr.md](../design/nostr.md)) and
works from the dev server, which is plain `http://localhost:5180`, against
`ws://` relays. A deployed app is served over https and could not reach
today's only listed relay.

## Precondition

The app is served over HTTPS (any real deployment). Browsers block `ws://`
from an HTTPS page as mixed content, before the CSP is consulted; only
`ws://localhost` and `ws://127.0.0.1` are exempt. A build's CSP has no `ws:`
either (`csp.js`: `connect-src 'self' https: wss:`); only the plain-http dev
page's adds it. On such a page a `ws://` relay with no wss stand-in shows as
**blocked** and is not tried.

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

## The workaround (2026-10-20)

- **TLS in front of satorian:** `wss://relay.satorinet.io`, nginx on
  central's nginx-proxy (157.180.104.175) proxying to
  `satorian.satorinet.io:7777`. The same relay: a REQ and a COUNT through it
  match satorian's exactly (checked when it was added).
- **The app's wss stand-in:** an explicit map from a `ws://` relay to the
  `wss://` address of the same relay (`VITE_NOSTR_WSS`, default satorian →
  `wss://relay.satorinet.io`, [../design/deploy.md](../design/deploy.md#build-variables)).
  Where the app would block a `ws://` relay (a build, an https page) and the
  map has one, it connects to the stand-in instead, as that same relay: it
  stays central's relay (written to as a build writes to central's relays),
  and Settings shows it as `wss://relay.satorinet.io` "for
  ws://satorian.satorinet.io:7777". Central's list is kept as central sent it.
- The deployment's user relay, `wss://nostr.satorinet.io` (Satori's
  public relay over TLS), stays.

## The proper fix (waits on the relay redesign)

Central lists a `wss://` address itself, one of:
- central rewrites `ws://satorian.satorinet.io:7777` to the wss URL in
  `/peer/relays` (same relay, so its scores carry over) — simplest;
- central seeds the wss URL into `discovered_relays` and scores it with the
  ws one;
- operators add it as a user relay on Docker neurons so traffic builds.

Optional: sort `wss://` entries first in `/peer/relays`. Once central lists
it, the app needs no stand-in for it (a central relay listed as `wss://`
opens as it is); the map can stay for any `ws://` entry left.
