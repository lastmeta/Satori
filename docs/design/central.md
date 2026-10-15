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
poll ─▶ GET observations/batch ─▶ store (insert or ignore) ─▶ forecast streams with a new row
     ─▶ queue {value: t2, t1_value: t1, observed_at, hash} ─▶ login (identity) ─▶ POST predictions/batch
```

Short names: `start.py` = `neuron/neuron-lite/start.py`; `engine.py` =
`neuron/engine-lite/engine.py`; `server.py` =
`satorilib/src/satorilib/server/server.py`; `c/main.py` =
`central/src/main.py`; `c/auth.py` = `central/src/api/v1/endpoints/auth.py`;
`data_helper.py` and `stream_store.py` are in `neuron/engine-lite/satoriengine/`.

## What Satori Lite does, and what the browser does

| Step | Satori Lite | Browser (`src/central/`, `src/neuron/`) |
|---|---|---|
| Register | On every start, `authWithCentral` (`start.py:4976-5006`) reads the vault's address and `publicKey` from `vault.yaml` without decrypting it (`start.py:4637-4667`) and calls `checkin` → `POST /api/v1/peer/register` with headers `wallet-pubkey` (identity), `vault-pubkey`, optional `nostr-pubkey`, `neuron-version` (`v3.2.13`); no body, no token, 10 s timeout; only when there is a vault pubkey; a failure is only logged (`server.py:384-434`). | The same on every page load, with `neuron-version: browser-<package version>`. Skipped when `vault.yaml` has no plain `publicKey`. The result is shown, never retried in a loop. |
| Central's side | Creates the peer, or for a known identity sets the vault only if none is stored yet; a vault that conflicts with another peer is silently dropped (`vault_address: null`); an identity conflict is a 409 (`c/main.py:705-838`). | Compares the returned `vault_address` with ours and shows a **vault mismatch** (central has another vault, or none). |
| Schedule | First poll after `random.randint(300, 1800)` s (`start.py:4777-4779`), then `sleep(11 h)` after every poll, whatever the result (`start.py:4785-4876`). | Same numbers. `meta.next_poll_at` is stored, so a reload keeps the schedule (see Deviations). **Poll now** runs a cycle at once. |
| Poll | `GET /api/v1/observations/batch?limit=100` (`server.py:1304-1377`). Central returns each stream's latest observation if under 48 h old (`c/main.py:292-341`). `value` and `observed_at` are strings. | Same call, no token (central needs none). |
| Store | `value` = float; epoch = `observed_at`, falling back to `ts` (`data_helper.py:40-93`), truncated to whole seconds (`engine.py:669-673`); `INSERT OR IGNORE` on `(stream_uuid, epoch)` (`stream_store.py:48-56,150-170`); the stream's name/meta are upserted (`server.py:1334-1358`). | Same rule into `observations (stream_uuid, ts, value)`, primary key `(stream_uuid, ts)`; `streams (uuid, name, meta)`. Rows with no stream, no finite value or no time are dropped. |
| Which streams | Every stream in the batch; a model predicts only when its stream got a **newly inserted** row (`engine.py:695-712`, test at `:707`). | Same: `addObservations` returns the streams that got a new row; only those are forecast. |
| Forecast | `t1` = one step ahead; `t2` = forecast again with `t1` appended, falling back to `t1` (`engine.py:1153-1186`). | `forecast(points) → {model, t1, t2} \| null` (`src/engine/`). Step 3's model is a least-squares line over the last 20 observations by step (`ols-20`); step 4 replaces it. |
| Payload | `{stream_uuid, stream_name, value: str(t2), t1_value: str(t1), observed_at: str(time.time() at prediction), hash: sha256(value + observed_at)[:16]}` (`engine.py:1044-1106,1188-1206`). | Byte-identical: `pyFloatStr` mimics Python's `str(float)`; checked against a fixture made in the Docker image (below). |
| Queue | `collectAndSubmitPredictions` right after the poll (`start.py:4693-4736`, called at `:4870`); `flushPredictionQueue` keeps the whole queue when `successful == 0` or the call failed, and clears it otherwise (`engine.py:432-454`). | Predictions are stored with `status = 'pending'`; after every successful poll all pending ones are sent; on `successful > 0` all are marked `sent`, otherwise they stay pending for the next cycle. |
| Submit | Log in (`POST /api/v1/auth/login`, headers `wallet-pubkey`, `message`, `signature` by the **identity**; `server.py:87-118`), then `POST /api/v1/predictions/batch` with `Authorization: Bearer`, body `{"predictions": [...]}`; on a 401 log in again and retry once (`server.py:170-230`, retry at `:210`). Timeouts 10–15 s. | Same, with one fresh login per submission. Timeouts 15 s. |

Not used (dropped from Lite): the `checkinCheck` watchdog and restarts
(`start.py:4883-4892`), `/auth/refresh` and its timer (`server.py:120-140`), the
10-minute reconnect delay (`start.py:4902-4908`), `setMiningMode` (a route
central no longer has), the reward address, stake and pool routes, and about 90
other `server.py` methods for routes central-lite does not serve.

## Endpoints

| Call | Auth | Central | When |
|---|---|---|---|
| `POST /api/v1/peer/register` (headers `wallet-pubkey`, `vault-pubkey`, `neuron-version`) → `{success, peer_id, wallet_address, vault_address, nostr_pubkey, message}` | none | `c/main.py:705-838` | every page load; again when the central URL changes |
| `GET /api/v1/observations/batch?limit=100` → `[{id, observed_at, value, hash, stream_id, stream: {uuid, name, meta, …}, ts, stream_uuid}]` | none | `c/main.py:292-341` | each poll |
| `GET /api/v1/auth/challenge` → `{challenge}` (a UUID) | none | `c/main.py:268-281` | before each login |
| `POST /api/v1/auth/login` (headers `wallet-pubkey`, `message`, `signature`) → `{access_token, expires_in: 3600, …}` | signature | `c/auth.py:21-86` | before each submission, once more on a 401 |
| `POST /api/v1/predictions/batch` → `{total_submitted, successful, failed, prediction_ids, errors}` | Bearer | `c/main.py:483-602`; schema `central/src/models/schemas.py:92-113` | right after each poll, when anything is pending |

Central silently maps an unknown `stream_uuid` to its `bitcoin` stream
(`c/main.py:536-551`), so the browser only submits uuids it received.

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
  `satorilib/src/satorilib/config/__init__.py:99`);
- the dev server (`import.meta.env.DEV`): `https://central2.satorinet.io`, the
  dev central, so nobody writes to prod from a dev checkout.

Changing it registers with the new central at once; the poll schedule stays.

## Errors

- Every call has a 15 s timeout (`AbortSignal.timeout`).
- A network failure is a `TypeError` in the browser. nginx's 429 and 502 pages
  carry no CORS header, so they look the same. Both are reported as "central
  unreachable" with the browser's message.
- Central's own errors carry `{detail}` and are shown as `central <status>: <detail>`.
- Register, poll and submit failures are logged to the console, stored in the
  status (last poll, last submission) and shown on Home. Nothing throws out of
  the schedule.

## Deviations from Satori Lite, and why

| Deviation | Why |
|---|---|
| `meta.next_poll_at` is stored; on load a future time is kept, and a due (or missing, or more than 11 h ahead) one gets Lite's 5–30 min start jitter. | A tab reloads far more often than a Docker container restarts. Lite's "jitter after every start" would make each reload push the poll back (never polling if reloaded every few minutes); storing the time keeps the 11 h cadence. |
| **Poll now** (Home) and `window.satori.poll()` run a cycle at once; the next poll is then 11 h later. A second call while one runs returns the same run. | The owner reviews in the running app and agents drive it: neither should wait up to 30 min, or 11 h, to see a cycle. |
| Pending predictions live in the `predictions` table, so they survive a reload; Lite's queue is in memory. | The browser has no long-lived process; a queue lost on every reload would rarely be resent. |
| After a successful poll, anything pending is sent even if this cycle made no new prediction; Lite flushes only when it collected a new one (`start.py:4724`). | One rule ("send what is pending after each poll") is simpler, and a kept queue does not wait for the next new observation. |
| Login signs central's challenge UUID (`GET /auth/challenge`), not `str(time.time())` (`server.py:91`). | Central accepts any signed message today (`c/auth.py:45`); the challenge keeps working when central makes challenges single-use ([issue](../future/issues/central-login-replayable.md)). |
| A fresh login for each submission; no stored token, no refresh. | The token lives 1 h and the neuron submits every 11 h. |
| The observations GET sends no token; satorilib sends one through `_makeAuthenticatedCall` (`server.py:1322`). | Central does not ask for one (`c/main.py:292-293`), and the poll then never needs a login. |
| Register is not retried in a loop (Lite's `authWithCentral` backs off from 30 s up to 6 h, `start.py:4976-5006`). It runs again on the next load or a central URL change. | The register call itself is only logged in Lite too (`server.py:405-414`); the backoff guards the challenge GET, which the browser does not need for register. |
| No `nostr-pubkey` header yet. | Nostr is step 5. |
| No per-prediction signature (step 1 signed each prediction locally). | Lite does not sign predictions; the login signature authenticates the batch. |
| The model is `ols-20` (a least-squares line by step), not Lite's adapters. | Step 4 brings the engine. |
