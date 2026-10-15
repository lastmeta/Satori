# Transport (Nostr): what is left after step 5

[← Roadmap](README.md)

Step 5 built Nostr as Satori Lite runs it for free streams: the Nostr key,
relays (central's and the user's), discover, subscribe, intake, `_pred`
publish and announce, unsubscribe, hourly reconcile and NIP-65
([../design/nostr.md](../design/nostr.md), with Lite's file:line
references and every deviation). This file keeps only what is still to do.

"origin client" below means
`git show origin/base-upgrade:src/satorilib/satori_nostr/client.py` (dec62db).

## Still to do

- **A wss relay.** A deployed (https) app can't open `ws://`, and central
  lists only `ws://satorian.satorinet.io:7777`
  ([issue](../issues/relays-not-wss.md)). Until then Nostr works from the dev
  server (plain http) and against `ws://localhost`.
- **Base bridge streams (step 6).** Streams `satori-<chainId>-<id>` from the
  bridge provider; Lite subscribes to them automatically
  (`neuron/neuron-lite/start.py:453-517`) and dedupes their observations by the
  on-chain `round` before the event id and the seq
  (`neuron/neuron-lite/satorineuron/network_db.py:597-636`). The browser may
  read the chain instead ([base.md](../design/base.md#the-daily-batch-the-identity-on-its-own)).
- **Paid and encrypted streams.** Per-subscriber NIP-04 events, payment
  channels (34603-34606), the `#p` personal filter and kind 34604 in the
  follow (origin client 1687-1745). Port the live-push decrypt path, not origin
  client's `parse_observation_event`, which returns None for paid events
  ([issue](../issues/satorilib-paid-observation-parse.md)).
- **Approval-gated streams and access requests** (34609), **bounties**
  (34607-34608; `start.py:669-882,1334-1362`).
- **Own data sources and publications** (Lite's `data_sources` and
  publications that are not `_pred`; they count toward `max_streams`).
- **Staleness.** Lite marks a subscription stale after 1.5 × cadence with no
  observation and hunts other relays for it, rechecking after 24 h
  (`start.py:4407-4547`). The browser stays connected to every listed relay;
  with more relays listed, hunting may be worth adding.

## Inherent and accepted

- For non-Base Nostr streams, history is what the node received while open; a
  reopened node gets each stream's latest value, not the ones it missed.
- A browser cannot host a relay ([issues](../issues/README.md#inherent-browser-limits)).
