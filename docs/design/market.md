# Market: paid streams

[← OVERVIEW](OVERVIEW.md) · plan: [../plans/market.md](../plans/market.md) ·
intent: [../intent/network.md](../intent/network.md)

Step 3 of the market plan: a neuron sells a prediction stream for a tiny
amount of SATORI per observation and buys others' streams, paid through
**payment channels** on Base, with no gas per payment. The contract is
`PaymentChannels` (`contract/satori/contracts/channels/PaymentChannels.sol`,
its design note `contract/docs/design/payment-channels.md`), deployed by
CREATE2 at **`0xAB9408f9ec330351A21497c87E3d24218413b0C8`** (v2), the same
address on every chain (Base Sepolia, the local fork, Base mainnet later).

It has two parts: selling and buying over the relays (`src/neuron/market.js`,
below), and the chain client under it.

## Selling and buying over the relays

`src/neuron/market.js` runs satorilib's data-stream market
(`satori_nostr/client.py`, `models.py`) with the same event kinds and
fields. Only the Evrmore parts change: the P2SH commitments and the channel
open and settlement events (34604–34606) become the Satori contract's
channel and its vouchers. Amounts stay in Lite's satoshis (10⁻⁸ SATORI; one
satoshi is 10¹⁰ wei on Base). Bounties (34607–34608) are
not part of it.

| Step | Satori Lite (satorilib) | Here |
|---|---|---|
| Sell | `announce_datastream` with `price_per_obs` (sats), `encrypted` | The same: our `<stream>_pred` 34600 with `encrypted: true` and `price_per_obs`, the one price, in satoshis (so a price has at most 8 decimals). `metadata.market = { chain, contract, token, payee }` says where to pay: the Satori contract, SATORI, the wallet. Unpricing announces it free again (`price_per_obs: 0`) |
| Buy | an Evrmore channel (34605), then `subscribe_datastream` with `payment_channel` | The wallet opens a channel (Unlock, gas) with a deposit (100 × the price by default), then the 34602 (kept until a relay takes it, as its vouchers are) with `payment_channel = { chain, contract, id, binding }`. `binding` is the alias's EIP-191 signature of `satori-market:v1:<channel id>:<buyer's Nostr key>`, so only that Nostr key can use the channel |
| Deliver | `publish_observation`: one 34601 per paying subscriber, `p` = them, the value encrypted, seq and timestamp in tags; the first observation free | The same, with `d = <stream>:<subscriber>`, because a relay keeps one event per `d` and would drop all but one subscriber's. The public `d = <stream>` gets Lite's heartbeat (tags, no value) on every observation |
| Pay | `send_payment` (34603, `d = stream`, encrypted) for `seq + 1` on each observation received | The same event and fields: `amount_sats` is the price, and `voucher: { channel, cumulative, signature }` takes the place of `tx_id`: the alias's cumulative EIP-712 voucher (`cumulative` in wei). It never signs past the deposit |
| Check | `record_payment` believes the content | The seller reads the channel on chain when it accepts it: its payee is our wallet, its token SATORI, its signer the binding's, it is open, and the deposit covers a price. It then checks each voucher: the signer's, more than the last, at most the deposit. It delivers while the newest voucher covers every observation delivered before (the first is free) and the deposit covers one more |
| Collect | the seller broadcasts the latest commitment | At most once a week (each settle costs gas; owner, 2026-10-25: the close signal is watched, so a daily one buys nothing), the hourly pass sends one `settleMany` for every channel whose voucher is above what is settled. When a buyer unsubscribes or the pass reads a close request, the seller stops delivering to it and settles at the next hourly pass, well inside the 7-day grace period |
| Stop | `unsubscribe_datastream` | The alias sends `requestClose` (no Unlock), then Lite's unsubscribe 34602. After the 7-day grace period, the hourly or catch-up pass sends `withdraw`, and the rest goes back to the wallet |

- **Encryption is NIP-04**, as satorilib's `encryption.py` does it (Lite
  has no NIP-44). It is built on WebCrypto's AES-CBC and noble's ECDH, with
  no new dependency, and checked against nostr-sdk 0.45's own output
  (`test/fixtures/nip04-vectors.json`).
- **Bought observations land where received data already lands.** A bought
  prediction stream is watched ahead of all others but ours, so what it
  sends goes into the track record's tables, and its record comes from what
  was bought.
- **Kept** in the meta key `market`: `{ prices, sales, buys }`, amounts as
  decimal strings ([storage.md](storage.md#meta-keys)).
- **Words:** Sell, Make free, Buy, Stop; a wallet staked with this app
  can't fund a channel, and `channelErrorText` says why.

## The Market tab

The market's own page (owner, 2026-10-25), Menu › Market on a phone, the top
nav on a computer (`src/ui/market.js`):

- **What it is**, and the totals: SATORI earned (what buyers paid), how much
  of it is collected (settled), how many streams it sells, how many it buys.
- **For sale**: every stream the relays announce with a price (discover()'s,
  asked for when the tab opens and nothing is known), its price per value,
  provider, cadence and track record when it is watched ("Track record: 50%
  better"), with a deposit (100 values) and Buy (Unlock in place).
- **Your sales**: each stream this app predicts, Sell at a price or Make
  free, and how many buy it. None predicted: where to start (the Streams
  tab's Predict).
- **Bought**: the deposit left, and Stop.

The Streams tab's catalog sends a priced stream here (**On the Market**).
Agents: `market()` → `{ forSale, selling, bought }`.

## The chain client

`src/chain/channels.js` is everything the market does on Base: the channel
id, vouchers (made, signed and checked), reading a channel, and the
writes. It has no UI, no database and no Nostr. It runs on the chain the
rest of the app uses (`createChain`, [base.md](base.md)), so its writes
share that chain's one queue (the alias's daily batch and a settle never
race for a nonce), its simulate first, its gas pad and its max fee.

```
const channels = createChannels({ chain, config })   // chain = createChain(…), config = its config
// buyer
await channels.openChannel({ wallet, alias, payee, deposit })   // Unlock: the wallet funds it → { id, hash, permit }
const sig = await signVoucher(alias, { chainId, channelId: id, cumulative })   // per observation, no Unlock, no gas
await channels.requestClose(alias, id) … 7 days … await channels.withdraw(alias, id)   // refund to the wallet
// seller
await verifyVoucher({ chainId, channelId, cumulative, signature, signer })   // the channel's signer, read on chain
await channels.settleMany(alias, [{ id, cumulative, signature }, …])     // daily: one tx, paid into the wallet
```

### The pieces

| Piece | What it is |
|---|---|
| `channelIdOf({ payer, payee, token, signer, salt })` | `keccak256(abi.encode(payer, payee, token, signer, salt))`, the contract's `computeChannelId`, computed locally |
| `newSalt()` | 32 random bytes (WebCrypto), so each channel's id is new: the contract never reuses an id, even after close |
| `voucherTypedData({ chainId, channelId, cumulative })` | EIP-712: domain `{ name: 'PaymentChannels', version: '1', chainId, verifyingContract }`, type `Voucher(bytes32 channelId,uint96 cumulativeAmount)` |
| `voucherDigest(…)` | its hash, the contract's `voucherDigest` |
| `signVoucher(alias, …)` | the alias signs a voucher (65 bytes, hex) inside its signer; no Unlock |
| `recoverVoucherSigner(…)`, `verifyVoucher({ …, signer })` | who signed it, by ECDSA alone, under exactly the contract's rules (below) |
| `dueOf(channel, cumulative)` | what a voucher would pay now: `min(cumulative, deposit) − settled`, never below 0 |
| `readChannel(id)` | `{ id, payer, payee, token, signer, deposit, settled, closeRequestedAt, closed, graceEndsAt }` (amounts bigint wei, times unix seconds; `closeRequestedAt` and `graceEndsAt` null until a close is asked), or null for an id never opened |
| `openChannel`, `topUp`, `cancelClose` | the wallet's writes (Unlock; a locked wallet: "The wallet is locked: Unlock it first.", nothing read or sent) |
| `requestClose`, `withdraw`, `settle`, `settleMany` | the alias's writes (no Unlock) |
| `channelErrorText(err)`, `ChannelError` | errors in plain words |

The address is `PAYMENT_CHANNELS` (`DEFAULTS.channels`) in
`src/chain/config.js`, one constant for every chain; central's config has no
such field, so nothing can move it. Its ABI is `channelsAbi` in
`src/chain/abi.js`, and a token's allowance and permit `erc20PermitAbi`.

### Which key sends what, and why

The plan's [two keys](../plans/market.md#two-keys-as-everywhere-in-satori):
the wallet holds the money, the alias runs on its own.

| Call | Sent by | Why that key |
|---|---|---|
| `openChannel` | **wallet** (Unlock, Base ETH for gas, as Stake) | it is the only step that moves the buyer's SATORI. The channel's `payer` is the wallet and its `signer` the alias |
| `topUp` | **wallet** | it moves SATORI too |
| `cancelClose` | **wallet** | the contract lets only the payer cancel a close: a leaked alias must not keep a refund from ever coming due. It moves no tokens |
| vouchers | **alias** signs, nothing is sent | one per observation, while the wallet stays locked |
| `requestClose`, `withdraw` | **alias** | the contract allows the signer; the refund can only go to the payer, so unsubscribing needs no Unlock |
| `settle`, `settleMany` | the **seller's alias** | anyone may settle, and the money can only go to the payee, the seller's wallet. The alias already holds gas for the daily batch |

**Refunds always go to the wallet** (the payer), whoever sends `withdraw`.
A leaked alias can sign vouchers up to the deposits of the channels it
signs for, paying sellers the buyer already chose, and can ask to close
them; it can't send money anywhere else.

### Opening a channel: one transaction with a permit

`openChannel({ wallet, alias, payee, deposit, token?, salt? })`:

1. **The transfer lock** (below) for SATORI, before anything is signed.
2. **The permit.** The token's `nonces(wallet)`, `eip712Domain()` (ERC-5267)
   and `DOMAIN_SEPARATOR()` are read in one multicall. SATORI answers
   `("Satori", "1", 84532, token)`; without `eip712Domain` the domain is
   `name()` and version `"1"`. The domain is used only if it hashes to the
   token's own `DOMAIN_SEPARATOR()`, so a wrong guess can't make a permit
   that fails. The wallet signs `Permit(owner = wallet, spender = channels,
   value = deposit, nonce, deadline = chain time + 1 h)`.
3. **`openWithPermit(wallet, payee, token, alias, deposit, salt, …)`**
   from the wallet: approve and open in one transaction.
   A token without a permit (or a domain that doesn't match) falls back to
   `approve(channels, deposit)`, then `open`, two transactions; the open
   waits until the RPC shows the allowance (5 × 1 s, as after Stake).

It returns `{ id, hash, receipt, permit }` (`approve`: the approve's hash on
the fallback). `topUp(wallet, id, amount)` has no permit form in the
contract, so it approves first when the allowance is short (two
transactions), then `topUp`.

### The transfer lock: a staked wallet can't fund a channel

SATORI refuses a transfer **out of** a wallet while
`transferLockedUntil(wallet) >= getCurrentRound()` ([base.md](base.md#status-no-unlock)):
while it is staked with a neuron (`2^24 − 1`), through the round after it
unstakes, and through the round after it predicted by hand. Opening or
topping up a channel pulls the deposit from the wallet, so:

- **A wallet staked with this app can't fund a channel.** `openChannel`
  and `topUp` read the lock first and throw, before any signature or gas:
  "Your wallet is staked with this app, so it can't send SATORI: a
  channel needs SATORI the wallet can send."
- **After unstaking** it can, from the round the lock ends: "Your wallet's
  SATORI can't be sent until Oct 22, 00:00 UTC (round 20748): a channel
  needs SATORI the wallet can send."
- **A channel funded before staking keeps working.** Vouchers move nothing
  out of the wallet, a settle sends from the contract, and a refund to a
  locked wallet is received (the lock checks only the sender). A staked
  wallet can still `cancelClose`: it moves no tokens.
- **A seller can be staked.** Receiving is never locked.

The token's own `Locked()` (a lock that started between the check and the
send) is said in plain words too ([below](#errors-in-plain-words)). Other
tokens have no lock, and none is read.

### Settling: padded for the token's hook

A payment into a staked wallet (the seller's, usually) runs the token's
delegation hook. On D6 a hook starved of gas is skipped silently and the
wallet can never unstake ([the issue](../issues/token-hook-gas-estimate.md));
on D7 the transfer reverts instead. So no settle is sent with a bare
estimate: `settle` gets the app's usual pad, the estimate + 500,000 gas
(`HOOK_GAS`), and `settleMany` that plus 100,000 per payment in it
(`PAYMENT_GAS`; the hook measured at about 100,000 the first time and
70,000 after, [below](#gas-measured-on-the-fork)).
Unused gas isn't charged.

`settleMany(alias, entries)` reads every channel in one multicall first
and sends only the entries that would pay: the channel exists and isn't
closed, `dueOf` > 0, and the voucher verifies against the channel's signer.
The rest come back in `skipped` with the reason (`unknown`, `closed`,
`nothing-due`, `bad-signature`); with nothing to pay, nothing is sent
(`hash: null`). Both settles return `settled`: the contract's `Settled`
events, `[{ id, cumulative, paid, settled }]`.

### Checking a voucher: ECDSA only, as the contract

The market accepts only **key (EOA) signers** (the plan: a contract signer
can change its answer, ERC-1271). `recoverVoucherSigner` and
`verifyVoucher` therefore check only what the contract's ECDSA path
accepts (OpenZeppelin 5's `tryRecover`): exactly 65 bytes, `v` 27 or 28,
`0 < r < n`, `0 < s ≤ n/2` (no malleable twin), recovered to the
channel's signer. A voucher this refuses is one the contract would refuse
by ECDSA, so a seller never serves against a voucher that can't be
settled.

### Errors in plain words

Every write throws a `ChannelError` whose message is plain (the contract's
reason in `reason`, viem's error in `cause`); the max fee's
`FeeCeilingError` passes through as it is. `channelErrorText(err)` says any
error the same way.

| Error | Said |
|---|---|
| `BadInput` | The channel's addresses or amount are not valid. |
| `ChannelExists` | A channel with this id already exists: open it with a new salt. |
| `UnknownChannel` | There is no such channel. |
| `ChannelClosed` | The channel is closed. |
| `NotPayee` | Only the seller (the channel's payee) can do that. |
| `NotPayer` | Only the wallet that funded the channel can do that. |
| `NotPayerOrSigner` | Only the channel's wallet or alias can do that. |
| `BadSignature` | The voucher's signature isn't the channel's signer's. |
| `NothingToSettle` | Nothing new to settle: the voucher pays no more than is already paid. |
| `CloseNotRequested` | No close was asked for this channel. |
| `CloseNotReady` | The 7-day grace period after the close request hasn't ended yet. |
| `UnsupportedToken` | The token takes a fee on transfer, which channels can't hold. |
| `Locked` (the token) | The wallet's SATORI can't be sent now: it is staked, or it predicted by hand this round or the last. |
| `ERC20InsufficientBalance` | Not enough SATORI in the wallet. |
| `ERC20InsufficientAllowance` | The channel contract wasn't allowed to take the deposit. |
| `HookFailedWithoutReason` | The transaction ran out of gas; try again. |

### Gas, measured on the fork

Measured on an anvil fork of Base Sepolia (2026-10-20) with D6 SATORI,
from receipts (`scripts/channels-smoke.mjs`, and the same calls for 2, 5
and 10 channels). The payee is a wallet **staked** with its neuron, so every
payment runs the token's hook, as it will for a neuron that predicts on Base.

| Call | Sent by | Gas used | Note |
|---|---|---|---|
| `openWithPermit` (2 SATORI) | buyer's wallet | 183,038 | approve and open in one |
| `approve` + `topUp` | buyer's wallet | 46,063 + 64,787 | the contract has no permit form for a top-up |
| `settleMany`, 1 channel, its first settle | seller's alias | 192,563 | into the staked wallet: the hook runs |
| `settle`, a later one | seller's alias | 138,915 | |
| `settleMany`, 2 / 5 / 10 channels, first settles | seller's alias | 241,945 / 390,059 / 636,903 | about 50,000 more per channel |
| the same, later settles | seller's alias | 190,642 / 338,768 / 585,624 | |
| `requestClose` | buyer's alias | 38,803 | |
| `cancelClose` | buyer's wallet | 35,702 | |
| `withdraw` (into a staked wallet) | buyer's alias | 183,926 | the refund runs the hook too |

Into a wallet that isn't staked the contract's note measured a settle at
87k (first) and 70k (later) and `withdraw` at 54k, so the hook costs about
100,000 the first time and 70,000 after. At Base mainnet's 0.006 gwei
(2026-10-20) 200,000 gas is 0.0000012 ETH. What the sender must hold up
front is the gas limit at the max fee: a 10-channel `settleMany` is sent
with about 0.64M + 0.5M + 1M = 2.1M gas, 0.00002 ETH at 0.011 gwei.

On anvil, a settle sent with the bare estimate happened not to starve the
hook (no `TransferHookFailed` or `ChildSyncFailed`, the stake still in
sync). The public RPC (reth) estimates differently and has starved a
transfer's hook ([the issue](../issues/token-hook-gas-estimate.md#mechanism-verified)),
so the pad stays.

### Tests

- `npm test`: `src/chain/channels.test.js`. The channel id and the voucher
  digest against values the deployed contract computed
  (`test/fixtures/channels-vectors.json`: `cast call` of
  `computeChannelId` and `voucherDigest` on the fork, the command in the
  file); sign → recover with our signer and a viem account; `verifyVoucher`
  refusing a wrong signer, channel, amount, chain or contract, and the
  signatures the contract's ECDSA refuses (high `s`, `v` 0/1, 64 bytes);
  `dueOf`; the lock's two messages before anything is sent; every error's
  words; and every write against a small fake of the contract and SATORI
  (in the test file, over `test/fake-rpc.js`): who sends what, the lock
  before any signature, the permit and its domain check, the fallback, the
  pads, `settleMany`'s skipping, the max fee. 51 tests.
- `src/chain/abi.test.js`: `channelsAbi` against a snapshot of the
  contract's ABI (`test/fixtures/abi-channels.json`, from its Hardhat
  artifact; `ABI_SNAPSHOT=channels npx vitest run src/chain/abi.test.js`
  rewrites it; the artifact's code is the deployed code but for its
  immutables), and online against the deployed code (every selector and
  event topic, and the views' answers).
- `src/chain/config.test.js`: the address is the one the CREATE2 deploy
  recorded (`contract/satori/deployments/payment-channels.json`).
- The fork: `node scripts/channels-smoke.mjs [--port 8545]`, below.

### The smoke on the fork

`scripts/channels-smoke.mjs` runs the whole life of a channel against the
real contract and D6 SATORI on a local fork (never a public chain), with
fresh throwaway keys:

1. funds the buyer's wallet (`fund <wallet> --satori 5`), both aliases and
   the seller's wallet (1 SATORI), and stakes the seller's wallet with its
   alias, so each payment runs the token's hook;
2. the buyer's wallet opens a 2 SATORI channel with a permit, then tops it
   up by 1 (approve + `topUp`);
3. the buyer's alias signs 24 vouchers of 0.001 SATORI (a day of hourly
   observations), each checked by `verifyVoucher` against the channel's
   signer as read on chain;
4. the seller's alias settles the 24th with `settleMany`; the seller's
   stake is still in sync (the alias's power equals the wallet's SATORI);
5. the buyer's wallet stakes: `openChannel` and `topUp` now throw the plain
   words and send nothing, while the channel keeps paying (12 more
   vouchers, one `settle`);
6. the buyer's alias asks to close, its staked wallet cancels, the
   alias asks again; `withdraw` is refused before the grace period;
7. `advance 8`, then `withdraw` refunds the rest into the staked wallet, its
   stake in sync after the hook.

It prints each step's gas. `--port` names the fork (8545 by default, the
dev server's); it moves the fork's clock 8 days, so a fork of its own
(`node scripts/fork.mjs start --port 8547`) leaves the dev app's alone.

Its run on a fork of its own (2026-10-20, port 8547):

```
1. funds (fork.mjs fund), and the seller's wallet staked with its alias
  ok: the seller's wallet is staked with its alias (1 SATORI of power)
2. the buyer's wallet opens a 2 SATORI channel to the seller's wallet, then tops it up by 1
  openWithPermit                           buyer wallet        183038 gas
  ok: one transaction, with SATORI's permit (domain "Satori", "1")
  approve (for topUp)                      buyer wallet         46063 gas
  topUp                                    buyer wallet         64787 gas
  ok: channel 0x328c2c82…: payer = buyer wallet, signer = buyer alias, deposit 3 SATORI
3. the buyer's alias signs 24 vouchers (0.001 SATORI each), the seller checks each against the channel's signer
  ok: 24 vouchers signed and verified, none on chain
4. the seller's alias settles with settleMany into its staked wallet
  settleMany (1 channel, first settle)     seller alias    192563 gas
  ok: Settled: paid 0.024 SATORI
  ok: the seller's stake is still in sync: the hook ran in full
5. the buyer's wallet stakes with its alias: it can't fund a channel now, the channel keeps paying
  ok: refused, nothing sent: "Your wallet is staked with this app, so it can't send SATORI: a channel needs SATORI the wallet can send."
  ok: refused, nothing sent: "Your wallet is staked with this app, so it can't send SATORI: a channel needs SATORI the wallet can send."
  settle (a later one)                     seller alias    138915 gas
  ok: a channel funded before staking keeps paying: 0.012 SATORI more
6. close: asked by the buyer's alias, cancelled by its (staked) wallet, asked again
  requestClose                             buyer alias      38803 gas
  cancelClose                              buyer wallet         35702 gas
  requestClose (again)                     buyer alias      38803 gas
  ok: refused, nothing sent: "The 7-day grace period after the close request hasn't ended yet."
7. fork.mjs advance 8, then withdraw: the rest back to the buyer's wallet
  withdraw                                 buyer alias     183926 gas
  ok: refunded 2.964 SATORI (3 deposited − 0.036 settled) into the staked wallet
  ok: the buyer's stake is in sync after the refund: the hook ran in full
  ok: the channel is closed
  ok: the buyer's wallet: 4.964 SATORI (5 − 0.036)
```
