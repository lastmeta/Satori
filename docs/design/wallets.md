# Wallets and their aliases

[← OVERVIEW](OVERVIEW.md)

Who the person is and what the app signs with (owner, 2026-10-23,
[intent](../intent/INTENT.md)). [keys.md](keys.md) is how the keys are made
and sealed.

## The words

| Word | What it is |
|---|---|
| **wallet** | The person's key: their identity, and it holds the funds. Either **in the app**, sealed with their passphrase, or **connected**: kept in an outside wallet (MetaMask or another) that the app asks. |
| **alias** | The wallet's automated signing key. The app makes it (random), keeps it unencrypted and uses it freely, so the app works with nobody present. It acts for the wallet with the Satori Network, on the relays and in the daily Base batch. App-level: people meet it only on the Wallet tab (its gas, and its private key for the rare case funds were sent to it). |
| **Nostr key** | The third key: random, unencrypted, signs the app's Nostr events ([nostr.md](nostr.md)). |

These are the only names, in the UI, the code, the stored record,
`window.satori`, the Satori Network's protocol and the docs. A wallet in the
app's list comes with its alias, its Nostr key and its own data.

## How they relate

```
app ── 1…n wallets ── exactly 1 active at a time
wallet ──── 1 alias (made by the app, replaceable)
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
  the Satori Network, the wallet signs a **link** to its alias (below).
- **The alias is random**, made with the wallet's entry in the app, never
  derived. A wallet brought back from its words alone gets a new alias and
  signs a new link; on chain it shows as staked with another address until
  the person Unstakes and Stakes again.
- **One at a time.** The app runs one wallet: the Satori Network, the relays
  and the Base batch are one alias's. Another wallet is another peer with its
  own streams, so wallets share nothing but the app's code.
- **Models do not change**: each wallet's engine builds its models from its
  own data, as now ([engine.md](engine.md)).

## Bringing a wallet in

Each way adds a wallet to the list (the first one too):

| Way | Wallet | Alias | Nostr key |
|---|---|---|---|
| **Create** | new words, sealed with a new passphrase | new | new |
| **Restore from words** | its 24 words, sealed with a new passphrase | its words when given, else new | the nsec or hex when given, else new |
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
| The Satori Network's login, predictions, the Base batch, Nostr events, channel vouchers | the alias and the Nostr key, unattended | the same |

## The Satori Network: register, login and the link

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
  shown under another wallet.
- **On the Wallet tab**, a **Wallets** card: each wallet's address, the
  active one marked; Switch on the others; Remove on the others (it asks
  first, says its words are its only backup, then deletes its database file
  and its entry); **Add a wallet**: a new entry, active, so the reload opens
  Setup's four ways on an empty database. Setup then names the other wallets
  to switch back to. A wallet whose address is already in the list is
  refused at setup ("This wallet is already in this app").
- **For agents**: `wallets()` → `{ active, wallets: [{ id, address, active }] }`,
  `addWallet()`, `switchWallet(id)` (both reload the page), `removeWallet(id)`.
- **Preferences stay per wallet** (the Satori Network's URL, the Base RPC,
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
  wallet" (WalletConnect). Connecting makes the alias and the Nostr key, and the
  wallet signs the link to the alias once (`personal_sign`, checked: it must
  recover to the wallet's address). Nothing is encrypted and there is no
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
  the inline Unlock prompts never open. Backup offers the alias's and the
  Nostr key's (the wallet's own words stay in the wallet app), each shown
  after the wallet signs a fixed text ("Satori: show this app's keys",
  the wallet's address, the time), checked like the link.
- **For agents**: `connectWallets()` → the wallets found (`[{ rdns, name }]`),
  `connect(rdns)` on Setup; `status().walletKind` is `'sealed'` or
  `'connected'`. An agent drives a connected wallet only where the wallet
  app approves.

## Steps

- **A. The words**: alias and wallet everywhere; "neuron" leaves the UI; the
  alias appears only on the Wallet tab.
- **A2. The link and the current form**: the Satori Network accepts both
  forms and the link (central `base-upgrade`); the app, satorilib and Satori
  Lite send the current form.
- **B. Several wallets**: the list, a file each, the switch, Add and Remove (2026-10-23).
- **C. A connected wallet**: an injected EIP-1193 provider (EIP-6963 when
  several), the link at connect, the outside wallet asked for each action
  (2026-10-23); on a phone, MetaMask Connect and WalletConnect, as the dapp
  (2026-10-24).
- **Later**: replacing the alias on purpose (a new alias, a new link, Unstake
  and Stake again; the network then sees a new peer with new streams);
  shared preferences.
