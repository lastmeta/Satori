# Wallets and their aliases

[← OVERVIEW](OVERVIEW.md)

Who the person is and what the app signs with (owner, 2026-10-23,
[intent](../intent/INTENT.md)). [keys.md](keys.md) is how the keys are made
and sealed.

## The words

| Word | What it is |
|---|---|
| **wallet** | The person's key: their identity, and it holds the funds. Either **in the app**, sealed with their passphrase, or **connected**: kept in an outside wallet (MetaMask or another) that the app asks. |
| **alias** | The wallet's automated signing key. Derived from a wallet in the app, random for a connected one ([derived keys](#derived-keys)), kept on this device and used freely, so the app works with nobody present. It acts for the wallet with the Satori Service, on the relays and in the daily Base batch. App-level: people meet it only on the Wallet tab (its gas, and its private key for the rare case funds were sent to it). |
| **Nostr key** | The third key: made like the alias, signs the app's Nostr events ([nostr.md](nostr.md)). |

These are the only names, in the UI, the code, the stored record,
`window.satori`, the Satori Service's protocol and the docs. A wallet in the
app's list comes with its alias, its Nostr key and its own data.

## How they relate

```
app ── 1…n wallets ── exactly 1 active at a time
wallet ──── 1 alias (derived from a wallet in the app)
       + Nostr key
       + its own database
wallet = sealed in the app (passphrase; Unlock / Lock)
       | connected (an EIP-1193 wallet that asks the person each time)
```

- **The wallet is the identity.** The SATORI, the stake, the claims, the
  reward address and the referral are the wallet's. The alias only acts for
  it. Whoever holds the wallet holds everything; whoever holds only the alias
  can predict, not move funds.
- **The wallet authorizes its alias**, twice: on chain, Stake sets the
  alias's fee to 0, has it accept only this wallet, and stakes the wallet
  with it (`hub.delegatePredictionPower(alias)`, [base.md](base.md)); with
  the Satori Service, the wallet signs a **link** to its alias (below).
- **The alias and the Nostr key are derived from a wallet in the app** ([derived
  keys](#derived-keys)): the wallet brought back from its words, on any
  device, gives the same alias (still staked with) and the same Nostr key
  (the same streams). They are kept for good; they are replaced only when the
  device is compromised (owner, 2026-10-26).
- **One at a time.** The app runs one wallet: the Satori Service, the relays
  and the Base batch are one alias's. Another wallet is another peer with its
  own streams, so wallets share nothing but the app's code.
- **Models do not change**: each wallet's engine builds its models from its
  own data, as now ([engine.md](engine.md)).

## Bringing a wallet in

Each way adds a wallet to the list (the first one too):

| Way | Wallet | Alias | Nostr key |
|---|---|---|---|
| **Create** | new words, sealed with a new passphrase | new | new |
| **Import** | its 12 or 24 words or its private key, sealed with a new passphrase | its words or private key when given, else new | the nsec or hex when given, else new |
| **Import Docker files** | the wallet file and its password, sealed with a new passphrase | the alias file | the Nostr file when given, else new |
| **Connect a wallet** | not in the app: the outside wallet's address | new | new |

Docker files: an install from before the rename keeps `wallet.yaml` (the
alias) and `vault.yaml` (the wallet); a newer one writes `alias.yaml` and
`wallet.yaml`. Satori Lite tells them apart by `alias.yaml`: present, the new
layout; absent, the older one. The app's import takes the alias file and the
wallet file by their place in the form, whichever layout they come from.

A connected wallet has no passphrase, no Unlock and no Lock: the outside
wallet asks the person for each action that needs the wallet:

| Needs the wallet | Wallet in the app | Connected wallet |
|---|---|---|
| Stake, Unstake | Unlock | the outside wallet asks |
| Claim, the airdrop's and merkle's claims | Unlock | the outside wallet asks |
| Send ETH or SATORI | the passphrase each time | the outside wallet asks |
| The referral, payment channels' open and top-up | Unlock | the outside wallet asks |
| The link to its alias (below) | at setup, else at the next Unlock | once, at connect |
| Showing the alias's and the Nostr key's backups | the passphrase each time | a signature of a fixed text |
| The Satori Service's login, predictions, the Base batch, Nostr events, channel vouchers | the alias and the Nostr key, unattended | the same |

## Derived keys

(Owner, 2026-10-26.) One backup, the wallet's: the alias and the Nostr key
come from it, by the standard derivations, so moving to another device or
importing the wallet brings them back with nothing else to keep.

- **From a wallet in the app** (Create, Import by its 24 words or by its
  private key, Import Docker files, an encrypted backup): this app's 24 words
  are the private key's own bytes ([keys.md](keys.md#one-key-one-secret)), so
  words and private key are one source. Its BIP-39 seed (no extra
  passphrase) is the BIP-32 master:
  - the alias: `m/44'/60'/1'/0'/i'`, fully hardened (a leaked alias gives
    nothing above it; no wallet app uses this path for its own accounts);
  - the Nostr key: `m/44'/1237'/i'/0/0` (NIP-06: a Nostr app given these
    words finds the same key).
  `i` is 0; another index is another alias or Nostr key, when one is wanted.
- **A connected wallet: random keys** (the owner, 2026-10-31, after the
  external audit). It never shows its words, and a signature is no secret: a
  wallet signs the same text the same way on any site, so another site could
  ask for it and make the same keys (they were derived that way until then).
  So they are random, made at Connect, and the wallet signs only the link. A
  new device gets a new alias and Nostr key: Stake again there, or keep
  Backup's copies.
  [Restoring](#restoring-a-connected-wallets-keys) puts backed-up ones back.
- **The record says where they came from**: `from: 'wallet' | 'random'`. Settings › Backup shows every key: the wallet's
  words, the alias's and the Nostr key's private keys (derived: "no need to
  back them up, but you can see them here"; random: "back them up too").
- **Earlier records** (random keys): an in-app wallet's next Unlock derives
  its keys and replaces them, with a new link. The old ones are kept as the
  record's `retired` keys ([keys are never lost](#keys-are-never-lost)). The wallet then shows as staked elsewhere until Stake (one
  transaction). A connected wallet's stay random.
- **Import takes the wallet only**: the alias, Nostr and Docker alias files
  are no longer asked for (the owner: no keeping old keys).

## An alias for each job

(The owner, 2026-11-04.) An alias does two jobs: the Satori Service knows the
app by it (off-chain scoring: log in, register, predictions, the reward
address), and the Satori contract does too (on-chain scoring: the wallet
stakes with it, it sends the daily batch and the push's, paying their gas).
The app's own alias does both by default. The **Alias** cards of the Service and Contract pages give either
job another alias, imported by its private key or 24 words: a Docker
install's (Lite's dashboard shows its alias key), or another app's. The same
key may do both jobs; the app's own then does neither.

- **The record**: `offchain: { alias: hex, link }` and `onchain: { alias:
  hex, link }`, each absent while the app's own alias does that job. The
  wallet signs each one's link (the passphrase in the form for a wallet in the
  app; a connected wallet's app asks), as it signs its own alias's.
- **The Satori Service is told** (its alias reports, central
  `docs/design/alias-and-wallet.md`): one alias for both jobs registers once,
  `offchain,onchain`; two register each for its job, `offchain` and
  `onchain`, each with its link, both `reported_by` app.
- **The Satori contract's alias changed**: the stake is still with the old
  one, so the Wallet tab asks to stake again (one transaction), and the new
  one needs Base ETH for its gas. The push's handoff is dropped until the app
  leaves the new one's.
- **Refused**: the wallet's own key, and the alias the job has now. Giving the
  app's own alias, or **Use this app's alias**, hands the job back. A key that
  stops doing a job stays as an [earlier key](#keys-are-never-lost).
- **Backup** shows each imported one. The encrypted backup file does not carry
  them yet: restoring a file means importing them again.
- The page reloads after a change, so everything starts again with it.
- Agents: `setServiceAlias(alias, { passphrase })`, `setContractAlias(alias,
  { passphrase })`, either with null for the app's own;
  `status().serviceAlias` and `status().contractAlias` are their addresses.

## Keys are never lost

(The owner, 2026-10-28: an upgrade replaced an older wallet's random alias
and dropped it, and the ETH preloaded to it was stranded.) A key, once in
the record, stays: `storeKeys`, the one place the record is written, passes
every new record through `keepRetired`, which keeps any alias or Nostr key
the stored record held and the new one doesn't, as `retired: [{ alias,
nostr, at }]`. It is sealed at rest with the others, goes in the encrypted
backup file and comes back with it, and **Settings › Backup › Earlier keys**
(shown when there are any) gives each earlier alias's address and private
key and its Nostr key, so whatever was sent to one can be moved. Any later
change of keys (an upgrade, a rotation) gets this for free.

## Restoring a connected wallet's keys

(The owner, 2026-10-31.) Rare, so not on Setup: **Settings › Restore keys**, a
card shown only for a connected wallet (an in-app wallet's keys come from its
words). It names the wallet in use, one only, and takes the alias's private
key or 24 words and the Nostr key's nsec or hex; one left empty is kept.
The wallet app signs the new link, which is the confirmation, so nothing
changes if it says no or isn't in this browser. The keys replaced go to
[`retired`](#keys-are-never-lost), and the app starts again with the restored
ones (the alias's stake, its streams). An agent:
`restoreKeys({ alias, nostr })`, or `restoreKeys({ backup, passphrase })` with
this wallet's `exportBackup()` file, which brings its earlier keys too.

## A whole backup

For an agent whose browser is wiped between visits (owner, 2026-11-01:
Satori is a daily game, public/llms.txt "It's a daily game"), `exportBackup`
seals everything a wiped browser can't get back, and `setup({ passphrase,
backup })` restores it before the neuron starts (`src/neuron/transfer.js`):
the keys, the Service's models (`model_specs`), the settings in `KEPT`, the
streams followed with their `_pred` place, and the Game's favorites. Agents
only: no screen has it. A file from another chain's build brings its keys
only. Models for another Satori Service stay out: its uuids differ.

A connected wallet's file also has its address and link, so `recordFromBackup`
makes the record with no wallet app and no new signature, and the app predicts
as it does when that app isn't in the browser. `exportBackup` doesn't ask the
wallet app either, unlike Settings › Backup: nothing is shown, and an agent
may not have one. The models also go alone (`exportModels`, `importModels`),
not secret, for an agent that restores by the wallet's key.

## The Satori Service: register, login and the link

A request in the **current form** carries `alias-pubkey`. One without it is
an older neuron's, read the older way (`wallet-pubkey` is then its alias and
`vault-pubkey` its wallet, unproven) until those neurons are gone. Nothing
else tells the forms apart.

- **Register** (`POST /api/v1/peer/register`): `alias-pubkey`, `nostr-pubkey`,
  `neuron-version`, and the wallet's link: `wallet-link` (the message, below,
  base64 of its UTF-8, since a header holds one line) and `wallet-signature`.
  The answer names the wallet's Base address the network pays
  (`wallet_address`), or null when no link is held.
- **Login**: `alias-pubkey`, `message`, `signature` (EIP-191 by the alias).
- **The link** is an EIP-191 (`personal_sign`) signature by the wallet of:

  ```
  Satori: link this alias to my wallet
  alias: 0x<the alias's address, EIP-55>
  wallet: 0x<the wallet's address, EIP-55>
  issued: <unix seconds>
  ```

  The network recovers the signer's public key from the signature (so a
  connected wallet, which never hands over a public key, links the same way)
  and accepts the link when: the recovered address is the message's
  `wallet`; the message's `alias` is the address of the request's
  `alias-pubkey`; `issued` is not more than 5 minutes ahead of its clock; and
  `issued` is not older than the link it holds for that wallet, if any. A
  wallet is linked to one alias at a time: an accepted link moves it from any
  other alias. The network keeps the message and the signature, so the link
  can be checked again later. A register without a link registers the alias
  alone; its answer names the wallet an older neuron registered for that
  alias, if any, so peers moving over keep being paid until they link (owner,
  2026-10-23), else null.
- The app makes the link when the wallet is in hand (Create, Restore, Import,
  Connect; for a stored wallet without one, its next Unlock), keeps it with
  its keys, and sends it with every register.
- **Link again** (2026-10-24): when the network pays this wallet elsewhere or
  not at all (`wallet-mismatch`, often because another app linked the same
  wallet later, so this app's link is "older than the one held"), Home's card
  offers **Link this wallet**: the wallet signs a fresh link (issued now: the
  passphrase, or the wallet app's approval), kept with the keys and sent with
  a register at once (`satori.relink()`).

## Several wallets

- **A database each.** The first wallet keeps the first file
  (`opfs://satori-mvp.duckdb`); each later one gets `opfs://satori-<n>.duckdb`.
  Everything a wallet has learned and done is in its own file, so no query
  can mix two, and removing one is deleting its file.
- **The list** is in IndexedDB (database `satori`, store `app`, key
  `wallets`), the same site storage as the databases (it goes when they go,
  and storage kept keeps it): `{ v: 1, active, wallets: [{ id, file, address
  }] }`. IndexedDB because a page can write it in every browser (an OPFS
  file needs `createWritable`, which Safari lacks). No list means one wallet
  in the first file. Written only by the one tab that runs the app
  ([pwa.md](pwa.md#one-neuron)). `src/wallets.js`.
- **Switching = lock, set the active wallet, reload.** The page's end takes
  the old wallet's keys, workers, sockets and timers with it, and the last
  visit's Home (a snapshot on this device) is dropped so the next one is not
  shown under another wallet. Just before the reload the page lets the
  one-tab lock go ([pwa.md](pwa.md#one-neuron)): the next page opens another
  wallet's file, and a browser that keeps the old page's lock a while (seen
  on a phone, 2026-10-24) would otherwise show "Satori is open in another tab".
- **On the Wallet tab**, a **Wallets** card: each wallet's address, the
  active one marked; Switch on the others; Remove on the others (it asks
  first, says its words are the way back, then takes its entry off the list
  and sets its database file aside, `….removed-<time>`, never deleted: its
  keys may include ones the words can't bring back, [keys are never
  lost](#keys-are-never-lost)); **Add a wallet**: a new entry, active, so the reload opens
  Setup's four ways on an empty database. Setup then names the other wallets
  to switch back to. A wallet whose address is already in the list is
  refused at setup ("This wallet is already in this app").
- **The order is the person's** (the owner, 2026-11-02): a row dragged up or
  down reorders the Wallets card (a mouse drags at once; a finger presses and
  holds first, so a swipe still scrolls), and the list keeps that order for
  the next visit. A new wallet goes last. `src/ui/drag.js`, `withOrder`.
- **For agents**: `wallets()` → `{ active, wallets: [{ id, address, name, nameAuto, active }] }`, `nameWallet(name)`, `orderWallets(ids)`,
  `addWallet()`, `switchWallet(id)` (both reload the page), `removeWallet(id)`.
- **Preferences stay per wallet** (the Satori Service's URL, the Base RPC,
  the max fee, the relays), in each database, as now; the theme and the
  other device choices are the device's.

## A connected wallet

As the dapp connects one (`contract/satori-ui/src/hooks/useWallet.ts`): the
wallets installed in this browser announce themselves (EIP-6963; else the
injected `window.ethereum`), the person picks one, `eth_requestAccounts`
gives its address, and before a transaction the wallet is switched to Base
Sepolia (added with the chain's EIP-3085 fields when it answers 4902). The
app uses viem over the wallet's EIP-1193 provider (the dapp uses ethers).

**On a phone**, or any browser with no wallet in it, the dapp's other two
paths, ported as they are (`useWallet.ts` `getOrInitMetaMask`,
`getOrInitWalletConnect`; the same package versions):

- **MetaMask** (MetaMask Connect, `@metamask/connect-evm`): the page stays
  where it is and talks to the MetaMask app over MetaMask's own relay; the
  phone switches to MetaMask only to approve, then comes back. On a
  computer it shows a code to scan with the phone. Analytics off; no
  EIP-6963 announcement of its own.
- **Other wallet** (WalletConnect, `@walletconnect/ethereum-provider` with its
  QR modal and wallet list): Rainbow, Trust, Coinbase and the rest, with the
  Satori project id the dapp uses (`VITE_WALLETCONNECT_PROJECT_ID`).

Both keep their session in this browser (their own local storage), so each
start restores it without asking; a session that has ended (removed in the
wallet app, storage cleared) shows as "The link to <name> has ended" with
**Reconnect**, which must give back the same account. Their libraries load
only when one is used. A relay must reach this page's origin, so neither
works on a private address (a LAN IP, localhost): said so, as the dapp does.

- **Connect** (Setup's fourth way, `src/keys/connect.js`, `src/keys/relay.js`):
  one button per wallet found in the browser ("Connect MetaMask"); with none
  found, as the dapp: "MetaMask" (opens the app to approve) and "Other
  wallet" (WalletConnect). Connecting makes the alias and the Nostr key (random: [derived
  keys](#derived-keys)), and the wallet signs the link to the alias once
  (`personal_sign`, checked: it must recover to the wallet's address). Nothing is encrypted and there is no
  passphrase.
- **The record**: `wallet: { kind: 'connected', address, rdns, name }` (the
  wallet's EIP-6963 id and name, to find it again; `injected` for a plain
  `window.ethereum`; `metamask-connect` or `walletconnect` for the phone
  paths), and the link. No secret of the wallet's is ever in the
  app.
- **Each start** finds the same wallet again by its id. Not found (another
  browser, the extension removed): the app still predicts, and an action
  that needs the wallet says "<name> isn't in this browser".
- **Each action that needs the wallet** goes to the wallet app, which asks
  the person: Stake and Unstake (the wallet's transactions), Claim, Send
  (after the review; no passphrase), the referral, a channel's open (its
  permit is EIP-712, `eth_signTypedData_v4`). Before each signature the app
  asks the wallet for its accounts; on another account it says "<name> is on
  another account: choose 0x… in it". Transactions are sent by the wallet
  (`eth_sendTransaction`) with the app's gas limit and fee fields; the app
  then waits for the receipt as for its own.
- **No Unlock, no Lock** for it: Settings › Keys shows "Connected: <name>";
  the inline Unlock prompts never open. The alias's and the Nostr key's
  (the wallet's own words stay in the wallet app; in Backup) are each shown
  after the wallet signs a fixed text ("Satori: show this app's keys",
  the wallet's address, the time), checked like the link.
- **For agents**: `connectWallets()` → the wallets found (`[{ rdns, name }]`),
  `connect(rdns)` on Setup; `status().walletKind` is `'sealed'` or
  `'connected'`. An agent drives a connected wallet only where the wallet
  app approves.

## Steps

- **A. The words**: alias and wallet everywhere; "neuron" leaves the UI; the
  alias appears only on the Wallet tab.
- **A2. The link and the current form**: the Satori Service accepts both
  forms and the link (central `base-upgrade`); the app, satorilib and Satori
  Lite send the current form.
- **Names** (the owner, 2026-10-30): the wallet in use can be named (the Wallet tab's
  Name card; `name` on its entry in the list, so this device only). The Wallets list
  shows each name under its address (small); the app bar shows the one in use by name, else
  its short address, as muted text left of Share (the owner, 2026-10-30), and a tap
  opens the Wallet tab. On a phone narrower than 440 px it hides while the wallet is
  unlocked: Lock and its countdown take its room. A wallet holding a special key
  with no name of its own takes the key's ("Admin", "Appoint", "Safe owner", "Dev fee 3", "Splitter authority";
  `nameAuto`), and drops it when it
  no longer holds the key; a name the person saves always wins.
- **B. Several wallets**: the list, a file each, the switch, Add and Remove (2026-10-23).
- **C. A connected wallet**: an injected EIP-1193 provider (EIP-6963 when
  several), the link at connect, the outside wallet asked for each action
  (2026-10-23); on a phone, MetaMask Connect and WalletConnect, as the dapp
  (2026-10-24).
- **D. Derived keys** (2026-10-26): the alias and the Nostr key from a
  wallet in the app; the keys at rest sealed with this device's key where the browser
  keeps one ([keys.md](keys.md#at-rest)).
- **Later**: shared preferences.
