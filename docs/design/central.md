# Central

[← OVERVIEW](OVERVIEW.md)

The browser calls central directly with `fetch`. No proxy: central's CORS allows
any origin and any header (`central/src/main.py:62-69`, verified; a live
preflight on 2026-10-14 echoed `authorization, content-type, wallet-pubkey,
message, signature, vault-pubkey, nostr-pubkey, neuron-version`).

Base URL: `https://network.satorinet.io` (satorilib default,
`satorilib/src/satorilib/config/__init__.py:99-133`), overridable in settings
(dev: `https://central2.satorinet.io` or `http://localhost:8000`).

Central-lite is **earning-critical**, not a side path: its scored predictions
become `base_earnings` for the Base address derived from the registered vault
pubkey, which is what the merkle drop pays
([OVERVIEW](OVERVIEW.md#how-v1-earns-verified)).

## Endpoints used in v1

| Call | Auth | Evidence | When |
|---|---|---|---|
| `GET /api/v1/auth/challenge` → UUID | none | `central/src/main.py:268-281` | before each login |
| `POST /api/v1/auth/login` (headers `wallet-pubkey`, `message`, `signature`) → `{access_token, expires_in:3600, …}` | signature | `central/src/api/v1/endpoints/auth.py:21-86`; client `satorilib/src/satorilib/server/server.py:87-118` | before each predictions batch; once more on a 401 |
| `POST /api/v1/peer/register` (headers `wallet-pubkey`, `vault-pubkey`, `nostr-pubkey`, `neuron-version`) | none today | `central/src/main.py:705-800` | on first sign-in and whenever a key changes, with the JWT from a login (forward-compatible); shown on Status |
| `GET /api/v1/base/config` | none | `central/src/api/v1/endpoints/base.py:15-19` | boot, cached 1 h, bundled fallback |
| `GET /api/v1/observations/batch?limit=100` | none | `central/src/main.py:292-341` | central-lite poll |
| `POST /api/v1/predictions/batch` | JWT | `central/src/main.py:483-602`; schema `central/src/models/schemas.py:72-113` | after each poll |
| `GET /api/v1/merkle/root`, `GET /api/v1/merkle/proof/{vaultEthAddress}` | none | `central/src/api/v1/endpoints/merkle.py:26,45-58` | Claim page ([chain.md](chain.md#claims)) |

`neuron-version` is sent as `browser-<semver>`. `/peer/relays` and
`/peer/relay-config` are used only by Nostr parity ([transport.md](transport.md)).

The login `message` is a header, so it must be ASCII. Docker signs
`str(time.time())` (`server.py:91`). The browser signs a fresh challenge UUID.
Login accepts any signed message today (`auth.py:45`), so this works now and
keeps working once central requires the challenge to be fresh and single-use
([issue](../issues/central-login-replayable.md)).

**No refresh tokens.** The JWT lives 1 h (`auth.py:21-86`) and the only v1 call
that needs it runs every 11 h, so every batch would find a cached token expired.
Log in (one challenge, one signature), post, drop the token.

## Central-lite poll and predictions batch

Same as Docker (`neuron/neuron-lite/start.py:4766-4881`), minus the threads:

1. On a deadline (`central_poll_due` in settings): GET observations batch.
   Central returns the latest observation per stream, only if under 48 h old
   (`central/src/main.py:292-330`).
2. Insert each into `observations` with `provider_pubkey = 'central'` and
   `stream_name = stream_uuid`, so the engine has one read path; keep the
   stream's display name in `stream_names`.
3. For each stream with a new row, run the engine; collect
   `{stream_uuid, stream_name, value, t1_value, observed_at, hash}`.
4. Log in; one `POST /predictions/batch`; retry once on 401.
5. Next deadline: now + 11 h. Docker jitters the first poll 5-30 min after
   **every** process start (`start.py:4776-4779`); the browser does the same on
   every neuron-worker start. Inferred: 11 h exists to spread Docker fleets;
   keeping it costs nothing.

### Payload fields (verified, parity planned)

From `neuron/engine-lite/engine.py:1044-1106,1198-1202`:

- `value` = Python `str()` of the t2 numpy float (e.g. `'100.0'`, `'1e-05'`);
  `t1_value` likewise for t1.
- `observed_at` = Python `str()` of the **float Unix wall-clock time at
  prediction** (`datetimeToUnixTimestamp(now())`,
  `satorilib/src/satorilib/utils/time.py:10-12`), not the observation's time.
- `hash` = `sha256(value + observed_at)[:16]` over those two strings
  (`engine.py:1052-1058`).

JS number formatting differs from Python's (`100` vs `100.0`, exponent forms),
so the port needs a `pyFloatStr()` that mimics Python `repr` for floats. Byte
parity is **planned, not verified**: no fixture exists yet; one generated from
the Docker image must be checked in. Central stores the hash without checking
it (`central/src/main.py:567-574`), so a mismatch would be cosmetic, not fatal.

Note: central silently maps an unknown `stream_uuid` to the `bitcoin` stream
(`central/src/main.py:483-602`, per the central map). The browser only submits
uuids it received from the batch.

## Dropped from Docker

- `/health` watchdog and `os._exit` restarts (`start.py:4884-4892`). Status uses
  `GET /` (FastAPI, CORS-enabled); nginx answers `/health` itself without CORS
  (`central/nginx.conf:58-62,142-146`).
- `/auth/refresh` and its timer (`satorilib/src/satorilib/server/server.py:120-140`).
- The 10-minute anti-reconnect delay (`start.py:4939-4947`).
- `setMiningMode` → `/worker/mining/mode/enable`, a route central does not have
  (`server.py:1814-1829`).
- Legacy challenge auth as a 5xx fallback (`server.py:230-270`): it only doubles
  load.
- ~90 other `server.py` methods for routes central-lite no longer serves.

Later, not v1: reward address (`peer.py:26-120`), `balance/get`, lender and
pool routes (`neuron/web/routes.py:1116-1245`).
