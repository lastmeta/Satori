# Questions for the owner

Open questions the code can't settle on its own. Each says what the app does
today, so nothing waits on an answer.

1. **The token hook on D6, until D7.** A staked vault that receives SATORI
   in a transaction sent with a bare gas estimate can't unstake (Panic
   0x11), and anyone can cause it with 1 wei. The root fix is on the
   contracts' `humble` branch (86e2bdb3) and ships with D7, which goes before
   the central flip (decided 2026-10-19, below). Still open: is the interim
   rewards UUPS upgrade on D6 (tested on the fork) wanted before D7? Until
   then the app offers staking as advice with the risk said, and shows a
   stake out of sync
   ([../issues/token-hook-gas-estimate.md](../issues/token-hook-gas-estimate.md)).
2. **Prod central's Base and merkle routes.** `network.satorinet.io` answers
   404 for `/api/v1/base/config` and `/api/v1/merkle/proof/…`; central2 serves
   both. A build defaults to prod, so its merkle claim says the route is
   missing and the Base addresses are the bundled ones. Deploy those routers
   to prod? ([../issues/central-prod-missing-base-routes.md](../issues/central-prod-missing-base-routes.md))
3. **A wss relay.** Central lists only `ws://satorian.satorinet.io:7777`, which
   an https page can't open, so a deployed app has no Nostr until a `wss://`
   relay is listed (TLS in front of satorian, and central listing it). Who
   sets it up, and where? ([../issues/relays-not-wss.md](../issues/relays-not-wss.md))
4. **Key derivation for new neurons.** Today one 32-byte secret is at once
   the private key and the BIP39 entropy of the 24 words, with no HD path
   (satorilib's scheme). A neuron moving from Docker keeps the same keys and
   Base addresses from its words, so this stays for every existing key. The
   open question is whether **new** neurons should use the standard BIP39
   seed → BIP32 path (`m/44'/60'/0'/0/0` for the vault), so the vault's words
   open the same account in MetaMask or any Ethereum wallet. Today a user
   gets there with the private key Backup shows (`0x…`, "Import account").
   - *For:* the words alone recover the vault in any wallet; it is what users
     of Base wallets expect.
   - *Against:* two schemes forever: the record must say which one each key
     uses, and Restore from words must ask (the same words give different
     addresses under each, and nothing tells them apart); a new neuron's
     words would not open in the Dockerized Neuron (fine under "migrate in,
     never back"); one more dependency (`@scure/bip32`, from the
     `@noble`/`@scure` author already used here).
   - *Today:* the old scheme for all keys; nothing changes until you decide.

## Resolved

- **D7 before the central flip.** Decided 2026-10-19: **yes.** Deploy D7
  (it carries the token-hook fix, `humble` 86e2bdb3) before prod central
  moves to `base-upgrade`, so the flip happens once, on D7's addresses and a
  fresh reward ledger, not on D6 and then again.
- **When the daily Base batch is sent.** Decided 2026-10-19: keep sending at
  the first check of the round (every browser neuron sends at 00:01 UTC),
  **measure a week of skipped games** (`StaleValue`, `DuplicatePrediction`
  in the batch's `dropped`), then add a per-neuron offset if needed. Satori
  Lite staggers by its start time
  ([../design/base.md](../design/base.md#when-in-the-round)).
- **Pools and reward addresses.** Decided 2026-10-19: central still keys them
  on Evrmore addresses; **re-key them on Base addresses in central before
  raising the stake requirement** (central keeps a predictor with a reward,
  or 250 SATORI of balance plus pool contribution; the gate is 0 today).

- **Base direction on a tie** (was item 1). Decided 2026-10-19: **on a tie,
  follow the stream's last move.** When a game's forecast equals the latest
  value (a `naive` or no-opinion model), the batch answers UP if the most
  recent change in the stream's history was up, DOWN if down; a history with
  no change at all (flat, or one value) stays DOWN, the last fallback. A
  forecast above or below the latest is unchanged. Each stored game records
  its `rule` (`forecast`, `last-move`, `flat`). Lite answers DOWN on every
  tie; the deviation is in [../design/base.md](../design/base.md#deviations-from-lite-and-the-dapp-and-why).

- **Central login accepts EIP-191** (was item 5). Done 2026-10-16: central
  `base-upgrade` f4d72f5 verifies EIP-191 (`personal_sign`) at
  `/auth/login`, Satori Lite signs only EIP-191 since satorilib 5028913, and
  this app signs only EIP-191 (842d491). Since central d8a2085 answers
  register with the vault's Base address (`vault_base_address`), the app
  has no Evrmore code at all
  ([../design/central.md](../design/central.md#the-vault-in-registers-answer)).
