# No relay reachable from an HTTPS page

**Status:** open · **Blocks:** Nostr parity (not v1) · **Fix in:** relay hosting and central

## Precondition

The app is served over HTTPS (any real deployment). Browsers block `ws://`
from an HTTPS page as mixed content.

## Finding (verified)

- Central's relay list, probed 2026-10-14, holds one relay:
  `ws://satorian.satorinet.io:7777`. Port 7777 has no TLS and
  `https://satorian.satorinet.io:443` did not answer.
- How central builds that list: relays are discovered from NIP-65 (kind 10002)
  events (`central/relay_watcher/nip65.py:169-211`) into `discovered_relays`.
  `/peer/relays` returns only those with `relay_daily_scores` traffic
  (`messages_received > 0`) in the last 7 days, falling back to all discovered
  relays only when no such rows exist (`central/src/api/v1/endpoints/peer.py:125-150`).
- A Docker neuron's NIP-65 lists the relays it is **connected to**
  (`neuron/neuron-lite/start.py:370-383`), and it connects only to relays
  central lists or its own DB entries. (`neuron/web/routes.py:444-445` only
  builds a `ws://` display hint for Settings; it registers nothing.)

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

Until then the browser app can develop Nostr parity against a local relay on
`ws://localhost` (allowed as a secure context).
