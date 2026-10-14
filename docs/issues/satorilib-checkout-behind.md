# Local satorilib checkout is behind what the neuron needs

**Status:** open · **Kind:** fixable, housekeeping · **Fix in:** `/code/Satori/satorilib` (pull)

The Docker neuron calls `set_followed_authors`, `find_datastreams`,
`parse_observation_event`, `get_last_observation_events`, which exist only on
satorilib `origin/base-upgrade` (commit dec62db). The local working tree is
behind it and still subscribes a firehose filter
(`satorilib/src/satorilib/satori_nostr/client.py:1561-1580`).

Impact on this repo: anyone reading the local satorilib as the protocol
reference gets the old filter shapes. [transport.md](../design/transport.md)
cites origin/base-upgrade for those parts. Fix: update the local checkout.
