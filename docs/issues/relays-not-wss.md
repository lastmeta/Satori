# No relay reachable from an HTTPS page

**Status:** open · **Blocks:** v1 streams · **Fix in:** relay hosting (and optionally central)

## Precondition

The app is served over HTTPS (any real deployment). Browsers block `ws://`
from an HTTPS page as mixed content.

## Finding (verified)

- Central's relay list, probed 2026-10-14, holds one relay:
  `ws://satorian.satorinet.io:7777`. Port 7777 has no TLS and
  `https://satorian.satorinet.io:443` did not answer.
- Docker's embedded relay advertises `ws://host:7777` / `ws://host:7171`
  (`neuron/web/routes.py:444-445`; strfry bound in
  `neuron/neuron-lite/satorineuron/relay_manager.py:421-456`), so relays that
  neurons register are `ws://` by construction.
- The local DB accepts both schemes (`neuron/neuron-lite/satorineuron/network_db.py:712-726`).

## Fix

1. Put TLS in front of at least one canonical relay (Caddy or nginx →
   `wss://satorian.satorinet.io`) and publish that URL in its NIP-65 list so
   central lists it.
2. Optional, central: mark or sort `wss://` entries in `/api/v1/peer/relays`
   (`central/src/api/v1/endpoints/peer.py:123-163`).

Until then the browser app can be developed against a local relay on
`ws://localhost` (allowed as a secure context).
