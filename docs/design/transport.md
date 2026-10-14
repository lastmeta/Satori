# Transport (Nostr)

[← OVERVIEW](OVERVIEW.md)

Streams and predictions travel over Nostr. The browser speaks the same wire
protocol as Docker's satorilib `SatoriNostr`, using `nostr-tools` 2.25.2 in the
neuron worker.

Reference implementation: the neuron needs satorilib on `origin/base-upgrade`
(commit dec62db: `set_followed_authors`, `find_datastreams`); the local
`/code/Satori/satorilib` checkout is behind it
([issue](../issues/satorilib-checkout-behind.md)). "origin client" below means
`git show origin/base-upgrade:src/satorilib/satori_nostr/client.py`.

## Wire protocol (verified)

Kinds (`satorilib/src/satorilib/satori_nostr/models.py:512-521`), all
parameterized-replaceable:

| Kind | Meaning | v1 |
|---|---|---|
| 34600 | datastream announcement, `d=stream_name` | read (discovery); publish for `_pred` |
| 34601 | observation, `d=stream_name` (relay keeps latest only) | read + publish `_pred` |
| 34602 | subscription announcement | publish |
| 34603 | payment notification | later |
| 34604-34606 | channel commitment / open / settled | later |
| 34607 | bounty announcement | later |
| 34608 | prediction DM to bounty host | later |
| 34609 | access request DM | later |
| 10002 | NIP-65 relay list | publish daily |

Encryption is **NIP-04 only** (`satorilib/src/satorilib/satori_nostr/encryption.py:1-10`).
The browser must use NIP-04 to interoperate with Docker neurons. v1 needs no
encryption at all (free streams), so the NIP-44 question can wait.

Free observation (34601): content = JSON `{stream_name, timestamp, value,
seq_num}`, tags `d`, `stream`, `seq`, `satori=observation`
(`satorilib/src/satorilib/satori_nostr/client.py:530-656`). Empty content is a
heartbeat and is skipped (`client.py:1643-1700`).

Predictions are an ordinary 34601 on the sibling stream `<stream>_pred`
(`neuron/neuron-lite/start.py:1318-1321`), announced as a publication.

## Relays

- List = central `GET /api/v1/peer/relays` ∪ user-added relays
  (`start.py:314-323`; `neuron/neuron-lite/satorineuron/network_db.py:712-726`).
- **wss:// only.** An HTTPS page cannot open `ws://` (mixed content). `ws://`
  entries are shown as "unreachable from the browser", except
  `ws://localhost` for development. The only relay central lists today is
  `ws://satorian.satorinet.io:7777` (probed 2026-10-14), so this blocks v1
  ([issue](../issues/relays-not-wss.md)).
- Stream cap: `relay-config.max_streams` (60 live), local default 100
  (`network_db.py:14-36`).

## Filters

Same two shapes as origin client (`origin client:1687-1745`; `start.py:402-409,432-455`):

1. Personal: `{kinds:[34601..34606,34608,34609], '#p':[me]}`.
2. Followed: `{kinds:[34601,34604], authors:[subscribed providers]}`, chunked 200
   authors per filter, subscription id `satori-follow`.

Added for the browser: `since` = last seen `created_at` per relay (stored in
`relay_cursor`), so reopening the tab does not replay everything and a frozen
tab catches up. Keep ≤ 20 subscriptions per connection (strfry
`maxSubsPerConnection`, `neuron/neuron-lite/satorineuron/relay_manager.py:691`).

## Reconcile (hourly + on open/online/resume)

Port of `_networkReconcile` (`start.py:200-302`), one async loop, no threads:

1. Fetch relays and relay-config.
2. Subscriptions with no observation within 1.5 × cadence are inactive (all, on
   first run). Skip any marked stale in the last 24 h.
3. For each relay (shuffled): connect; `find_datastreams` for wanted
   `(provider, name)` pairs — per-author filters `{authors:[a], '#d':[names]}`
   (`origin client:945-1000`); freshness from the latest 34601 vs cadence × 1.5
   (`start.py:1047-1110`); subscribe fresh matches, record `relay_url`.
4. Mark not-found as stale; disconnect relays carrying nothing we need.
5. Base stream auto-selection ([chain.md](chain.md#stream-selection)).
6. Refresh the followed-authors filter.
7. Announce our `_pred` publications (34600) on each connected relay.
8. Publish 10002 with `['r', url]` for connected relays, once per 24 h
   (`start.py:370-389`).

Reconnect per relay with backoff on close; no process restart.

## Intake

Port of `_networkListen` / `_networkProcessObservation`
(`start.py:621-667,1112-1137`):

1. Drop events for streams we don't subscribe to; dedupe by event id in memory.
2. Unwrap the value (`_numericObservationValue`, `start.py:1364-1424`): prefer
   `value`; reject `unit:'tick'` without a converted value; else `raw`. Reject
   timestamps outside 2000-2100 (`_safeEpoch`).
3. Insert into `observations` with dedupe by Base `round` (bridge streams), then
   event id, then `(stream, provider, seq)`.
4. Only a new row triggers the engine and the `_pred` publish.

## Publish `_pred`

Port of `start.py:1276-1330`:

1. Numeric: engine forecast. Non-numeric or no forecast: echo the last value.
2. Save to `predictions`; `seq` = local `publications.last_seq_num + 1`.
3. `finalizeEvent` kind 34601 on `<stream>_pred` to every connected relay; mark
   published on the first OK.

Relay-side model ids reproduce Docker's uuid5 so an imported history keys the
same: `uuid5(NAMESPACE_DNS, 'satori-relay:<lowercased pubkey>:<stream>:')` —
note the trailing colon (`neuron/neuron-lite/satorineuron/relay_ids.py:28-32,48-77`).

## Inherent and accepted

- Kind 34601 is replaceable per (author, d): relays keep only the latest
  observation. History is whatever the node received while open. On reopen the
  node gets the latest value, not the ones it missed. Docker has the same
  property with less downtime.
- A browser cannot host a relay ([issues](../issues/README.md#inherent-browser-limits)).

## Later

Paid streams (per-subscriber NIP-04 events, payment channels), bounties,
access requests, own data sources. When paid streams come: port the live-push
decrypt path, not origin client's `parse_observation_event`, which returns None
for paid events ([issue](../issues/satorilib-paid-observation-parse.md)).
