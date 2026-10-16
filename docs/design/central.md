# Central: register, poll, predict, submit

[← OVERVIEW](OVERVIEW.md)

The neuron's data comes from central and its predictions go back to central,
the way Satori Lite (`../neuron`, the Docker neuron) does it today. The browser
calls central directly with `fetch`; there is no proxy. Central's CORS allows
any origin and header (`central/src/main.py:63-69`, `allow_origin_regex=r".*"`
at `:65`).

```
page load ─▶ register (wallet-pubkey, vault-pubkey)            once per start
         └─▶ schedule: first poll 5–30 min later, then every 11 h
poll ─▶ GET observations/batch ─▶ store (insert or ignore) ─▶ history for new streams ─▶ forecast streams with a new row
     ─▶ queue {value: t2, t1_value: t1, observed_at, hash} ─▶ login (identity) ─▶ POST predictions/batch
```

**How it earns** (verified in central's code, 2026-10-14): central scores
these predictions in its daily run (`central/src/scripts/daily_run.py:1-8,25`)
and keeps a predictor only with a reward, or a balance plus pool contribution
of at least `stake_requirement` = 250 SATORI (`central/src/scripts/score.py:1992`,
`mint.py:5`). Payouts go to `base_earnings` under the Base address of the
registered **vault** pubkey (`central/src/scripts/distribution.py:48-53,278-280`),
which the merkle drop publishes (`publish_merkle_root.py:1-6,34-37`) and the
vault claims on Base ([base.md](base.md)). So register's `vault-pubkey`, and
250 SATORI on the vault's Base address (or pool membership), are what make
central-lite earn.

Short names: `start.py` = `neuron/neuron-lite/start.py`; `engine.py` =
`neuron/engine-lite/engine.py`; `server.py` =
`satorilib/src/satorilib/server/server.py`; `c/main.py` =
`central/src/main.py`; `c/auth.py` = `central/src/api/v1/endpoints/auth.py`;
`data_helper.py` and `stream_store.py` are in `neuron/engine-lite/satoriengine/`.

## What Satori Lite does, and what the browser does

| Step | Satori Lite | Browser (`src/central/`, `src/neuron/`) |
|---|---|---|
| Register | On every start, `authWithCentral` (`start.py:4976-5006`) reads the vault's address and `publicKey` from `vault.yaml` without decrypting it (`start.py:4637-4667`) and calls `checkin` → `POST /api/v1/peer/register` with headers `wallet-pubkey` (identity), `vault-pubkey`, optional `nostr-pubkey`, `neuron-version` (`v3.2.13`); no body, no token, 10 s timeout; only when there is a vault pubkey; a failure is only logged (`server.py:384-434`). | The same on every page load, with `nostr-pubkey` (the Nostr key, [nostr.md](nostr.md)) and `neuron-version: browser-<package version>`. Every stored `vault.yaml` has a plain `publicKey` (import re-writes an old one), so it is always sent. The result is shown, never retried in a loop. |
| Central's side | Creates the peer, or for a known identity sets the vault only if none is stored yet; a vault that conflicts with another peer is silently dropped (`vault_address: null`); an identity conflict is a 409 (`c/main.py:705-838`). | Compares the returned `vault_address` with ours and shows a **vault mismatch** (central has another vault, or none). |
| Schedule | First poll after `random.randint(300, 1800)` s (`start.py:4777-4779`), then `sleep(11 h)` after every poll, whatever the result (`start.py:4785-4876`). | Same numbers. `meta.next_poll_at` is stored, so a reload keeps the schedule (see Deviations). **Poll now** runs a cycle at once. |
| Poll | `GET /api/v1/observations/batch?limit=100` (`server.py:1304-1377`). Central returns each stream's latest observation if under 48 h old (`c/main.py:292-341`). `value` and `observed_at` are strings. | Same call, no token (central needs none). |
| Store | `value` = float; epoch = `observed_at`, falling back to `ts` (`data_helper.py:40-93`), truncated to whole seconds (`engine.py:669-673`); `INSERT OR IGNORE` on `(stream_uuid, epoch)` (`stream_store.py:48-56,150-170`); the stream's name/meta are upserted (`server.py:1334-1358`). | Same rule into `observations (stream_uuid, ts, value)`, primary key `(stream_uuid, ts)`; `streams (uuid, name, meta)`. Rows with no stream, no finite value or no time are dropped. |
| Which streams | Every stream in the batch; a model predicts only when its stream got a **newly inserted** row (`engine.py:695-712`, test at `:707`). | Same: `addObservations` returns the streams that got a new row; only those are forecast. |
| Forecast | `t1` = one step ahead; `t2` = forecast again with `t1` appended, falling back to `t1` (`engine.py:1153-1186`). | `runModels` (`src/engine/evolve.js`) for the streams with a new row, over every central stream's history: each target's own `bvar` spec (a Bayesian VAR(1) with 1–3 companion streams, drawn from the identity and evolved), falling back to `bar1` (a Bayesian AR(1) on 12 h returns) or `naive` ([engine.md](engine.md)): t1 is 12 h ahead, t2 24 h. |
| Payload | `{stream_uuid, stream_name, value: str(t2), t1_value: str(t1), observed_at: str(time.time() at prediction), hash: sha256(value + observed_at)[:16]}` (`engine.py:1044-1106,1188-1206`). | Byte-identical: `pyFloatStr` mimics Python's `str(float)`; checked against a fixture made in the Docker image (below). |
| Queue | `collectAndSubmitPredictions` right after the poll (`start.py:4693-4736`, called at `:4870`); `flushPredictionQueue` keeps the whole queue when `successful == 0` or the call failed, and clears it otherwise (`engine.py:432-454`). | Predictions are stored with `status = 'pending'`; after every successful poll the pending ones made in the last 2 × 11 h are sent (older ones are dropped); on `successful > 0` all are marked `sent`, otherwise they stay pending for the next cycle. |
| Submit | Log in (`POST /api/v1/auth/login`, headers `wallet-pubkey`, `message`, `signature` by the **identity**; `server.py:87-118`), then `POST /api/v1/predictions/batch` with `Authorization: Bearer`, body `{"predictions": [...]}`; on a 401 log in again and retry once (`server.py:170-230`, retry at `:210`); when the call raises (a network error or a timeout), resend it once (`server.py:231-268`). Timeouts 10–15 s. | Same, with one fresh login per submission. Timeouts 15 s. Every call is resent once on a network error, a timeout or a 5xx. |

Not used (dropped from Lite): the `checkinCheck` watchdog and restarts
(`start.py:4883-4892`), `/auth/refresh` and its timer (`server.py:120-140`), the
10-minute reconnect delay (`start.py:4902-4908`), `setMiningMode` (a route
central no longer has), the reward address, stake and pool routes, and about 90
other `server.py` methods for routes central-lite does not serve.

## Endpoints

| Call | Auth | Central | When |
|---|---|---|---|
| `POST /api/v1/peer/register` (headers `wallet-pubkey`, `vault-pubkey`, `nostr-pubkey`, `neuron-version`) → `{success, peer_id, wallet_address, vault_address, nostr_pubkey, message}` | none | `c/main.py:705-838` | every page load; again when the central URL changes |
| `GET /api/v1/observations/batch?limit=100` → `[{id, observed_at, value, hash, stream_id, stream: {uuid, name, meta, …}, ts, stream_uuid}]` | none | `c/main.py:292-341` | each poll |
| `GET /api/v1/observations/history?stream_uuid=<uuid>&limit=1000&since=<now − 1,000 h>` → `[{id, stream_uuid, observed_at, value, ts}]`, oldest first | none | `central` bc043d2 (the most recent `limit` rows; 404 `Stream not found: <uuid>` for an unknown or malformed uuid, 422 for a bad limit or since); not deployed on central2 yet (404 `Not Found`) | once per stream ([below](#history-an-addition-beyond-lite)) |
| `GET /api/v1/auth/challenge` → `{challenge}` (a UUID) | none | `c/main.py:268-281` | before each login |
| `POST /api/v1/auth/login` (headers `wallet-pubkey`, `message`, `signature`) → `{access_token, expires_in: 3600, …}` | signature | `c/auth.py:21-86` | before each submission, once more on a 401 |
| `POST /api/v1/predictions/batch` → `{total_submitted, successful, failed, prediction_ids, errors}` | Bearer | `c/main.py:483-602`; schema `central/src/models/schemas.py:92-113` | right after each poll, when anything is pending |
| `GET /api/v1/peer/relays` → `[{relay_url, nostr_pubkey, evr_address}]`; `GET /api/v1/peer/relay-config` → `{max_streams}` | none | `central/src/api/v1/endpoints/peer.py:123-173` | Nostr ([nostr.md](nostr.md)): relays at start and hourly, the config once per start |

Central silently maps an unknown `stream_uuid` to its `bitcoin` stream
(`c/main.py:536-551`), so the browser only submits uuids it received.

## History: an addition beyond Lite

Lite has no history call: its local history grows by one row per stream per
poll, about two a day, so `bvar` (and `bar1`) would wait days for aligned
rows. Central is adding `GET /api/v1/observations/history` (2026-10-15):
`stream_uuid`, `limit` 1..1000 (default 500), `since` (unix seconds,
exclusive), answering `[{id, stream_uuid, observed_at, value, ts}]` oldest to
newest. `src/neuron/history.js`:

- **Which streams**: those with `streams.history_at` null: a stream first seen
  in a poll, and on load every stream that has never been fetched (all of
  them, the first time a neuron runs this version). Once per stream per
  central; another central (Settings) fetches again.
- **When**: on load (in the background), and in each poll right after its
  rows are stored, before the forecasts, so the first poll of a new neuron
  already forecasts from history. One run at a time; a call during a run
  gets one more run after it.
- **The call**: `limit=1000&since=<now − 1,000 h>`. Central observes hourly
  (`central/scheduler.py:76`), so that is the last ~41 days whether the route
  counts `limit` from `since` forward or back from now. At most 4 calls at a
  time.
- **The rows**: normalized exactly as poll rows (`observed_at`, else `ts`, in
  whole seconds; rows with no finite value, no time or another stream are
  dropped), then **insert or ignore, only rows older than the stream's
  newest polled row**. A backfilled row never triggers a prediction: only a
  poll's new row does, as in Lite. (A row newer than the last poll would
  otherwise be stored first, and the next poll's copy of it would not be
  new, so that stream would not be predicted for 11 h.)
- **Failures** never break the poll. A stream central doesn't know (404
  `Stream not found: <uuid>`, a stream deleted on central or a malformed
  uuid; `central` bc043d2) is done with no rows, and the others go on. Any
  other failure stops the run; the streams not fetched wait for the next run
  (the next poll or load). A **404 with any other detail** (FastAPI's `Not
  Found`) means the route is missing on this central: it is quiet (no
  warning) and remembered for a day (`meta.central_history.retryAt`), then
  asked again. (Before, one deleted stream failed first every day and held
  all the others with it.)
- **Shown**: Home's Central card has a History line ("Oct 16, 09:30 · 83
  streams, 81,234 rows", or "Not on this central (central 404: Not Found);
  next try …"); `status().central.history` = the last run `{at, url, streams,
  rows, left, error, retryAt}` and `needed` (streams with no history yet).

## Payload strings (parity verified)

Python's `str(float)` is not JavaScript's `String(n)` (`100.0` vs `100`,
`1e-05` vs `0.00001`, `1e+16` vs `10000000000000000`). `pyFloatStr` uses the
shortest round-trip digits (as both languages do) and Python's layout:
positional for `1e-4 ≤ |x| < 1e16`, else `d.ddde±XX`; `nan`, `inf`, `-0.0`.

`test/fixtures/central-parity.json` is generated inside the shipped Docker
image (`scripts/central-parity.py`, offline): 439 floats as raw bits with
Python's and numpy's `str`, and 4 payload hashes. The tests check every one.
Central stores the hash without checking it (`c/main.py:556-563`).

## Settings

`meta.central_url`, set under **Settings** on Home or by
`window.satori.setCentral(url)`. It must be `https://` (the page's CSP allows
only https). Empty means the default:

- a production build: `https://network.satorinet.io` (satorilib's default,
  `satorilib/src/satorilib/config/__init__.py:99`), or the build's
  `VITE_CENTRAL_URL` ([deploy.md](deploy.md#build-variables); the deployment at
  satori.satorinet.io and neuron.satorinet.io uses central2 for now);
- the dev server (`import.meta.env.DEV`): `https://central2.satorinet.io`, the
  dev central, so nobody writes to prod from a dev checkout.

Only a change here resets what belonged to the old central; a new build with
another default does not ([deploy.md](deploy.md#moving-to-the-production-central)).

Changing it registers with the new central at once and drops what belonged to
the old one: the pending predictions, the stream list, and the last poll and
submission. Another central has other stream uuids (central2's
`safetrade_soq` is not prod's), and central files an unknown uuid under its
`bitcoin` stream (`c/main.py:536-551`), so a queue from one central must not
go to another. A poll still running with the old central finishes first, so
its rows never land after the reset. The list refills with the next poll;
each uuid's observation history stays. The poll schedule stays. Nostr's
relay list and Base's config are read from the new central at once.

## Errors

- Every call has a 15 s timeout (`AbortSignal.timeout`), body included.
- A network error, a timeout or a 5xx is resent once, at once.
- A network failure is a `TypeError` in the browser. nginx's 429 and 502 pages
  carry no CORS header, so they look the same. Both are reported as "central
  unreachable" with the browser's message.
- Central's own errors carry `{detail}` and are shown as `central <status>: <detail>`.
- Register, poll and submit failures are logged to the console, stored in the
  status (last poll, last submission) and shown on Home. A local failure in a
  cycle (a database write) is logged with `console.error` and shown as the last
  poll's error. Nothing throws out of the schedule: the next timer is set
  before `next_poll_at` is saved, and a failed save is only logged.

## Deviations from Satori Lite, and why

| Deviation | Why |
|---|---|
| `meta.next_poll_at` is stored; on load a future time is kept, and a due (or missing, or more than 11 h ahead) one gets Lite's 5–30 min start jitter. | A tab reloads far more often than a Docker container restarts. Lite's "jitter after every start" would make each reload push the poll back (never polling if reloaded every few minutes); storing the time keeps the 11 h cadence. |
| **Poll now** (Home) and `window.satori.poll()` run a cycle at once; the next poll is then 11 h later. A second call while one runs returns the same run. | The owner reviews in the running app and agents drive it: neither should wait up to 30 min, or 11 h, to see a cycle. |
| Pending predictions live in the `predictions` table, so they survive a reload; Lite's queue is in memory. | The browser has no long-lived process; a queue lost on every reload would rarely be resent. |
| Pending predictions older than 2 × 11 h are dropped before a submission; Lite's queue has no cap. | Lite's queue is emptied by every restart; ours is not, so a central that refused every batch would grow it without end. Two polls' worth is enough to ride out one failed cycle. |
| Changing the central URL drops the pending queue and the stream list (see Settings). | Lite has one central per install; uuids differ between centrals. |
| Every call (register, challenge and login too) is resent once on a network error, a timeout or a 5xx. satorilib resends only through `_makeAuthenticatedCall`, when it raises (`server.py:231-268`): the observations GET and the predictions POST pass `raiseForStatus=False` (`server.py:1282,1325`), so there a 5xx answer is not resent, only a network error or a timeout. | One rule in one place (`call`). A 5xx that carries CORS headers comes from central itself and a second try is cheap; nginx's 502/429 have no CORS header and arrive as network errors anyway. |
| After a successful poll, anything pending is sent even if this cycle made no new prediction; Lite flushes only when it collected a new one (`start.py:4724`). | One rule ("send what is pending after each poll") is simpler, and a kept queue does not wait for the next new observation. |
| Login signs central's challenge UUID (`GET /auth/challenge`), not `str(time.time())` (`server.py:91`). | Central accepts any signed message today (`c/auth.py:45`); the challenge keeps working when central makes challenges single-use ([issue](../issues/central-login-replayable.md)). |
| A fresh login for each submission; no stored token, no refresh. | The token lives 1 h and the neuron submits every 11 h. |
| The observations GET sends no token; satorilib sends one through `_makeAuthenticatedCall` (`server.py:1322`). | Central does not ask for one (`c/main.py:292-293`), and the poll then never needs a login. |
| Register is not retried in a loop (Lite's `authWithCentral` backs off from 30 s up to 6 h, `start.py:4976-5006`). It runs again on the next load or a central URL change. | In practice Lite does not retry either: `checkin` swallows register errors (`server.py:405-414`) and `_getChallenge` falls back to a timestamp when central is down (`server.py:65-85`), so `checkin` almost never raises and the backoff almost never fires. |
| No per-prediction signature (step 1 signed each prediction locally). | Lite does not sign predictions; the login signature authenticates the batch. |
| The model is `bvar`/`bar1`/`naive` after namaste_club, not Lite's adapters; each target's spec is drawn from the identity and evolved after each poll. | [engine.md](engine.md#deviations-and-why) |
| Central's history is fetched once per stream (`/observations/history`, [above](#history-an-addition-beyond-lite)); Lite never asks for history. | The owner's direction (2026-10-15): a new neuron starts with data instead of from nothing ([../intent/engine.md](../intent/engine.md)). |
