# Runtime (background execution)

[← OVERVIEW](OVERVIEW.md)

The Docker neuron is a process that runs forever and restarts itself
(`neuron/neuron-lite/start.py:102-118,5211-5228`). A browser neuron runs only
while a tab or installed PWA is open. The design treats being hidden, frozen,
discarded or closed as normal and makes up for it on return.

## What the platform allows (docs, 2026-10)

- Visible tab: timers run normally.
- Chrome, hidden > 5 min and silent: timers wake about once a minute
  (intensive throttling). WebSockets stay open.
- Chrome Energy Saver may **freeze** a hidden tab (timers, sockets' callbacks,
  promises all stop), and may **discard** it under memory pressure.
- iOS Safari and iOS PWAs suspend JavaScript within seconds of backgrounding.
- Service workers are killed when idle; they cannot host the neuron loop.
  Periodic Background Sync is Chromium-only with browser-chosen intervals.

Sources: developer.chrome.com (timer-throttling-in-chrome-88,
freezing-on-energy-saver, page-lifecycle-api).

Docker's cadences are 60 s, hourly, 6-11 h and 24 h
(`start.py:290,1257,3888,4785,4885`), so a one-minute tick is enough. What the
browser cannot give is "runs while closed". That is inherent.

## Scheduling: deadlines, not intervals

Every recurring job stores its next due time in `settings`:

| Job | Due | Docker equivalent |
|---|---|---|
| relay reconcile | +1 h | `start.py:200-302` |
| central-lite poll | +11 h (first: +5-30 min) | `start.py:4766-4800` |
| Base daily batch | last submit + 24 h | `start.py:1256-1281` |
| NIP-65 publish | +24 h | `start.py:370-389` |
| JWT refresh | expiry − 5 min | `satorilib/src/satorilib/server/server.py:120-140` |

One `setTimeout` loop in the neuron worker wakes at most every 60 s and runs
whatever is due. Intake is event-driven (WebSocket messages).

## Catch-up pass

Runs on worker start, on `visibilitychange` → visible, on the Page Lifecycle
`resume` event and on `online`:

1. Reconnect relays; resubscribe with `since` = last seen per relay.
2. Re-login if the JWT expired.
3. Run every job whose deadline has passed, in table order.

Because the batch checks `predictedStreamsCount` on chain first
([chain.md](chain.md#daily-prediction-batch)), catching up can never submit twice
in one round.

## One neuron per browser

- The tab that wins `navigator.locks.request('satori-neuron', {ifAvailable:true})`
  spawns the neuron worker and holds the lock until it closes. Never `steal`.
- Other tabs are followers: they read state over a `BroadcastChannel` and show
  "running in another tab"; their commands are forwarded to the leader. When the
  leader closes, a queued follower takes the lock and starts.
- Only the leader opens the OPFS database ([storage.md](storage.md)).
- SharedWorker is not used: not dependable on Chrome Android.

## Workers

- **neuron worker** (dedicated): DuckDB, keys, sockets, scheduler, engine.
  The engine is cheap enough to run inline; a separate engine worker is added
  only if hundreds of streams make it necessary.
- **service worker**: precaches the app shell and DuckDB wasm. No neuron logic.

## What the user sees

A status line: "Neuron active" / "sleeping since HH:MM, will catch up when
open" / "running in another tab"; last observation, last `_pred`, last Base
batch and next due. Recommended setup text: keep a pinned desktop tab or
install the app; on iPhone the neuron works only while on screen.

## Not done

No silent-audio or WebRTC keep-alive tricks (they defeat the browser's power
management); no Docker-style restart watchdogs.

## Unverified, test before relying on it

Whether dedicated-worker timers in a hidden tab escape intensive throttling.
Not documented; measure drift with Playwright on desktop and Android Chrome.
Nothing above depends on sub-minute timing.
