# Daily push (a proposal, 2026-10-27)

[← Roadmap](README.md)

The owner, 2026-10-27: the app works only while its tab is open, and a phone
can't keep a web page running. Push messages are the web's way to wake it once
a day, and they should be a setting the person turns on or off.

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
  It can't start DuckDB ([runtime.md](runtime.md#periodic-background-sync)):
  no database, so no stored data, models or keys, unless the app copies what it
  needs into IndexedDB first.
- **A server** must send the messages: the VAPID key pair (RFC 8292), the
  subscriptions, a daily job. Messages are encrypted to the subscription's
  keys (RFC 8291); the push service sees only that one was sent.

## Step 1: a daily reminder (proposed first)

**Settings › This device › Daily reminder**: a switch, off by default.

- **On**: asks for notification permission, subscribes
  (`pushManager.subscribe` with the server's VAPID public key) and sends the
  subscription to the server, with the player's address (the alias if staked
  with it, else the wallet: [base.md](../design/base.md#the-game)) and the
  device's time zone.
- **Off**: unsubscribes, and tells the server to drop the subscription.
- **Refused permission**: the switch stays off; "Notifications are blocked for
  this site in the browser's settings."
- **iPhone in a Safari tab**: "On iPhone, add Satori to the Home Screen first",
  beside the Install advice (`platform.js`).
- An agent call: `setReminder(on)`, and its state in `state()`
  ([llms.txt](../../public/llms.txt)).

**The server**, a small container `satori-push` on central's box, behind the
same nginx-proxy at `https://app.satorinet.io/push/` (same origin, so the CSP's
`connect-src` needs nothing new):

- `POST /push/subscribe {subscription, player, tz}`, `POST /push/unsubscribe {endpoint}`.
- Stores each subscription (SQLite in a volume).
- Hourly, for each subscription whose local time is 9:00: reads the player's
  last batch round on Base (one multicall for all players); if this round has
  none yet, sends the push. A player who has played today gets nothing.
- A subscription the push service answers 404 or 410 is deleted.

**The service worker** (`src/pwa/sw.js`) shows the notification: "Satori:
today's predictions aren't sent yet. Open the app to send them." Tapping it
opens (or focuses) the app; the app's catch-up pass
([runtime.md](runtime.md#catch-up-pass)) sends the day's batch, as it does
whenever it opens. By hand, the Game opens instead: "Today's game is ready."

**Cost**: one container, one daily job, no change to keys or the batch. The
person still opens the app, once a day, by tapping a notification.

## Step 2: wake and send (later, if step 1 isn't enough)

The push wakes the service worker, which sends the day's batch itself, with no
tap.

- When the app is open, it leaves a **handoff** in IndexedDB: the alias's
  secret sealed with the device key ([keys.md](../design/keys.md#at-rest); the
  service worker can use the same non-extractable key), and the next round's
  batch already worked out (its games and directions), with the RPC and the max
  fee.
- On a push: the service worker opens the seal, signs and sends that batch,
  and shows "Satori sent today's predictions."; it records the hash in IndexedDB,
  and the app picks it up as a pending batch at its next open.
- The forecasts are only as fresh as the last time the app was open. A handoff
  older than a day is not sent: the reminder is shown instead.
- Not when played by hand (the person plays in the Game), and never with the
  wallet (it's sealed with the passphrase).
- Cost: viem and the signing code bundled into `sw.js`; the alias usable from
  the service worker, not only the page.

## Not proposed

- **Periodic Background Sync**: Chromium only, the browser picks the times
  ([runtime.md](runtime.md#periodic-background-sync)).
- **A native app** (an APK through Capacitor and Android's WorkManager): the
  only true daily background run with no notification, but a store listing and
  a second release process. Revisit if step 2 isn't enough.
