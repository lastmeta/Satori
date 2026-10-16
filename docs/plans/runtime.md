# Runtime (background execution)

[← Roadmap](README.md)

The Docker neuron is a process that runs forever and restarts itself
(`neuron/neuron-lite/start.py:102-118,5211-5228`). A browser neuron runs only
while a tab or installed PWA is open. The design treats being hidden, frozen,
discarded or closed as normal and makes up for it on return.

Done: the installable app ([../design/pwa.md](../design/pwa.md)): the
manifest, the service worker (precaches the page and DuckDB's wasm and
worker), Install, Update, and `navigator.storage.persist()` after setup and on
each load until kept, shown on Home. The one-tab Web Lock also holds between
an app window and a tab.

## What the platform allows (docs, 2026-10)

- Visible tab: timers run normally.
- Chrome, hidden > 5 min and silent: timers wake about once a minute
  (intensive throttling).
- Chrome Energy Saver may **freeze** a hidden tab, and may **discard** it under
  memory pressure. A tab is not frozen while it holds a Web Lock that blocks
  another tab's request (developer.chrome.com/blog/freezing-on-energy-saver), so
  the leader is exempt only while a follower tab is queued.
- iOS Safari and iOS PWAs suspend JavaScript within seconds of backgrounding.
- Service workers are killed when idle; they cannot host the neuron loop.

Docker's v1-relevant cadences are 11 h and 24 h (`start.py:1257,4785`), so a
one-minute tick is enough. "Runs while closed" is inherent and not offered.

## Scheduling: deadlines, not intervals

| Job | Due | Docker equivalent |
|---|---|---|
| Base stream refresh | each tick while delegated | replaces `start.py:453-543` |
| central-lite poll | +11 h; first 5-30 min after each worker start | `start.py:4766-4800` |
| Base daily batch | current UTC round has no batch on chain | `start.py:1256-1281` (was last + 24 h) |

Deadlines live in `settings`. One `setTimeout` loop in the neuron worker wakes
at most every 60 s and runs whatever is due. The batch rule is in
[base.md](../design/base.md#the-daily-batch-the-identity-on-its-own): checking
`predictedStreamsCount` each tick means a tab open at any time during a round
can earn that round, and catching up can never submit twice in one round.

## Catch-up pass

On worker start, `visibilitychange` → visible, the Page Lifecycle `resume`
event and `online`: run every job that is due, in table order.

## One neuron per browser

- On load, each tab probes with
  `navigator.locks.request('satori-neuron', {ifAvailable:true}, cb)`. Granted →
  this tab is the leader: spawn the neuron worker and hold the lock until close.
  `null` → follower.
- A follower shows "Satori is running in another tab" and nothing else, and
  makes a second, **queued** request without `ifAvailable`. When that grant
  arrives the leader has gone, and the follower promotes itself. Never `steal`.
  (With `ifAvailable` alone nothing queues and nothing takes over: MDN
  `LockManager.request`.)
- Only the leader opens the OPFS database.
- No SharedWorker: DuckDB's `AsyncDuckDB` spawns its own nested Worker, which
  SharedWorkers cannot do in Chrome or Safari (browser-compat-data
  `api/Worker.json` worker_support), and Android Chrome lacks SharedWorker
  before 148.

## Workers

- **neuron worker** (dedicated): keys, scheduler, engine, fetch/viem; spawns
  DuckDB's worker.
- **service worker**: built ([../design/pwa.md](../design/pwa.md)): precaches
  the app shell and DuckDB's wasm. No neuron logic.

## Periodic Background Sync

Not used, and not planned for the neuron loop. `periodicsync` is Chromium
only (Chrome, Edge, Android; not Firefox or Safari), fires only for an
installed app with site engagement, at intervals the browser sets from that
engagement (often a day or more; only on a network the device has used
before), and runs in the service worker, which cannot start DuckDB's own
worker (a service worker cannot create workers), so it could not open the
database or the keys. At most it could warm caches; the 11 h poll and the
daily batch stay with an open window.

## What the user sees

A status line: "Neuron active" / "sleeping since HH:MM, will catch up when
open"; last central batch, last Base batch and this round's state. Setup text:
keep a pinned desktop tab; on iPhone the neuron works only while on screen.
(Install Satori is on Setup and Home already.)

## Also left (from the parked identity, storage and UI notes)

- **Keys in a worker.** The identity, the unlocked vault and the Nostr key
  live on the main thread today; move them (and signing) into the neuron
  worker, so no key reaches the page's context.
- **Hosting.** A static https host that can set response headers: the CSP
  (`csp.js`) must arrive as a header, on the page and on every worker script
  (`/sw.js` too), `.wasm` as `application/wasm`, and `/sw.js` and `/` not
  cached for long ([../design/pwa.md](../design/pwa.md#csp-and-hosting)).
  Persistent storage is asked for, but a browser may refuse it: the vault's
  24 words, checked at setup, stay the way back.
- Not planned: ECDH peer encryption (only for Docker's engine IPC), anything
  on Evrmore (Base only). Central's login is EIP-191 since 2026-10-16
  ([../design/central.md](../design/central.md#login-signature)).

## Not done

No silent-audio or WebRTC keep-alive tricks; no restart watchdogs; no
follower mirroring or command forwarding.

## Test before relying on it

- Playwright: close the leader; a follower becomes leader and runs the batch.
- Whether dedicated-worker timers in a hidden tab escape intensive throttling
  is not documented; measure drift on desktop and Android Chrome. Nothing above
  depends on sub-minute timing.
