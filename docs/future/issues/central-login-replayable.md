# Central JWT login accepts any old signed message

**Status:** open · **Kind:** fixable flaw · **Fix in:** central

## Precondition

An attacker obtains one `(wallet-pubkey, message, signature)` header set from a
past login: proxy or server logs, a browser extension, devtools capture. With it
they can mint JWTs for that wallet indefinitely.

## Finding (verified)

`POST /api/v1/auth/login` checks only that the signature verifies
(`central/src/api/v1/endpoints/auth.py:21-49`, verify at :45). No freshness, no
single use. Docker signs `str(time.time())`
(`satorilib/src/satorilib/server/server.py:87-118`). The legacy path already
does it right: a UUID challenge stored 60 s in Redis and consumed on use
(`central/src/main.py:117-208`, consumed at :153-159; issued at :268-281).

## Fix

Require `message` to be an unconsumed `/auth/challenge` UUID (preferred), or a
timestamp within ±5 min plus a replay cache. The browser app already signs a
challenge UUID ([central.md](../../design/central.md)), so it needs no change.
Docker neurons would need the matching satorilib change before enforcement.
