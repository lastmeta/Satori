# Storage: DuckDB-WASM on OPFS

[← OVERVIEW](OVERVIEW.md)

One database per browser profile and origin: `opfs://satori-mvp.duckdb`
(`src/db/opfs.js`), DuckDB-WASM 1.32.0 (newer builds create OPFS files but
never write them). The name stays: renaming it would orphan stored keys and
data, and `satori.duckdb` on this origin holds an earlier draft's other schema.
Only the tab that holds the `satori-neuron` Web Lock opens it. The API is
`src/db/index.js`: every call runs one at a time, in call order (`serial()`,
`src/util.js`). No DuckDB extension is loaded (`autoload_known_extensions =
false`): JSON is kept as text and parsed in JS. Times are unix seconds.

## The checkpoint rule

OPFS keeps what DuckDB has **checkpointed**; a tab may close at any moment and
nothing runs on close. So every write that must survive is followed by
`CHECKPOINT`: setup (the keys), each central cycle (after its submission),
each new poll time, a Settings save, a new relay list from central, NIP-65's
time, each outbox edit, a relay observation and its `_pred` (before the
`_pred` is sent, as Lite commits first), a subscribe and an unsubscribe, the
Base batch's hash as soon as it is sent and the batch after its receipt.

## Migrations

`src/db/schema.js` holds an ordered list; `meta.schema_version` says how many
have run, each in its own transaction. A shipped entry is never edited: a
change is a new entry. A database from a newer app (a higher version) is
refused, not migrated.

1. **Step 1**: URL-fetched streams, their observations and signed predictions
   (times in ms). Replaced by 2.
2. **Step 3**: central's data, as Lite's StreamStore. `streams (uuid, name,
   meta)`; `observations (stream_uuid, ts, value)`, one row per (stream, whole
   second), insert or ignore; `predictions (id, stream_uuid, made_at, model,
   t1, t2, observed_at, hash, status 'pending' | 'sent', sent_at)`. Step 1's
   tables are dropped; `meta` (the keys) stays.
3. **Step 4**: `predictions.phi` and `weight`, the engine's AR coefficient and
   fade weight (null for `naive` and for older rows).
4. **Step 5**: relay (Nostr) streams, apart from central's, as Lite's
   `network.db`: `relay_streams` (a subscription and its `_pred` publication:
   `uuid` = Lite's relay model uuid, `stream_name`, `provider_pubkey`, `name`,
   `cadence_seconds`, `active`, `subscribed_at`, `pred_created_at`,
   `pred_seq`), `relay_observations (stream_uuid, seq, ts, value, raw,
   event_id, received_at)` deduped on the event id and on (stream, seq), and
   `relay_predictions (stream_uuid, seq, value, model, obs_seq, made_at,
   event_id, relays)`.
5. **Step 5 review**: each relay stream keeps its latest observation
   (`obs_*`), its latest `_pred` (`p_*`) and its observation count on its own
   row, set at insert time, so the status (read on every change) reads one
   row per stream. Filled from the existing rows when it runs.

Columns kept but no longer written: `relay_streams.meta` (the announcement
at subscribe time) and `unsubscribed_at`; nothing read them. Kept and written,
though only the latest is read (from `obs_*`): `relay_observations.raw` and
`received_at`, the only record of what each provider sent and when.

## meta keys

Each value is JSON text.

| Key | Holds | Written by |
|---|---|---|
| `schema_version` | how many migrations have run | the migrations |
| `wallet_yaml` | the identity: Docker's `wallet.yaml`, plain text ([keys.md](keys.md)) | setup |
| `vault_yaml` | the vault: Docker's `vault.yaml`, fields encrypted; its address and public key plain | setup |
| `nostr_yaml` | the Nostr key: Docker's `nostr.yaml`, plain text ([nostr.md](nostr.md)) | setup; the first start of an older install |
| `central_url` | the Settings URL; `''` = the default | Settings, `setCentral` |
| `next_poll_at` | when the next poll is due, so a reload keeps the 11 h cadence ([central.md](central.md)) | each poll's schedule |
| `central_last_poll` | the last poll: `{ at, streams, new, predicted }` or `{ at, error }` | each cycle; dropped with another central |
| `central_last_submit` | the last predictions batch: `{ at, total_submitted, successful, failed, errors }` or `{ at, error }` | each cycle with something pending; dropped with another central |
| `nostr_relays` | the user's relays (Settings) | `setRelays` |
| `nostr_central_write` | whether central's relays are written to | `setRelays` |
| `nostr_central_relays` | central's last relay list, used while central is down | the hourly reconcile |
| `nostr_relay_list_at` | when the NIP-65 relay list (10002) was last published (daily) | the relay-list publish |
| `nostr_outbox` | unsubscribes and tombstones waiting for a relay that was not open: `[{ url, event }]`, at most 100 | unsubscribe; each flush |
| `base_rpc_url` | the Base RPC setting; `''` = the default ([base.md](base.md)) | Settings, `setBaseRpc` |
| `base_max_fee_gwei` | the batch's max-fee ceiling; null = 2 gwei | Settings, `setBaseMaxFee` |
| `base_pending_batch` | a batch sent and not yet mined: `{ round, hash, games, dropped }`, so a check never sends twice | the batch, at send; cleared after |
| `base_last_batch` | the last mined batch: `{ round, at, hash, games, dropped }` | the batch, after its receipt |

Another central (Settings) has other stream uuids, so changing it deletes the
pending predictions, the `streams` rows and `central_last_poll` /
`central_last_submit`; observations and sent predictions stay.
