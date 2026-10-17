# Health: is my neuron predicting, and is anything broken?

[← OVERVIEW](OVERVIEW.md) · intent: [../intent/ui.md](../intent/ui.md) · the approved
mockup: [home-mockup.html](home-mockup.html)

Home answers one question at a glance: is the neuron predicting every day on
its own, and is anything broken? A browser neuron only runs while Satori is
open, so being closed is normal and never shows as an error. The answer is
built from two things:

- an **activity log**: what the neuron did, kept in the database;
- the **current state**: central's, Base's and the relays' status, the
  storage and the install state, as the rest of the app already reads them.

`src/neuron/health.js` turns both into one object (pure, unit-tested with
fabricated logs). Home draws it, and agents read the same object:
`window.satori.health()` → `{ status, title, line, action, days, channels, feed, reasons }`.

This is local to the browser. Nothing new goes over the network, and Satori
Lite has no counterpart to follow: its dashboard shows raw state. The rules
reuse Lite's own cadence (an 11 h poll, a 5–30 min start jitter) for their
thresholds.

## The activity log

Migration 8 adds one table ([storage.md](storage.md#migrations)):

```
activity (id, at, until, kind, level, data, count, mkey)
```

`at` is when it happened (unix seconds). `until` is when a merged row last
changed (a session's heartbeat, a repeated failure). `level` is the feed's
icon: `ok`, `warn`, `bad` or `idle`. `data` is JSON. `count` is how many
identical events a row stands for, and `mkey` is the key they were merged on.
Rows older than 90 days are deleted at start and once a day.

| kind | level | data | when |
|---|---|---|---|
| `open` | `ok`, or `idle` when work was missed | `{ gap, missed }` | each page load, and each wake after the page did not run for 15 min (a closed lid, a frozen tab). `until` is a heartbeat, every 5 min |
| `central` | `ok` / `bad` | `{ streams, new, predicted, sent, accepted, pending, error?, login?, local?, caughtUp? }` | each cycle (poll and submit). `local`: the database or the engine failed, not central. `login`: central refused the login. `caughtUp`: the first good cycle after a session that missed work (the closed time, in seconds) |
| `history` | `ok` / `warn` | `{ streams, rows, error? }` | a history run that loaded streams or failed (not a central without the route) |
| `base` | `ok` sent, `warn` fixable skip, `idle` other skip, `bad` error | `{ round, hash?, games?, dropped?, skipped?, error? }` | each batch check that sent, skipped or failed, except "already predicted" and "waiting for the batch already sent". The same skip or error again is merged into its row (`count`, `until`) |
| `nostr` | `ok` | `{ published }` | each `_pred` a relay took, merged per hour |
| `wallet` | `ok` | `{ action, text }` | Delegate, Stop delegating, Claim, Send |
| `error` | `bad` | `{ where, message }` | an engine or database failure outside central's cycle (a relay stream's intake) |

Times, in `src/neuron/health.js`:

| Name | Value | Meaning |
|---|---|---|
| `CADENCE_S` | 11 h | Lite's poll interval |
| `JITTER_S` | 30 min | the most Lite's start jitter waits |
| `GRACE_S` | 1 h | slack for a slow cycle or a throttled tab |
| `WINDOW_S` | 12.5 h | `CADENCE_S + JITTER_S + GRACE_S`: the open time a good cycle may take after the last one |
| `FIRST_S` | 1.5 h | `JITTER_S + GRACE_S`: the open time the first good cycle may take |
| `HEARTBEAT_S` | 5 min | how often a session's `until` moves |
| `SLEEP_S` | 15 min | a heartbeat this late means the page did not run: a new session |

**Open time** is the time covered by the sessions (`open` rows, `at` to
`until`; the current one runs to now). Only open time counts against the
neuron: two days closed is not two days late.

A **good cycle** is a `central` row with no error that either had central
accept predictions or had nothing to send. A **failed cycle** is any other
`central` row.

A session **missed work** when a poll came due while Satori was not running:
the last good cycle before it, plus `CADENCE_S`, falls outside every session
and before this one (`missedBy`). The open row records it (`missed`, and
`gap`: how long it was closed).

## The status

There is exactly one status. Each problem is a **reason**, and the status is
the worst one: `bad` > `warn` > `idle` > `ok`.

- **ok** (predicting): central took predictions within `WINDOW_S` of open
  time. If the vault is delegated, Base has this round's batch or its
  check has not run yet. No channel is in error.
- **idle**: not predicting right now, for a calm reason. It is grey and never
  red.
  - *Was asleep*: a session missed work. It catches up on open (Lite's 5–30
    min jitter) and shows until the next normal cycle, which is the second
    good cycle after that session.
  - *Starting*: a new neuron before its first good cycle, within `FIRST_S`.
- **warn** (needs you): predictions go out, but something needs the person.
- **bad** (problem): predictions are failing.

### Reasons, in priority order

The action card shows the highest one that has an action, so there is at
most one card. Its button does the thing, or goes to the place it is done.

| # | Reason | Status | Channel | When | Button |
|---|---|---|---|---|---|
| 1 | `db-error` | bad | central | the last cycle failed locally (the database or the engine) | Reload |
| 2 | `login-refused` | bad | central | the last cycle's login was refused (after its one retry) | Open Settings (central) |
| 3 | `central-failing` | bad | central | the last 2 cycles failed | Try again (a poll) |
| 4 | `central-overdue` | bad | central | no good cycle within `WINDOW_S` of open time (`FIRST_S` with none yet) | Poll now |
| 5 | `base-failing` | bad | base | the batch check failed twice in a row while Base is in use (delegated, or a batch sent before) | Open Settings (Base) |
| 6 | `relays-down` | bad | network | streams are subscribed and every relay is down | Open Settings (relays) |
| 7 | `central-failed` | warn | central | the last cycle failed (once) | Try again |
| 8 | `backup` | warn | – | storage is not persistent and no backup is confirmed | Back up |
| 9 | `vault-mismatch` | warn | central | register's `vault_base_address` is another Base address than this vault's (the card shows both), or null (central has no vault for this identity); not when a central does not send it | Open Settings (keys) |
| 10 | `not-registered` | warn | central | registering failed | Reload |
| 11 | `delegate` | warn | base | not delegated, and the vault holds SATORI | Delegate |
| 12 | `gas-low` | warn | base | delegated, and the identity's ETH pays for under 7 batches | Add gas (Wallet) |
| 13 | `base-skipped` | warn | base | delegated, and this round's check skipped for a fixable reason (the gas ceiling; no game passed its simulation) | Open Settings (Base) / Open Wallet |
| 14 | `base-unreachable` | warn | base | the chain did not answer | Open Settings (Base) |
| 15 | `relay-down` | warn | network | streams are subscribed and a relay is down | Open Settings (relays) |
| 16 | `asleep` | idle | central | *Was asleep* (above) | Install, only when the browser offers it |
| 17 | `starting` | idle | central | *Starting* (above) | none |

**Backup confirmed** (`meta.backup_at`) is set when the vault's words are
confirmed in Create, given at Restore (also `setup({ vaultWords })`), brought
by a Dockerized Neuron import, or shown under Backup. The vault holds the
funds. A lost identity is replaced by a new one and a new delegation.

An action needing the vault (Delegate, Back up, and Home's Claim) opens one
inline passphrase prompt in place when the vault is locked, then does the
action.

### Title and line

The title is the central channel's word: *Predicting* (ok, or warn outside
central), *Retrying* (`central-failed`), *Starting*, *Was asleep*, *Not
predicting* (central bad). When Base or the network is the bad one, it is
*Base is failing* or *Network is down*. The line is the top reason's short
text, after "Central is fine." when central is fine. With no reason it is
"Sent 83 predictions 2 h ago · next in 9 h". Words appear only when
something needs them.

## The channels (chips)

Each is `{ state: ok | warn | bad | idle, text }`, the state from the
reasons above.

- **Central**: ok "83 sent 2 h ago"; idle "First poll in 12 min",
  "Catching up in 12 min"; warn "Last poll failed", "Vault mismatch",
  "Not registered"; bad "Database error", "Login refused", "2 failed in a
  row", "Nothing sent for 14 h".
- **Base**: ok "Round 20742 sent", "Round 20742 due"; idle "Not delegated"
  (no SATORI), "Delegated elsewhere", "Connecting…"; warn "Not delegated",
  "Gas: 3 batches", "Skipped: …", "Unreachable"; bad "Failed 3 times".
- **Network**: idle "No streams" (nothing subscribed); ok "2 relays"; warn
  "1 of 2 relays down"; bad "Relays down". A relay that is connecting
  counts as up.

## The day strip

Local days, newest last: 14 on the phone, 30 on a computer (`health().days`
has 30). For each day, the log's outcomes per channel (a merged row counts
on every day from `at` to `until`):

- a success: a good central cycle, a Base batch sent, a `_pred` published;
- a failure: a failed central cycle, a Base error or fixable skip, an engine
  or database error.

| Code | Means |
|---|---|
| `full` | predictions went out on every active channel that day (each channel with a failure also had a success) |
| `part` | some channels |
| `error` | only failures |
| `closed` | nothing went out and nothing failed: the app never ran that day (`ran: false`), or ran with nothing due |
| `before` | the day ended before the neuron began: an empty outlined cell, "Before this neuron", not a closed day |

The neuron began at its first session in the log (`activity.first()`, read
from the whole log, not only the rows loaded), or when its keys were made
(the record's `created`, [keys.md](keys.md#the-record)) when that is earlier.
Records from before `created` have only the log.

Today has an outline. Each day is `{ date: 'YYYY-MM-DD', code, ran, today }`.
The summary counts the neuron's own days: "12 of 14 full days"; a neuron
younger than the strip, "1 full day" on its first day, then "2 of 3 full
days". The legend shows "Before this neuron" only while such a day is shown.

## The feed

The log, newest first, 20 rows: `{ at, level, text }`. "Sent 83 predictions
to central", "Caught up: sent 83 predictions", "Central refused the batch:
central 401: Invalid signature", "Base batch for round 20742: 1 game", "Base
batch skipped: gas above the ceiling (×3)", "Published 3 forecasts to the
network", "Satori was closed for 2 d", "Delegated to this neuron". A
session that missed nothing is not shown.

## Verify

- `src/neuron/health.test.js`: every status and every reason from
  fabricated logs, the action priority, open time and missed work, the day
  codes, the chips and the feed.
- `src/neuron/activity.test.js`: sessions and their heartbeat, a wake after
  sleep, merges, the 90-day prune, caught up, the log's first session.
  `src/db/db.test.js`: the table. `src/ui/format.test.js`: the strip's
  summary.
- `e2e/home.spec.js`: the four states in Chrome with the stub central and a
  fake chain (idle from a seeded log); a new neuron (29 days before it,
  "0 full days", then "1 full day"); and the screenshots below.

## Live

2026-10-17, the dev server on :5180 against central2, a fresh browser
profile, no stubs: Create (the words confirmed) → Home *Starting* ("First
predictions in 18 min", every chip idle) → Poll now: 82 streams, central's
history for all 82 (81 on bvar), 82 of 82 accepted → *Predicting*, "Sent 82
predictions just now · next in 11 h"; Base idle (a new vault, no SATORI),
Network idle (nothing subscribed); nothing sent to prod.

Again after the day strip's `before` (2026-10-17 01:55, a fresh profile, set
up with new random words): *Starting* with 29 outlined days ("Sep 18: Before
this neuron") and today, "0 full days"; Poll now, 13 s: 82 of 82 accepted,
today full, "1 full day" on the phone and the computer; nothing sent to prod.

![Home live on central2 after the first poll](../screenshots/home-live-central2.png)

## Screenshots

From `e2e/home.spec.js` (`SHOTS=1 npx playwright test e2e/home.spec.js`):
each state on a phone (390 × 844, the first screen) and a computer (1280
wide), light and dark, `docs/screenshots/home-<state>-<phone|desktop>-<light|dark>.png`
for `ok`, `idle`, `warn` and `bad`, and `new` (a new neuron's first day).

<img src="../screenshots/home-ok-phone-light.png" alt="ok: predicting" width="240"> <img src="../screenshots/home-idle-phone-light.png" alt="idle: was asleep, caught up" width="240"> <img src="../screenshots/home-warn-phone-dark.png" alt="warn: Base needs one step" width="240"> <img src="../screenshots/home-bad-phone-dark.png" alt="bad: central refused two batches" width="240">

![ok on a computer](../screenshots/home-ok-desktop-light.png)

A new neuron after its first poll: the days before it are empty outlines,
not closed days.

<img src="../screenshots/home-new-phone-light.png" alt="a new neuron: 1 full day" width="240"> <img src="../screenshots/home-new-phone-dark.png" alt="a new neuron, dark" width="240">
