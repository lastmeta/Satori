// Ordered migrations. Never edit a shipped entry: append a new one.
// meta.schema_version holds how many have run. An entry is SQL, or a function
// given the meta rows ({ get, set, remove }) for what SQL can't do; each runs
// in its own transaction.
import { recordFromRows } from '../keys/index.js';

export const MIGRATIONS = [
  // 1 (step 1): streams fetched from a URL; times in ms.
  `CREATE TABLE streams (name VARCHAR PRIMARY KEY, url VARCHAR NOT NULL,
     path VARCHAR NOT NULL, interval_s INTEGER NOT NULL, created_at DOUBLE NOT NULL,
     last_error VARCHAR, last_error_at DOUBLE);
   CREATE TABLE observations (stream VARCHAR NOT NULL, ts DOUBLE NOT NULL, value DOUBLE NOT NULL);
   CREATE SEQUENCE prediction_ids;
   CREATE TABLE predictions (id INTEGER PRIMARY KEY DEFAULT nextval('prediction_ids'),
     stream VARCHAR NOT NULL, ts DOUBLE NOT NULL, target_ts DOUBLE NOT NULL,
     value DOUBLE NOT NULL, model VARCHAR NOT NULL, address VARCHAR NOT NULL,
     message VARCHAR NOT NULL, signature VARCHAR NOT NULL, published_at DOUBLE);`,
  // 2 (step 3): central's streams replace them (docs/design/central.md). Times
  // are unix seconds, as central and Satori Lite keep them. observations is
  // Lite's StreamStore: one row per (stream, whole second), insert or ignore.
  // predictions: status 'pending' until a batch with successful > 0 takes it.
  `DROP TABLE predictions; DROP SEQUENCE prediction_ids; DROP TABLE observations; DROP TABLE streams;
   CREATE TABLE streams (uuid VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, meta VARCHAR);
   CREATE TABLE observations (stream_uuid VARCHAR NOT NULL, ts BIGINT NOT NULL, value DOUBLE NOT NULL,
     PRIMARY KEY (stream_uuid, ts));
   CREATE SEQUENCE prediction_ids;
   CREATE TABLE predictions (id INTEGER PRIMARY KEY DEFAULT nextval('prediction_ids'),
     stream_uuid VARCHAR NOT NULL, made_at DOUBLE NOT NULL, model VARCHAR NOT NULL,
     t1 DOUBLE NOT NULL, t2 DOUBLE NOT NULL, observed_at VARCHAR NOT NULL, hash VARCHAR NOT NULL,
     status VARCHAR NOT NULL DEFAULT 'pending', sent_at DOUBLE);`,
  // 3 (step 4): the engine's AR coefficient and fade weight (docs/design/engine.md);
  // null for `naive` and for older rows.
  `ALTER TABLE predictions ADD COLUMN phi DOUBLE;
   ALTER TABLE predictions ADD COLUMN weight DOUBLE;`,
  // 4 (step 5): relay (Nostr) streams, apart from central's, as Lite's network.db
  // (docs/design/nostr.md#storage-migration-4). uuid = Lite's relay model uuid.
  // relay_streams: a subscription and its `_pred` publication (created_at, last seq).
  // relay_observations: deduped on the event id and on (stream, seq); value is
  // the unwrapped number or null. relay_predictions: what we published, to how many relays.
  `CREATE TABLE relay_streams (uuid VARCHAR PRIMARY KEY, stream_name VARCHAR NOT NULL, provider_pubkey VARCHAR NOT NULL,
     name VARCHAR, cadence_seconds BIGINT, meta VARCHAR, active BOOLEAN NOT NULL, subscribed_at BIGINT NOT NULL,
     unsubscribed_at BIGINT, pred_created_at BIGINT NOT NULL, pred_seq BIGINT NOT NULL DEFAULT 0);
   CREATE TABLE relay_observations (stream_uuid VARCHAR NOT NULL, seq BIGINT NOT NULL, ts BIGINT, value DOUBLE,
     raw VARCHAR, event_id VARCHAR NOT NULL UNIQUE, received_at BIGINT NOT NULL, PRIMARY KEY (stream_uuid, seq));
   CREATE TABLE relay_predictions (stream_uuid VARCHAR NOT NULL, seq BIGINT NOT NULL, value VARCHAR NOT NULL,
     model VARCHAR, obs_seq BIGINT, made_at BIGINT NOT NULL, event_id VARCHAR NOT NULL, relays INTEGER NOT NULL,
     PRIMARY KEY (stream_uuid, seq));`,
  // 5 (step 5 review): each relay stream keeps its latest observation, latest
  // prediction and observation count on its row, set at insert time, so the
  // status (on every change) reads one row per stream, not every observation.
  `ALTER TABLE relay_streams ADD COLUMN observations BIGINT DEFAULT 0;
   ALTER TABLE relay_streams ADD COLUMN obs_seq BIGINT;
   ALTER TABLE relay_streams ADD COLUMN obs_ts BIGINT;
   ALTER TABLE relay_streams ADD COLUMN obs_value DOUBLE;
   ALTER TABLE relay_streams ADD COLUMN obs_raw VARCHAR;
   ALTER TABLE relay_streams ADD COLUMN obs_received_at BIGINT;
   ALTER TABLE relay_streams ADD COLUMN p_seq BIGINT;
   ALTER TABLE relay_streams ADD COLUMN p_value VARCHAR;
   ALTER TABLE relay_streams ADD COLUMN p_model VARCHAR;
   ALTER TABLE relay_streams ADD COLUMN p_made_at BIGINT;
   ALTER TABLE relay_streams ADD COLUMN p_relays INTEGER;
   UPDATE relay_streams SET observations = x.n, obs_seq = x.seq, obs_ts = x.ts, obs_value = x.value, obs_raw = x.raw,
     obs_received_at = x.received_at
   FROM (SELECT stream_uuid, count(*) AS n, max(seq) AS seq, arg_max(ts, seq) AS ts, arg_max(value, seq) AS value,
     arg_max(raw, seq) AS raw, arg_max(received_at, seq) AS received_at FROM relay_observations GROUP BY stream_uuid) x
   WHERE x.stream_uuid = relay_streams.uuid;
   UPDATE relay_streams SET p_seq = x.seq, p_value = x.value, p_model = x.model, p_made_at = x.made_at, p_relays = x.relays
   FROM (SELECT stream_uuid, max(seq) AS seq, arg_max(value, seq) AS value, arg_max(model, seq) AS model,
     arg_max(made_at, seq) AS made_at, arg_max(relays, seq) AS relays FROM relay_predictions GROUP BY stream_uuid) x
   WHERE x.stream_uuid = relay_streams.uuid;`,
  // 6 (bvar): each central target's champion spec, drawn from the identity and
  // evolved after each poll (docs/design/engine.md#bvar-a-model-per-central-stream-unique-to-each-neuron):
  // spec = JSON {companions, lambda1, lambda2}; score = its backtest error (null
  // until 5 origins); generation = mutations proposed; accepted = mutations kept.
  // streams.history_at: when central's history was fetched for the stream (null = not yet).
  `CREATE TABLE model_specs (target_uuid VARCHAR PRIMARY KEY, spec VARCHAR NOT NULL, score DOUBLE,
     generation INTEGER NOT NULL DEFAULT 0, accepted INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL);
   ALTER TABLE streams ADD COLUMN history_at BIGINT;`,
  // 7 (2026-10-16): the keys move from Docker's wallet.yaml / vault.yaml / nostr.yaml texts into this
  // app's own record, meta `keys` (docs/design/keys.md#the-record). The identity and the Nostr key are
  // translated now; the vault keeps its yaml in the record until its next Unlock re-encrypts it. Rows of
  // a setup cut off before wallet_yaml, and the step-1 prototype's meta.vault, are left as they are.
  async ({ get, set, remove }) => {
    const walletYaml = await get('wallet_yaml');
    const vaultYaml = await get('vault_yaml');
    if (!walletYaml || !vaultYaml) return;
    await set('keys', await recordFromRows({ walletYaml, vaultYaml, nostrYaml: await get('nostr_yaml') }));
    await remove('wallet_yaml', 'vault_yaml', 'nostr_yaml');
  },
  // 8 (2026-10-16): the activity log Home's health is read from (docs/design/health.md#the-activity-log).
  // ts: when (the API's `at`); last_ts: a merged row's last change (`until`: a session's heartbeat, a repeated
  // failure); level: ok | warn | bad | idle; data: JSON; count and mkey: how many identical events a merged row
  // stands for, and its key. (`at` and `until` are DuckDB keywords.)
  `CREATE SEQUENCE activity_ids;
   CREATE TABLE activity (id INTEGER PRIMARY KEY DEFAULT nextval('activity_ids'), ts DOUBLE NOT NULL, last_ts DOUBLE,
     kind VARCHAR NOT NULL, level VARCHAR NOT NULL, data VARCHAR, count INTEGER NOT NULL DEFAULT 1, mkey VARCHAR);`,
  // 9 (2026-10-17): streams.predicted_ts, the observation (its ts) the stream's latest prediction was made from,
  // so a poll predicts every stream whose latest observation has none, not only those with a new row
  // (docs/design/central.md#deviations-from-satori-lite-and-why). Which observation an earlier prediction came from
  // is not known: a stream predicted before counts as predicted through its latest one (never predicted twice).
  `ALTER TABLE streams ADD COLUMN predicted_ts BIGINT;
   UPDATE streams SET predicted_ts = (SELECT max(o.ts) FROM observations o WHERE o.stream_uuid = streams.uuid)
   WHERE EXISTS (SELECT 1 FROM predictions p WHERE p.stream_uuid = streams.uuid);`,
  // 10 (2026-10-18): the vault's delegatePredictionPower(identity) is called staking (docs/design/base.md): the
  // activity log's earlier rows say it in those words too, so the feed never shows the old ones.
  `UPDATE activity SET data = replace(replace(replace(replace(data, '"undelegate"', '"unstake"'), '"delegate"', '"stake"'),
     'Delegated to this neuron', 'Staked with this neuron'), 'Stopped delegating', 'Unstaked') WHERE kind = 'wallet';
   UPDATE activity SET data = replace(data, 'no prediction power delegated to the identity', 'nothing staked with this neuron'),
     mkey = replace(mkey, 'no prediction power delegated to the identity', 'nothing staked with this neuron') WHERE kind = 'base';`,
  // 11 (2026-10-18): what the Models tab shows for each central target (docs/design/models.md), kept by the poll that
  // ran it: persist = no change's median backtest error on the same origins as `score` (null until 5 origins);
  // influence = JSON [share of the target's own lag, then each companion's] in the bvar forecast (null: not bvar).
  // Specs stored before have both null until their next poll.
  `ALTER TABLE model_specs ADD COLUMN persist DOUBLE;
   ALTER TABLE model_specs ADD COLUMN influence VARCHAR;`,
  // 12 (2026-10-18): the training pass (docs/design/models.md#the-training-pass). model_specs.fit_key: the data the
  // score, persist and influence were computed on (the spec's λs and each input's row count and newest time); a spec
  // whose key is not its data's now is scored again from the stored history, without a poll (null: never, so specs
  // stored before are). relay_streams.p_score, p_persist, p_tests: the latest `_pred`'s backtest, made with it (tests:
  // its origins, 0 for naive; null: not computed, so a `_pred` kept before is scored by the pass).
  `ALTER TABLE model_specs ADD COLUMN fit_key VARCHAR;
   ALTER TABLE relay_streams ADD COLUMN p_score DOUBLE;
   ALTER TABLE relay_streams ADD COLUMN p_persist DOUBLE;
   ALTER TABLE relay_streams ADD COLUMN p_tests INTEGER;`,
];
