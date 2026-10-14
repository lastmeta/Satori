# Paid observations never parse through the fetch helper

**Status:** open · **Kind:** fixable flaw · **Fix in:** satorilib (`origin/base-upgrade`) · **Matters for:** paid streams (later)

## Precondition

Fetching the latest observation of a **paid** stream (freshness check,
backfill) instead of receiving it live.

## Finding (verified in origin client)

`parse_observation_event` decrypts a paid event and passes the plaintext to
`DatastreamObservation.from_json` (origin/base-upgrade
`client.py:918-940`). Paid content is only `str(value)`
(`satorilib/src/satorilib/satori_nostr/client.py:593`), so the result is `None`.
Only the live push path (`client.py:1643-1700`), which rebuilds seq/timestamp
from tags, works.

## Fix

In `parse_observation_event`, rebuild the observation from tags after
decrypting, as the live path does. The browser port will copy the live path.
