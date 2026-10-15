# Transport (Nostr) — parity, after v1

[← OVERVIEW](OVERVIEW.md)

v1 does not use Nostr: both earning paths run over HTTPS
([OVERVIEW](OVERVIEW.md#how-v1-earns-verified)). This doc is the next step,
Nostr parity: follow free streams, publish `<stream>_pred`, announce it. It is
blocked until a relay has a wss:// endpoint ([issue](../issues/relays-not-wss.md)).
`nostr-tools` 2.25.2 in the neuron worker speaks the same wire protocol as
Docker's satorilib `SatoriNostr`.

"origin client" below means
`git show origin/base-upgrade:src/satorilib/satori_nostr/client.py` (commit
dec62db), which the Docker neuron needs (`set_followed_authors`,
`find_datastreams`); the local satorilib checkout is behind it.

## Wire protocol (verified)

Kinds (`satorilib/src/satorilib/satori_nostr/models.py:512-521`), all
parameterized-replaceable:

| Kind | Meaning | Parity step |
|---|---|---|
| 34600 | datastream announcement | read (discovery); publish for `_pred` |
| 34601 | observation (relay keeps latest per stream, `models.py:513`) | read; publish `_pred` |
| 34602 | subscription announcement | publish |
| 10002 | NIP-65 relay list | last, see below |
| 34603-34609 | payments, channels, bounties, prediction and access DMs | later |

Encryption is **NIP-04 only** (`satorilib/src/satorilib/satori_nostr/encryption.py:1-10`);
free streams need none.

**Free observation (34601)**: content = JSON `{stream_name, timestamp (int),
value, seq_num}`, tags `d`, `stream`, `seq`, `satori=observation`
(`satorilib/src/satorilib/satori_nostr/client.py:530-656`). Empty content is a
heartbeat and is skipped (`client.py:1643-1700`).

**`_pred` observation**: an ordinary 34601 on `<stream>_pred`
(`neuron/neuron-lite/start.py:1318-1323`) whose `value` is a **string**, the
engine's forecast text (`start.py:1300`, from `predictForRelay`,
`neuron/engine-lite/engine.py:732`) or the JSON-dumped echo of a non-numeric
value (`start.py:1304-1308`). `seq_num` = local `last_seq_num + 1`.

**`_pred` announcement (34600)** (origin client `announce_datastream`, 294-345):

- tags: `d=<stream>_pred`, `satori=datastream`, one `t` per topic tag,
  `stream=compute_stream_topic_tag(name)` (`models.py:534`),
  `source_stream=<source name>`, `source_pubkey=<source provider>`;
- content: `DatastreamMetadata.to_json()` (origin `models.py:14-40`) with
  `stream_name, nostr_pubkey, name, description, encrypted, price_per_obs,
  created_at, cadence_seconds, tags` and `metadata = {source_stream_name,
  source_provider_pubkey, wallet_pubkey}` (`start.py:3454-3477`).

Both shapes go into the parity fixtures.

## Relays

- Docker's reconcile hunts only on central `GET /api/v1/peer/relays`, falling
  back to the relay_urls of existing subscriptions (`start.py:4466-4471`).
  User-added relays are used only for publisher connections
  (`start.py:316-322`). Parity: same; a user-added relay list for hunting would
  be a browser-side change.
- **wss:// only.** An HTTPS page cannot open `ws://` (mixed content); `ws://`
  entries are shown as unreachable, except `ws://localhost` in development.
- Stream cap: `relay-config.max_streams` (`peer.py:164-172`), fetched once at
  start as Docker does (`start.py:238-246`); local default 100
  (`network_db.py:14-36`).

## Filter

One: `{kinds:[34601], authors:[subscribed providers]}`, chunked 200 authors per
filter, id `satori-follow`. Docker also subscribes a personal `#p` filter and
kind 34604 (origin client 1687-1745); those carry only paid, channel and bounty
traffic, added when those land. Keep ≤ 20 subscriptions per connection (strfry
`maxSubsPerConnection`, `relay_manager.py:691`).

No `since` and no cursor table: 34601 is replaceable, so a resubscribe returns
at most one event per stream, and intake dedupes it.

## Reconcile (hourly + on open/online/resume)

Port of `_networkReconcile` (`start.py:4407-4547`), driven by the loop at
`start.py:200-302`:

1. Fetch `/peer/relays`.
2. Subscriptions with no observation within 1.5 × cadence are inactive. Skip
   any marked stale in the last 24 h.
3. For each relay (shuffled): connect; `find_datastreams` with per-author
   filters `{authors:[a], '#d':[names]}` (origin client 945-1000); freshness from
   the latest 34601 vs cadence × 1.5 (`start.py:1047-1110`); subscribe fresh
   matches.
4. Mark not-found as stale; disconnect relays carrying nothing we need.
5. Announce `_pred` publications (34600) on each connected relay.

Base streams are not found here; they come from the registry
([chain.md](chain.md#base-streams)). Reconnect per relay with backoff.

## Intake

Port of `_networkProcessObservation` (`start.py:621-667,1112-1137`): drop
unsubscribed streams; unwrap the value (`_numericObservationValue`,
`start.py:1364-1424`; reject `unit:'tick'` without a converted value; timestamps
outside 2000-2100 rejected); insert with dedupe by event id, then
`(stream, provider, seq)` (`network_db.py:598-636`). Only a new row runs the
engine and the `_pred` publish. Model ids keep Docker's uuid5:
`uuid5(NAMESPACE_DNS, 'satori-relay:<lowercased pubkey>:<stream>:')`, trailing
colon (`neuron/neuron-lite/satorineuron/relay_ids.py:28-32,48-77`).

## NIP-65 (last)

Docker publishes kind 10002 with `['r', url]` for its connected relays daily
(`start.py:370-389`). Central uses it only to discover relays and count
`neuron_count` (`central/relay_watcher/nip65.py:1-6,169-211`). A browser node
connects only to relays central already lists, so it adds nothing; publish only
user-added wss relays, if any.

## Inherent and accepted

- For non-Base Nostr streams, history is what the node received while open; a
  reopened node gets each stream's latest value, not the ones it missed. (Base
  streams are not affected: their history comes from the registry.)
- A browser cannot host a relay ([issues](../issues/README.md#inherent-browser-limits)).

## Later

Paid streams (per-subscriber NIP-04 events, payment channels), bounties, access
requests, own data sources. For paid streams port the live-push decrypt path,
not origin client's `parse_observation_event`, which returns None for paid
events ([issue](../issues/satorilib-paid-observation-parse.md)).
