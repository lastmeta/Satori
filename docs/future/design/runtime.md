# Runtime (background execution)

[← Later steps](../README.md)

The Docker neuron is a process that runs forever and restarts itself
(`neuron/neuron-lite/start.py:102-118,5211-5228`). A browser neuron runs only
while a tab or installed PWA is open. The design treats being hidden, frozen,
discarded or closed as normal and makes up for it on return.

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
[base.md](../../design/base.md#the-daily-batch-the-identity-on-its-own): checking
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
- **service worker**: precaches the app shell and DuckDB wasm. No neuron logic.

## What the user sees

A status line: "Neuron active" / "sleeping since HH:MM, will catch up when
open"; last central batch, last Base batch and this round's state. Setup text:
keep a pinned desktop tab or install the app; on iPhone the neuron works only
while on screen.

## Also left (from the parked identity, storage and UI notes)

- **Keys in a worker.** The identity, the unlocked vault and the Nostr key
  live on the main thread today; move them (and signing) into the neuron
  worker, so no key reaches the page's context.
- **`navigator.storage.persist()`** on first run. The keys are in the same
  OPFS database as the data, so an eviction (Safari drops storage after 7 days
  without a visit) loses them too: the vault's 24 words, checked at setup, are
  the way back.
- **Hosting.** A static https host that can set response headers: the CSP
  (`csp.js`) must arrive as a header, on the page and on every worker script.
- Not planned: EIP-191 signing (no caller), ECDH peer encryption (only for
  Docker's engine IPC), Evrmore transaction signing ([chain.md](chain.md)).

## Not done

No silent-audio or WebRTC keep-alive tricks; no restart watchdogs; no
follower mirroring or command forwarding.

## Test before relying on it

- Playwright: close the leader; a follower becomes leader and runs the batch.
- Whether dedicated-worker timers in a hidden tab escape intensive throttling
  is not documented; measure drift on desktop and Android Chrome. Nothing above
  depends on sub-minute timing.
