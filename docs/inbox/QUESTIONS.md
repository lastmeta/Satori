# Questions for the owner

Open questions the code can't settle on its own. Each says what the app does
today, so nothing waits on an answer.

1. **Base direction: keep Lite's rule?** UP if the forecast > the latest
   value, else DOWN, so a forecast equal to the latest (`naive`, or `bar1` with weight or
   φ 0) always votes DOWN, and today every browser neuron is `naive` on D6's
   one stream. A seeded slope rule, with a seeded coin flip on a flat series,
   is parked as an option ([../plans/engine.md](../plans/engine.md)). Switch,
   or keep parity with Lite?
2. **The token hook: the rewards upgrade.** A staked vault that receives
   SATORI in a transaction sent with a bare gas estimate can never unstake
   (Panic 0x11), and anyone can cause it with 1 wei. A rewards UUPS upgrade
   that subtracts the staker's booked balance fixes it now (tested on the
   fork); the root fix waits for a redeploy. Ship the upgrade?
   ([../issues/token-hook-gas-estimate.md](../issues/token-hook-gas-estimate.md))
3. **Prod central's Base and merkle routes.** `network.satorinet.io` answers
   404 for `/api/v1/base/config` and `/api/v1/merkle/proof/…`; central2 serves
   both. A build defaults to prod, so its merkle claim says the route is
   missing and the Base addresses are the bundled ones. Deploy those routers
   to prod? ([../issues/central-prod-missing-base-routes.md](../issues/central-prod-missing-base-routes.md))
4. **A wss relay.** Central lists only `ws://satorian.satorinet.io:7777`, which
   an https page can't open, so a deployed app has no Nostr until a `wss://`
   relay is listed (TLS in front of satorian, and central listing it). Who
   sets it up, and where? ([../issues/relays-not-wss.md](../issues/relays-not-wss.md))
5. **Key derivation for new neurons.** Today one 32-byte secret is at once
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

- **Central login accepts EIP-191** (was item 5). Done 2026-10-16: central
  `base-upgrade` f4d72f5 verifies EIP-191 (`personal_sign`) at
  `/auth/login`, Satori Lite signs only EIP-191 since satorilib 5028913, and
  this app signs only EIP-191 (842d491). Since central d8a2085 answers
  register with the vault's Base address (`vault_base_address`), the app
  has no Evrmore code at all
  ([../design/central.md](../design/central.md#the-vault-in-registers-answer)).
