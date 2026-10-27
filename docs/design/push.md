# The daily push

[← OVERVIEW](OVERVIEW.md)

The owner, 2026-10-27: the app works only while its tab is open, and a phone
can't keep a web page running. Push messages are the web's way to wake it once
a day, as a setting the person turns on or off. Built 2026-10-27, both steps of
the proposal at once (the owner: "do all of it").

## What the platform allows

- **Web Push** (the Push API + the Notifications API): a server sends a
  message to the browser's push service (Google's FCM for Chrome, Apple's for
  Safari, Mozilla's for Firefox); the browser wakes the app's service worker
  with a `push` event, even when the app is closed.
- **A notification each time.** Chrome subscribes only with
  `userVisibleOnly: true`, and Safari requires it too: every push must show a
  notification, or the browser shows a generic one and may drop the
  subscription.
- **iPhone**: only for a web app added to the Home Screen (iOS 16.4+); not in a
  Safari tab. Android Chrome, desktop Chrome, Edge and Firefox: in a tab too.
- **Permission** is asked only on a tap (Safari refuses it otherwise).
- **A short wake.** The service worker runs until the promise passed to
  `event.waitUntil` settles, and browsers stop it after a few minutes at most.
  It can't start DuckDB ([runtime.md](../plans/runtime.md#periodic-background-sync)):
  no database, so no stored data, models or keys, unless the app copies what it
  needs into IndexedDB first.
- **A server** must send the messages: the VAPID key pair (RFC 8292), the
  subscriptions, a daily job. A message with a payload is encrypted to the
  subscription's keys (RFC 8291); ours have none.

## The setting

**Settings › This device › Daily reminder**: Off and On, off by default
(`src/ui/settings.js`, `src/pwa/push.js`).

- **On**: asks for notification permission, subscribes
  (`pushManager.subscribe`, `userVisibleOnly`, the server's VAPID key from
  `GET /push/key`) and sends the subscription with the **player** and the
  device's time zone. The player is whom the chain is asked about: the alias
  (it sends the batch, and plays the Game when staked with it), or the wallet
  when it plays the Game by hand itself (`reminderPlayer`, `src/main.js`).
- **Off**: the server is told, the subscription dropped.
- The browser's subscription is the switch's truth. At each start, and when the
  player changes (Stake, Unstake, Automatic or By hand), the server is told it
  again.
- **Can't**: the dev server (no service worker), a browser without the Push
  API: "This browser can't wake Satori with a notification."; a Safari tab on
  iPhone or iPad: "add Satori to the Home Screen first". Permission refused:
  "Notifications are blocked for this site…".
- Agents: `setReminder(on)`, `reminder()` ([llms.txt](../../public/llms.txt)).

## The server

`push/` (`server.mjs` around `push.mjs`; Node's own modules, no npm), the
container `satori-push` on central's box, on the docker network the app's
nginx is on; that nginx passes `/push/` to it (`deploy/nginx.conf`, resolved
per request, so the app serves whether it is up or not). Same origin: the CSP
needs nothing new.

- `GET /push/key`, `POST /push/subscribe {subscription, player, tz, minute?}`
  (→ `{ minute }`),
  `POST /push/unsubscribe {endpoint}`; bodies up to 4 KB, at most 100,000
  subscriptions.
- Only the browsers' push services are taken as endpoints (FCM, Apple's,
  Mozilla's, Windows'): the server never posts to an address a page chose.
- **Each person's own time** (the owner, 2026-10-27: not everyone at once, and
  not while they sleep): the time of day they turned it on, sent as `minute`
  (of the local day, 0-1439) with that subscribe; the first is the next day.
  Telling the server again at a start sends none, and the kept one stays (a
  subscription that never had one takes the server's now). Settings says it:
  "Each day at 9:41 AM, …".
- Every minute: each subscription whose local time has reached its minute and
  that has had nothing that local day is due. One JSON-RPC batch reads the
  round (`getCurrentRound`) and each due player's `predictedStreamsCount` this
  round. A player with predictions gets nothing; one without gets a push. A
  chain read that fails is tried at the next tick.
- The push has **no payload** (so no message encryption, RFC 8291): VAPID
  (RFC 8292, an ES256 JWT for the push service's origin, 12 h), `TTL` 12 h.
  404 or 410: the subscription is deleted.
- Kept in its volume: `vapid.json` (the private key, made at first start; the
  public key is derived) and `subscriptions.json`.

## The wake

The service worker (`src/pwa/sw.js`, bundled with what it imports by the
build's plugin, `vite.config.js`) takes the push (`src/pwa/wake.js`) and always
shows one notification (tag `satori-daily`):

| The handoff says | It does | The notification |
|---|---|---|
| nothing (no handoff yet) | — | "Today's predictions aren't sent yet. Open the app to send them." |
| by hand | — | "Today's game is ready." (tap: the Game) |
| automatic, nothing staked with this app | — | the reminder |
| automatic, staked | the day's batch, as the app sends it | "Satori sent today's predictions (N games)." |
| … the round has them already | — | "Today's predictions are in." |
| … anything fails, the alias has a transaction pending, or the app holds the batch lock | — | the reminder |

**The batch** is the app's own `runBatch` (`src/neuron/base.js`): the streams
and their histories read from the chain, the engine's forecasts, the
contract's simulation, the max fee. None of it needs the database. Measured on
the fork: 6 s.

**The handoff** (IndexedDB `satori`/`app`, `push-handoff`), left by the app
after each Base check and when the play or the Base settings change
(`leave()`): the RPCs, the chain's config, the max fee, Automatic or By hand,
whether anything is staked with the alias, and the alias's secret, sealed with
this browser's non-extractable key as in the keys record
([keys.md](keys.md#at-rest)), or in hex where it keeps none. Switching to
another wallet drops it until that wallet's first check.

**One sender at a time**: the app works out and sends a batch under the Web
Lock `satori-batch`; the worker only takes it if it is free
(`ifAvailable`). It also leaves alone an alias with a transaction pending
(its 'pending' nonce above its 'latest'). What the worker sends it keeps in
`push-batch` (`base_pending_batch`, `base_last_batch`); the app takes it in at
its next check (`adopt`, `src/pwa/handoff.js`), and waits for that batch as for
its own.

**A tap** focuses the app's window (at the notification's page, by a message to
the page) or opens one.

## Not done

- **Periodic Background Sync**: Chromium only, the browser picks the times
  ([runtime.md](../plans/runtime.md#periodic-background-sync)).
- **A native app** (an APK through Capacitor and Android's WorkManager): the
  only daily background run with no notification, at the cost of a store
  listing and a second release process.
- The Satori Network's predictions and the relays still need the app open: the
  worker sends only the Satori contract's batch.
