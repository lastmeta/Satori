# Central

[← OVERVIEW](OVERVIEW.md)

The browser calls central directly with `fetch`. No proxy: central's CORS allows
any origin and any header (`central/src/main.py:62-69`, verified; a live
preflight on 2026-10-14 echoed `authorization, content-type, wallet-pubkey,
message, signature, vault-pubkey, nostr-pubkey, neuron-version`).

Base URL: `https://network.satorinet.io` (satorilib default,
`satorilib/src/satorilib/config/__init__.py:99-133`), overridable in settings
(dev: `https://central2.satorinet.io` or `http://localhost:8000`).

## Endpoints used in v1

| Call | Auth | Evidence | When |
|---|---|---|---|
| `POST /api/v1/auth/login` (headers `wallet-pubkey`, `message`, `signature`) → `{access_token, refresh_token, expires_in:3600, …}` | signature | `central/src/api/v1/endpoints/auth.py:21-86`; client `satorilib/src/satorilib/server/server.py:87-118` | on unlock, on expiry, on one 401 |
| `POST /api/v1/auth/refresh` (Bearer refresh) | JWT | `auth.py:89-133`; `server.py:120-140` | 5 min before expiry |
| `POST /api/v1/peer/register` (headers `wallet-pubkey`, `vault-pubkey`, `nostr-pubkey`, `neuron-version`) | none today | `central/src/main.py:705-800` | once per key set |
| `GET /api/v1/peer/relays` → `[{relay_url, nostr_pubkey, evr_address}]` | none | `central/src/api/v1/endpoints/peer.py:123-163` | reconcile |
| `GET /api/v1/peer/relay-config` → `{max_streams}` | none | `peer.py:164-172` | reconcile |
| `GET /api/v1/base/config` | none | `central/src/api/v1/endpoints/base.py:15-19` | boot, cached 1 h, bundled fallback |
| `GET /api/v1/observations/batch?limit=100` | none (client sends JWT anyway) | `central/src/main.py:292-341` | central-lite poll |
| `POST /api/v1/predictions/batch` | JWT | `central/src/main.py:438-602`; schema `central/src/models/schemas.py:72-113` | after each poll |
| `GET /api/v1/merkle/proof/{vaultEthAddress}` | none | `central/src/api/v1/endpoints/merkle.py:26-45` | Claim page |

`neuron-version` is sent as `browser-<semver>`.

The login `message` is a header, so it must be ASCII. Docker signs
`str(time.time())` (`server.py:91`). The browser instead signs a fresh UUID from
`GET /api/v1/auth/challenge` (`central/src/main.py:268-281`). Login accepts any
signed message today (`auth.py:45`), so this works now and keeps working once
central requires the challenge to be fresh and single-use
([issue](../issues/central-login-replayable.md)).

## Central-lite poll and predictions batch

Same as Docker (`neuron/neuron-lite/start.py:4766-4881`), minus the threads:

1. On a deadline (stored as `central_poll_due` in settings): GET
   observations batch. Central returns the latest observation per stream, only
   if under 48 h old (`central/src/main.py:292-330`).
2. Upsert each observation into `history` (keyed by `stream_uuid`, epoch) and
   stream metadata into `streams`.
3. For each stream with a new row, run the engine; collect
   `{stream_uuid, stream_name, value: t2, t1_value: t1, observed_at, hash}`.
   `hash = sha256(value + time)[:16]` exactly as `neuron/engine-lite/engine.py:1044-1106`
   builds it (port verified by a fixture).
4. One `POST /predictions/batch`.
5. Next deadline: now + 11 h. The first poll after a fresh install is jittered
   5-30 min, as Docker does, to spread load (`start.py:4776-4800`). Inferred:
   11 h exists to spread Docker fleets; keeping it costs nothing.

Note: central silently maps an unknown `stream_uuid` to the `bitcoin` stream
(`central/src/main.py:438-602`, per the central map). The browser only submits
uuids it received from the batch.

Whether central-lite predictions feed the Base merkle drop is not traced. It is
in v1 because it is two calls on top of the engine we need anyway.

## Dropped from Docker

- `/health` watchdog and `os._exit` restarts (`start.py:4884-4892`). nginx answers
  `/health` itself with no CORS header (`central/nginx.conf:58-62,142-146`), so a
  browser can't read it anyway. Status uses `GET /` (FastAPI, CORS-enabled).
- The 10-minute anti-reconnect delay (`start.py:4939-4947`).
- `setMiningMode` → `/worker/mining/mode/enable`, a route central does not have
  (`satorilib/src/satorilib/server/server.py:1814-1829`).
- Legacy challenge auth as a 5xx fallback (`server.py:230-270`): it only doubles
  load.
- ~90 other `server.py` methods for routes central-lite no longer serves.

Later, not v1: reward address (`peer.py:26-120`), `balance/get`, lender and
pool routes (`neuron/web/routes.py:1116-1245`).

## Tokens

Access and refresh tokens live in the neuron worker's memory. A reload logs in
again (one signature), which needs the identity unlocked or remembered.
