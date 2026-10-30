# Safe: the governor Safe's keys

[← OVERVIEW](OVERVIEW.md) · the code: `src/neuron/safe.js` (the keys, propose, sign, execute), `src/chain/safe.js`
(the Safe transaction's hash, the signatures, Safe's service), `src/ui/safe.js` · the other keys: [roles.md](roles.md)

The token's root, upgrade and freeze keys, and the airdrop loader, are held by a Safe (1.4.1; on Base Sepolia
`0x61a9…2f18`, 3 of 5 owners). The owner (2026-10-30): "make a page for the safe so that it can prepare the
contracts". The app can't sign as the Safe; its owners can, one by one.

**How a change happens.** An owner fills in a key's card and taps Propose: the app builds the Safe transaction (a call,
no value, no gas refund) at the next free nonce (after those waiting), signs its EIP-712 hash with the wallet (free),
and posts it to **Safe's transaction service** (`api.safe.global/tx-service/basesep`; no key, CORS open), the one
app.safe.global uses: this Safe's earlier transactions are there, and proposals show in both. The other owners sign it
(Waiting › Sign). Once as many as the Safe needs have signed, any owner executes it (Waiting › Execute): the
signatures, sorted by owner as the Safe requires, go to `execTransaction` from the wallet, which pays the gas. They
run in nonce order.

**The page**: the Safe, Waiting, then each key the Safe holds, its values and a folded card per action (a whole page
unfolded is a long scroll on a phone).

**No fee key** (the owner, 2026-10-30; contract 2bd52e03): the dev fee is 15% for good, so the fee authority, its
proposals and freezing the dev fee are gone. The Base Sepolia token still has them (it can't be upgraded); the app
leaves them out.

**Who sees it**: an owner of a Safe that holds any of these keys (the holders read from the token and the airdrop
contract, each asked for `getOwners`). Read with the Base card at most every 15 min, and when the tab opens.

| Key | Its actions |
|---|---|
| Root authority | appoint the upgrade, wiring, appoint and freeze keys (empty: no one, for good); offer the root (two steps; empty cancels); give the root up (asks) |
| Upgrade authority | upgrade one of rewards, engine, hub, voting, registry, games, merkle (typed twice; the contract checks the build); give up upgrades for one (asks) |
| Freeze authority | freeze the controller, the transfer hook or the bridge authority, each for good (asks) |
| Airdrop loader | load a batch ("address, amount" a line; no address twice); close loading for good (asks) |

Waiting transactions are said in words when they are one of these keys' actions ("Appoint 0x… the appoint authority"), else by
contract and function, else "a call to 0x… (not one of Satori's)". A transaction proposed elsewhere with a value, a
delegate call or a gas refund can't be signed here (its hash wouldn't match a plain call): sign it in Safe's app.

**Agent calls**: `safe()`, `safePropose(key, action, value)`, `safeSign(safeTxHash)`, `safeExecute(safeTxHash)`
(public/llms.txt).
