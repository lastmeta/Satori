# Accounts: a vault, its alias, and several of them

[← OVERVIEW](OVERVIEW.md)

The domain of who the person is and what the app signs with. Set by the owner
on 2026-10-23 ([intent](../intent/INTENT.md)); [keys.md](keys.md) is how the
keys are made and sealed today, which this builds on. Only the words are built so
far (step A below).

## The words

| Word | What it is | Replaces |
|---|---|---|
| **vault** | The person's true identity. The key only they have, and it holds the funds. Either **in the app**, sealed with their passphrase, or **connected**: kept outside, in a wallet they connect (MetaMask or another). | "vault" (the app's sealed one only) |
| **alias** | The vault's automated signing key. The app makes it (random), keeps it unencrypted and has full use of it, so it signs without anyone present. Replaceable. It is the vault's alias: on chain, in central and on the relays it acts for the vault. | "identity" |
| **Nostr key** | The account's third key: random, unencrypted, signs its Nostr events. As today ([nostr.md](nostr.md)). | unchanged |
| **account** | One vault with its alias, its Nostr key and its own data. What a person had as "a neuron". The app's UI says **wallet** for it ("Create a wallet", "Wallets"). | "a neuron" |

"Identity" in code, in the stored record (`keys.identity`) and in
`window.satori` stays as it is, as "delegate" stays under "staking": the
words people read say alias; an agent reads `identity` and `llms.txt` says
that it is the alias.

## How they relate

```
app ── 1…n accounts ── exactly 1 active at a time
account = vault ──── 1 alias        (the alias is the vault's: one at a time, replaceable)
        + Nostr key
        + its own database           (everything it has learned and done)
vault = sealed in the app            (passphrase; Unlock / Lock)
      | connected                    (an EIP-1193 wallet; it asks the person each time)
```

- **The vault is the identity.** Everything of value is the vault's: the
  SATORI, the stake, the claims, the reward address, the referral. The alias
  only acts for it. A person who has the vault has the account; one who has
  only the alias (the browser's storage) can predict but not move funds.
- **The vault authorizes its alias** on chain: Stake sets the alias's fee to 0,
  has it accept only this vault as a delegator, and stakes the vault with it
  (`hub.delegatePredictionPower(alias)`, [base.md](base.md)). That is what ties
  the two together on chain; the app also keeps them together in the account's
  record.
- **The alias is random**, made when the account is made, and never derived.
  (Deriving it from the vault's key would let the words give it back, but a
  connected wallet has no secret to derive from, and a signature is not a
  safe seed: some wallets don't sign deterministically. Not decided; the
  alias stays random until a reason says otherwise.) An account restored from
  its vault's words alone gets a new alias; the old one, if the vault is
  staked with it, shows as "staked with another" ([base.md](base.md)) until
  the person Unstakes and Stakes again.
- **One at a time.** The app runs one account: central, the relays and the
  Base batch are one alias's. Another account is a different peer to central
  (its own `wallet-pubkey`), with its own streams. So nothing is shared
  between accounts but the app's code, and their data is kept apart.
- **Models do not change.** Each account's engine builds its models from its
  own data exactly as now ([engine.md](engine.md)); there are not "models
  for several neurons". What multiplies is the keys and the data around them.

## Bringing a vault in

Every way adds an account (the first one too):

| Way | Vault | Alias | Nostr key |
|---|---|---|---|
| **Create** | new words, sealed with a new passphrase | new, random | new, random |
| **Restore from words** | the 24 words, sealed with a new passphrase | the alias's words when given, else new | the nsec or hex when given, else new |
| **Import Docker files** | `vault.yaml` + its password, sealed with a new passphrase | `wallet.yaml` | `nostr.yaml` when given, else new |
| **Connect a wallet** (new) | not in the app: the wallet's address; its public key is recovered once from a signature the wallet makes of a fixed text ("Satori: use this wallet as my vault", the address in it), because central's register wants `vault-pubkey` | new, random | new, random |

A connected vault has no passphrase, no Unlock and no Lock: the app asks the
wallet each time a vault action needs a signature, and the wallet asks the
person. What needs the vault, today and then:

| Vault action | App vault | Connected vault |
|---|---|---|
| Stake, Unstake (the vault's transactions) | Unlock; signed in the app | the wallet asks (a Stake is two: the referral, if held, then the stake) |
| Claim (`hub.claim`), the airdrop's and merkle's claims | Unlock | the wallet asks |
| Send ETH or SATORI | passphrase each time | the wallet asks |
| Referral, payment channels' open and top-up ([market.md](market.md)) | Unlock | the wallet asks |
| Backup of the alias and the Nostr key (the vault's words only for an app vault) | passphrase each time | a wallet signature of a fixed text stands for the passphrase |
| Central's login, predictions, the daily Base batch, the Nostr events, the channels' vouchers | the alias and the Nostr key, unattended | the same |

So the unattended work never needs the vault: a connected vault can be
closed, locked away or on a phone, and the app still predicts. The wallet is
asked only for what moves value or proves ownership.

## Several accounts

- **A database each.** The first account keeps today's file
  (`opfs://satori-mvp.duckdb`), so an existing install changes by nothing and
  copies nothing. Each later account gets its own file
  (`opfs://satori-<n>.duckdb`). Central assigns streams per alias, and
  predictions, the activity log, the track record, the market's channels and
  the keys record are all one account's: a file each is the whole separation,
  with no `account` column to forget in any query, and removing an account is
  deleting its file. The cost is that another account downloads its own
  history; it is the other peer's history anyway.
- **The account list** is one small file beside them, `satori-accounts.json`
  in the same OPFS (the same storage lifetime as the databases): `{ v, active,
  accounts: [{ id, file, vault (the address), label }] }`. No file means one
  account in `satori-mvp.duckdb`. Written by the tab that runs the app (there
  is only ever one, [pwa.md](pwa.md#one-neuron)).
- **Switching = lock, set the active account, reload.** Everything in memory
  of the old account (its keys, workers, sockets, timers) is gone with the
  page, so nothing needs a teardown path and nothing of one account can reach
  another. The switch is a list in Settings (and on Setup): label, vault
  address, a mark on the active one; "Add a wallet" opens Setup's four ways
  and adds an account; "Remove" asks first, says to back up, then deletes the
  file and the entry.
- **Preferences stay in each account's own database** (central URL, Base RPC,
  max fee, relays), as now. A person who changed the RPC sets it again for
  another account; nothing moves. A shared set is an easy later change.
- A vault already present in the app (same address) is not added twice.

## What changes in the code, by part

| Part | Change |
|---|---|
| Words (A) | UI, `llms.txt`, docs: alias for identity; wallet for the account |
| `src/keys` (C) | the record gains `vault.kind: 'sealed' \| 'connected'` (`v: 2`; a `v: 1` record reads as sealed); a connected vault stores its address and public key and nothing secret; `loadKeys`, `unlockVault`, `backupKeys` follow the kind |
| `src/chain` (C) | the vault side of every write goes through a **vault signer** with two forms: sealed (signs the digest here, as now) and connected (hands the transaction to the wallet: `eth_sendTransaction` with the app's own fee fields, then the app's receipt wait as before); simulate-first, the fee ceiling and one-at-a-time stay |
| `src/db/opfs.js`, `src/main.js` boot (B) | open the active account's file; read the list first; reload on switch |
| `src/central` (C) | register's `vault-pubkey` from the stored public key, as now |
| Settings, Setup, Wallet (B, C) | the switch list; the fourth way "Connect a wallet"; a connected vault shows "Connected: 0x…" in place of Unlock/Lock |

## Steps

Stair-steps, the smallest working slice each ([plans](../plans/README.md)):

- **A. The words.** Identity becomes alias in what people read; "Create a
  wallet"; "neuron" leaves the UI (done 2026-10-23). Nothing stored changes.
- **B. Several accounts.** The list, a file each, the switch, Add and Remove,
  on the sealed vault only. The first account is untouched.
- **C. A connected vault.** The injected provider (EIP-1193, found through
  EIP-6963 when several are installed), the connect flow with the one
  signature, the connected signer, and the wallet asked for each vault action.
- **Later:** replacing the alias (a new random alias: Unstake, make it, Stake
  again; central then sees a new peer with new streams, so it is deliberate,
  not automatic), a shared set of preferences, WalletConnect for a phone's
  external wallet.

## Open (owner)

1. **What to call an account in the app.** Written as "wallet" because the
   owner said "Create a wallet" and "connect your wallet"; but the alias is a
   wallet too. "Account" is the alternative.
2. **Phones.** An injected provider reaches a wallet's own in-app browser or a
   desktop extension, not a phone's external wallet app opened from the
   installed app. WalletConnect does that, through a relay service and a
   project id from a third party. Wanted now, or after C?
3. **The alias after a restore.** A new random alias and a re-stake, as above;
   or keep the alias's words as part of every backup (they already are
   offered: Backup shows both).
4. **Replacing the alias** as its own step, with the central consequence said
   to the person before it is done.
