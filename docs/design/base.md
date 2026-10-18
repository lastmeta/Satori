# Base: stake, the daily batch, claims, send

[← OVERVIEW](OVERVIEW.md)

The neuron predicts on Base the way Satori Lite (`../neuron`, the Docker
neuron) does: the **vault** stakes with this neuron, and the **identity**
signs one batch of up/down predictions a day on its own, with no passphrase.
The vault signs only what moves or locks its funds: Stake, Unstake, claims
and sends, each after **Unlock**. Where the dapp (`../contract/satori-ui`)
goes further than Lite (it claims on-chain rewards, lets only our vault
stake with the identity, mirrors the engine's predict gate), the browser
follows the dapp.

**Staking (the owner's word, 2026-10-18).** On-chain, staking with this
neuron is the vault's `delegatePredictionPower(identity)`: the SATORI stays
in the vault, can't be transferred while staked, and earns. Everything
people and agents read says stake and unstake (Lite's word); the contracts
and the code keep their names, and Lock and Unlock stay the passphrase's.

**Automatic only (the owner's split, 2026-10-15).** On-chain the neuron plays
only automatically, through the identity's daily batch; manual play is
**Satori Daily**, the dapp at https://app.satorinet.io (`SATORI_DAILY_URL`,
`src/chain/config.js`). The two are mutually exclusive per vault per round:
the engine refuses a staked vault's own predictions
(`if (delegate != address(0)) revert Delegated();`,
`C/next/SatoriEngine.sol:711`). The Base card says which one is in force.

```
page load ─▶ config (bundled D6 addresses, central's /api/v1/base/config over them, 1 h)
          └─▶ status: one multicall (ETH ×2, SATORI, stake ×2, fee, allowedDelegator, lock, round, claimable ×2)
Unlock ─▶ Stake with this neuron: identity setPredictorFee(0) → identity setAllowedDelegator(vault) → vault delegatePredictionPower(identity)
       └─▶ Claim: hub.claim() · merkle (central's proof) · airdrop      Send: ETH, or SATORI when it can be sent
each round (the identity, no unlock): a batch already sent? wait for it ─▶ power > 0 and no batch yet
          ─▶ registry streams whose game has voting weight ─▶ history ─▶ engine ─▶ UP/DOWN per game
          ─▶ simulate each game alone ─▶ fees under the ceiling? ─▶ predictMultipleWithPayloads(the ones that pass)
          ─▶ keep the hash ─▶ receipt ─▶ persist (its round from its block)
```

Short names: `BP` = `neuron/neuron-lite/satorineuron/base_predict.py`, `BC` =
`base_claim.py`, `BCFG` = `base_config.py` (same folder); `START` =
`neuron/neuron-lite/start.py`; `ROUTES` = `neuron/web/routes.py`; `EVM` =
satorilib's `src/satorilib/chain/evm.py`; `UI` =
`contract/satori-ui/src`; `C` = `contract/satori/contracts`. Lite is at
639e3ce, the contracts and the dapp at 4844c901 (the D6 stack on Base
Sepolia, chain 84532).

## Keys on Base

Each key's 32-byte secret is also its EVM private key, as satorilib makes it
(`Account.from_key(entropy)`, satorilib `wallet/wallet.py:220-232`,
`wallet/ethereum/wallet.py:114-121`): the Base address is keccak-256 of the
uncompressed public key. The vault's Base address is computed from its public
key, kept in clear in the keys record ([keys.md](keys.md#the-record)), so the
status needs no Unlock (Lite's `vault.ethAddress` needs the decrypted vault).
Base is the only chain this app shows: each key's address in the app is its
Base address. Transactions are signed inside the key's signer
(`src/keys/index.js`), which Lock wipes; the private key is never handed to
viem as a string (`src/chain/index.js` wraps the signer in a viem custom
account).

## Config

- **Addresses** (`src/chain/config.js`): BCFG's DEFAULTS (`:20-36`), plus
  `lens`, `voting` and Multicall3 from the dapp (`UI/contracts/addresses.ts:199-221`);
  they mirror `contract/satori/deployments/baseSepolia.json` (`voting` =
  `SatoriEngine.satoriVoting()` on D6). `explorerUrl` links tx hashes on the
  card (not on a local fork). Central's
  `GET /api/v1/base/config` overlays them (non-empty values only, and only for
  chain 84532), cached 1 h in memory as BCFG does (`:16,66-88`). central2
  answers it; prod returns 404, so the bundled addresses are used there.
  Central's payload has no `lens` or `voting`: they always come from the bundle.
- **RPC** (Settings, `meta.base_rpc_url`): empty means the default. In a
  build: central's `rpcUrl` (else `https://sepolia.base.org`), then
  `https://base-sepolia-rpc.publicnode.com` as a fallback, as the dapp lists
  them (`UI/contracts/addresses.ts:218-221`; viem's `fallback` transport). On
  the dev server the default is `/rpc`, which Vite proxies to a local anvil
  fork of Base Sepolia on `127.0.0.1:8545` (`scripts/fork.mjs`), so by
  default a dev checkout does not send to a public chain, the same rule as the
  dev central and the test relay; a saved RPC replaces the default. A build
  can fix its own default with `VITE_BASE_RPC`, used alone as `/rpc` is
  ([deploy.md](deploy.md#build-variables)). The card
  shows the active RPC as its first fact. A setting is an `https://` URL or a
  same-origin path; the page's CSP (`connect-src 'self' https:`) allows both.
- **Chain id**: a new RPC is asked `eth_chainId` once. Another chain than
  84532 is refused: the card says so, and nothing is read, sent or batched
  until the RPC changes.

## Status (no Unlock)

One `aggregate3` call to Multicall3 (`src/chain/index.js`, `status()`), plus
`eth_gasPrice`:

| Read | For |
|---|---|
| `getEthBalance(identity)`, `getEthBalance(vault)` | gas; the identity's balance is shown as days of batches left |
| `token.balanceOf(vault)` | the vault's SATORI |
| `rewards.predictionDelegateInfo(vault)` | whom the vault stakes with |
| `rewards.predictionDelegateInfo(identity)` | the identity's incoming power (BP:243-248) |
| `rewards.effectivePredictorFee(identity)` | 10 % until set to 0 (`C/SatoriRewards.sol:119-143`) |
| `hub.allowedDelegator(identity)` | the one vault that may stake with the identity (`C/next/SatoriHub.sol:813-819,1007`) |
| `token.transferLockedUntil(vault)` | when the vault's SATORI can be sent |
| `token.getCurrentRound()`, `getCurrentBlockTimestamp()` | the round (`block.timestamp / 86400`, `C/next/SatoriToken.sol:329-331`) and chain time |
| `lens.getTotalClaimableRewards(vault)` | on-chain rewards (`C/SatoriRewardsLens.sol:319-324`) |
| `airdrop.claimableAirdrop(vault)` | the vested airdrop (`C/SatoriAirdrop.sol:187-191`) |

Each read may fail on its own (`allowFailure`), so one reverting view does
not hide the rest.

**When SATORI can be sent.** The token refuses a transfer while
`transferLockedUntil != 0 && transferLockedUntil >= currentRound`
(`C/next/SatoriToken.sol:816-821`). `2^24 − 1` means "while staked"
(`C/next/SatoriHub.sol:426-429`); Unstake sets it to the current round + 1
(`:431-434`), so SATORI can't be sent through round N = R + 1 and can from
round N + 1, at 00:00 UTC. The card says "Staked SATORI can't be sent until
you unstake", then "SATORI can be sent from <date> (round N + 1)". Lite's `stake_status` uses `lock_round > current`
(BP:316) and so shows the tokens as free one round early.

## Stake with this neuron (Unlock)

Lite's "Enable staking" (`ensure_delegation`, BP:273-290; ROUTES:1485-1529)
plus the dapp's instant-signing setup (`UI/components/GameWalletPanel.tsx:536-595`):

1. If `effectivePredictorFee(identity) != 0`, the identity sends
   `rewards.setPredictorFee(0)` (BP:281-282). It is set-once
   (`C/SatoriRewards.sol:651-669`, `AlreadySet`): a key whose fee was ever
   set to something else keeps it, and the simulate says so before any gas.
2. If `allowedDelegator(identity) != vault`, the identity sends
   `hub.setAllowedDelegator(vault)`, as the dapp does (`GameWalletPanel.tsx:545`):
   only our vault can then stake with the identity
   (`C/next/SatoriHub.sol:842-846`). Lite skips this step.
3. If `predictionDelegateInfo(vault).delegate != identity`, the vault sends
   `hub.delegatePredictionPower(identity)` (BP:286-287).

**Unstake**: the vault sends `delegatePredictionPower(0x0)`
(BP:292-301). Its SATORI can't be sent through the next round (above).

Words: "Stake with this neuron" / "Unstake", "Staked: 100 SATORI with this
neuron" / "Not staked", as Lite says it ("Stake your vault & predict on
Base"). The app says Unlock/Lock for the vault's passphrase, so the token's
transfer lock is "can't be sent" / "can be sent from <date>".

**Sending a transaction** (`src/chain/index.js`, `write()`), as EVM:60-93:
simulate the call first (a revert throws with the contract's error name and
costs no gas), estimate, send, wait for the receipt, and throw unless its
status is success. Fees: the tip is the node's `eth_maxPriorityFeePerGas`,
and `maxFeePerGas = 2 × the latest base fee + the tip` (Lite's 2× margin,
EVM:74-75, on the base fee instead of the gas price). The gas limit of a
contract call is the estimate + 500,000 (`HOOK_GAS`; unused gas is not
charged): the token runs its transfer hook in a try/catch, so the bare
estimate starves the hook, and SATORI that reaches a staked vault that way
(any claim) leaves it unable to ever unstake. Found on the fork while
building this step ([issue](../issues/token-hook-gas-estimate.md));
Lite and the dapp send with the bare estimate. **The pad protects only our
own writes**: a transfer or a `claimAirdropFor(vault)` someone else sends
to our staked vault with a bare estimate (1 wei is enough) still bricks
it; that needs the contract fix. A plain ETH transfer runs no hook and is
sent with its estimate. After a write the app re-reads until the change shows, 5 × 1 s
as Lite (`_stake_status_after`, ROUTES:1449-1463), then trusts the receipt:
the public RPC is load-balanced and lags a block or two. Writes run one at a
time (one queue for both keys), so the identity's batch and its setup never
race for a nonce.

## The daily batch (the identity, on its own)

Port of `submitBasePredictions` (START:1143-1236) and `submit_batch`
(BP:157-174), with the dapp's predict gate done by simulation
(`UI/lib/predictGate.ts:14-50`).

0. **A batch already sent**: its hash is kept (`meta.base_pending_batch`)
   the moment the send returns. A check that finds one waits for its
   receipt (up to 30 s) instead of simulating and sending again: mined, it
   becomes the last batch; reverted, or from an earlier round and never
   mined, it is let go; still pending in this round, the check says so and
   the next one looks again.
1. **Due** once per UTC round: skip when the identity's incoming power is 0
   (START:1171) or `engine.predictedStreamsCount(identity, round) != 0`
   (START:1174, BP:213-217).
2. **Streams**: `registry.getAllDataStreams()`, then in one multicall
   `games.binaryGameByStream(id)` (keep `!= 0`), `registry.isNamedStream(id)`
   (a revert reads as not named, as BP:223-230; on D6 it reverts for unknown
   ids) and `registry.getLatestUpdateInfo(id)` (the cadence), then in a
   second multicall `voting.weightOf(gameId)`, keeping games with weight > 0:
   the engine's own eligibility test (`C/next/SatoriEngine.sol:828`, an
   unweighted game earns no SATORI). Anyone can add a stream, and its game,
   for a 0.001 SATORI burn: on the fork 10 such streams took a batch from 1
   game and 408k gas to 11 games and 1.83M gas. Lite instead predicts the
   bridge's Nostr streams `satori-84532-1…32` (START:457-517), a list the
   bridge chooses; the browser reads the registry, as the dapp does, so it
   needs no relay.
3. **History**: `registry.getHistoryPage(id, 0, 768)` (the whole ring,
   oldest first; `C/SatoriRegistry.sol:1375-1393`). Values are `int232`;
   only their ratios matter here.
4. **Forecast** with the engine (`src/engine/`) one cadence ahead, and at
   least the 24 h a round scores (the owner's rule,
   [../intent/engine.md](../intent/engine.md);
   [engine.md](engine.md#the-step-and-the-horizon)): horizon = max(24 h, the
   cadence), cut into n = max(1, floor(horizon / max(12 h, cadence))) equal
   steps, step = horizon / n, so the forecast lands exactly on the horizon. A
   stream that updates at least every 12 h is forecast in two 12 h steps,
   24 h ahead, the game's daily target (`targetMinutes` 1440) and central's
   horizon; a 13–24 h cadence in one 24 h step (a step shorter than the
   cadence would leave `bar1` no back-to-back buckets); a slower one in one
   step of its cadence. D6's one stream, the default stream, is daily
   (1440 min): one 24 h step. (Until the rule it took t2 there, two days
   ahead; and until the review a 13 h cadence went 26 h ahead, an 18 h one
   18 h.)
5. **Direction**: UP (`0x01`) if the forecast at the horizon > the latest
   value, else DOWN (`0x02`); payload = the one byte
   (`solidityPacked(['uint8'])`). This is Lite's
   `direction_from(forecast, latest)` (BP:141-143), where `forecast` is
   Lite's latest relay `_pred` for the stream (START:1200-1206), t2 at the
   stream's cadence ([nostr.md](nostr.md#the-engines-step)). As in Lite, a forecast equal to the latest value is DOWN, so a
   `naive` forecast (too little history: D6's daily default stream has two
   values) always votes DOWN, and so does every browser neuron. Fixable, not
   inherent: the parked alternative (a seeded slope rule,
   [../plans/engine.md](../plans/engine.md)) was set aside
   for Lite's rule (owner, 2026-10-15). A **named** stream's value is a
   signed counter that starts at 0; the engine models any series with a
   value ≤ 0 on changes (`bar1d`, [engine.md](engine.md#bar1d-a-series-with-values--0-step-6)),
   where before it fell back to `naive` and so voted DOWN forever.
6. **Simulate each game alone** as a one-game `predictMultipleWithPayloads`
   from the identity, and keep the ones that pass. A revert names the reason
   (`StaleValue`, `EmptyStream`, `DuplicatePrediction`, …); an RPC failure is
   not a revert and stops the batch until the next check. This fixes Lite's
   "one stale game sinks the batch"
   ([issue](../issues/base-batch-one-bad-game-reverts-all.md)): the
   simulate runs the contract's own pull and checks
   (`C/next/SatoriEngine.sol:777-810`), which no off-chain read reproduces,
   named games' 24 clock hours included (`:807`). Lite's own named-game rule
   (BP:146-149, 24 h since its last submit) and its resend without named
   games on `DuplicatePrediction` (BP:157-174) exist because Lite does not
   simulate; here the simulate already drops such a game, so neither is
   kept.
7. **The spending ceiling**: the batch runs unattended, so its max fee per
   gas must be at most the setting (Settings, `meta.base_max_fee_gwei`,
   default 2 gwei); above it the check skips, says why, and the next one
   tries again. Base's fees are about 0.01 gwei (Base Sepolia, 2026-10-15:
   base fee 0.005 gwei, tip 0.001 gwei, so a max fee of 0.011 gwei): 2 gwei
   stops only a spike of ~200× or an RPC quoting nonsense, and caps a batch
   at about 0.003 ETH (its 1.5M gas limit). It sits above the 1 gwei tip
   anvil quotes, so the local fork works. The vault's actions are attended
   and have no ceiling.
8. **Send** `predictMultipleWithPayloads` with the games that passed, and
   keep its hash at once (step 0).
9. **Persist after the receipt**: `meta.base_last_batch` = `{round, at, hash,
   games: [{streamId, gameId, named, direction, model, latest, forecast,
   horizon, step, score?, persist?}], dropped:
   [{streamId, gameId, error}]}`. `step` is the engine's step; `score` and
   `persist` (when the engine had 5 backtest origins) are its median error
   and no change's, which the Models tab shows ([models.md](models.md)); the
   batch does not read them. `at` is the block's time and `round` is
   `floor(at / 86400)`: a batch sent at 23:59:59 can land in the next round.
   Lite writes its time before sending (START:1228-1232), so a revert loses
   the day; here a failed send is shown, and the next check tries again.

### When in the round

**At the first check of the round, never held.** Checks run 10 s after the
page loads and after Stake, then at the next round's start (00:01 UTC on
the chain's clock) and at least hourly; `window.satori.predictBase()` runs one
at once. Why:

- A tab can close at any moment. One batch per round
  (`AlreadyPredicted`, `C/next/SatoriEngine.sol:716`) means a held batch that
  never goes loses every game of the round; a game dropped at send time loses
  only itself, for one round.
- The trade-off: the streams update during the day, and the contract
  compares **clock hours**. A game fails `StaleValue` when its stream's
  newest value is in the same clock hour as our last prediction on it, or
  earlier (`streamLastHour <= lastPredHour`, `C/next/SatoriEngine.sol:810`).
  So a provider that writes once a day later in hour 0 than our 00:01 batch
  (at 00:30, say) is stale at 00:01 every other round: its 00:30 value has
  the hour of yesterday's 00:01 prediction; the game is dropped that round,
  passes the next (its last prediction is then two days old), and so on. A
  named game fails when our last prediction on it is under 24 clock hours
  old (`:807`), which happens when the batch moves to an earlier hour than
  the round before. Sending later in the round would catch more games when
  the tab stays open, and lose the whole round when it doesn't; we keep the
  first check. The default stream (id 1) is written by the batch's own
  predict (`flushDefaultStream`, `C/next/SatoriEngine.sol:619-638`), so it
  always passes.
- A game that fails is listed with its reason under the last batch, and the
  next round takes it again.

Lite instead sends every 24 h from its last submit (START:1256-1274), which
suits an always-on process; a tab open only part of the day would lose
whole rounds (sent at 16:00 one day, open 09:00–15:30 the next: nothing).

## Claims (Unlock)

`claim()` runs three independent claims from the vault; each says what it
did, why it skipped, or its error.

1. **On-chain rewards**: `hub.claim()` (`C/next/SatoriHub.sol:802`) when
   `lens.getTotalClaimableRewards(vault)` > 0, as the dapp
   (`UI/hooks/useDashboard.ts:128,288-311`). The vault earns as a staker:
   its share of the identity's correct calls (fee 0), folded in at claim time
   (`C/SatoriRewards.sol:1285-1320`). Lite never claims these.
2. **Merkle**: `GET {central}/api/v1/merkle/proof/{vault}` alone, as Lite
   (ROUTES:1321-1331). Its 404 says which case
   (`central/src/api/v1/endpoints/merkle.py:45-58`): "no reward drop has been
   published yet", or "… is not in the current drop"; prod, which lacks the
   route ([issue](../issues/central-prod-missing-base-routes.md)),
   answers a plain "Not Found". Then `merkle.claimMerkle(amountWei, proof)`
   when `amountWei > alreadyMintedTo(vault)` (ROUTES:1360-1388, BC:94-104).
   The contract pays what its reserve allows and keeps the rest for a later
   claim (`C/SatoriMerkle.sol:196-201`), so the amount reported is
   `alreadyMintedTo` at the claim's block minus before.
3. **Airdrop**: `airdrop.claimAirdrop()` when `claimableAirdrop(vault)` > 0
   (ROUTES:1394-1440, BC:107-121).

## Send (Unlock)

From the vault: ETH (a plain transfer, estimated first, no pad), or SATORI
(`token.transfer`) when it is not transfer-locked by the rule above (the app
says until when before it simulates). The card shows the identity's ETH as
daily batches of gas and warns below 7: a batch is counted at 1,500,000 gas
(the estimate + `HOOK_GAS`, which the node wants covered up front) at 2 × the
gas price. Measured on the fork: 408k gas for a round's first one-game batch,
645k–790k once it also scores the previous prediction.

## Deviations from Lite and the dapp, and why

| Deviation | Why |
|---|---|
| Base streams come from the registry (`getAllDataStreams`, `binaryGameByStream`, `getHistoryPage`), not from the bridge's Nostr streams `satori-84532-1…32` (START:457-517); only games with voting weight > 0 are kept. | No relay needed, and the same values the engine anchors on; the dapp reads the registry too. The weight test replaces the bridge's choice: anyone can add streams for a tiny burn, and an unweighted game earns nothing (SatoriEngine.sol:828). |
| The forecast is made at batch time from the registry's history, horizon max(24 h, cadence) in n = max(1, floor(horizon / max(12 h, cadence))) equal steps; Lite reads its latest relay `_pred` (t2 at the stream's cadence). | Lite's step = cadence gives a 2 h horizon on an hourly stream for a 24 h game, and two days on a daily one; the owner's rule is one cadence, and the round scores 24 h. |
| Due once per UTC round at the first check, not every 24 h from the last submit (START:1256-1274). | A tab is open part of the day ([when in the round](#when-in-the-round)). |
| Each game is simulated alone and only passing games are sent; Lite sends all. Lite's named-game wait (24 h since its last submit) and its resend without named games are not kept. | One stale game no longer sinks the batch. Lite needs the wait and the resend because it does not simulate; the simulate applies the contract's own named rule. |
| The hash is kept when the batch is sent and the batch stored after its receipt; Lite stores its time before sending. | A reverted send no longer loses the day, and a tab closed before the receipt never sends twice. |
| A max-fee ceiling for the unattended batch (2 gwei by default); the tip from `eth_maxPriorityFeePerGas`. | Nobody watches the batch; Lite pays whatever the gas price is. |
| An RPC on another chain is refused. | A wrong RPC must not take writes. |
| `setAllowedDelegator(vault)` is sent by the identity (the dapp); Lite does not. | Only our vault can stake with the identity. |
| `hub.claim()` when the lens says > 0 (the dapp); Lite never claims on-chain rewards. | They are the vault's staking earnings. |
| The transfer lock is shown with `>=` (the token's rule); Lite's display uses `>`. | Lite shows the tokens free one round early. |
| Words: Lite's "Stake" / "Unstake" (the owner's choice, 2026-10-18), not the dapp's; the token's transfer lock is "can't be sent". | The app's Lock/Unlock is the passphrase. |
| The vault's Base address is computed from its public key, in clear in the keys record. | Status without Unlock; Lite needs the decrypted vault. |
| The dev server's default RPC is a local fork (`/rpc`). | By default a dev checkout does not send to a public chain. |
| Every contract write's gas limit is the estimate + 500,000. | The token's try/catch hook ([issue](../issues/token-hook-gas-estimate.md)). |
| A named stream (a signed counter) is forecast on changes (`bar1d`). | Lite's engine falls back to the last value, which votes DOWN forever. |

## UI and agents

- **Settings › Keys** holds both Base addresses, the only addresses the app
  shows. Home has the claimable rewards with Claim, and on a computer the
  vault and the gas in days ([health.md](health.md)).
  The **Wallet** tab's **Base** card: the round, the active RPC in plain words (the local fork
  named "Local test chain"; the URLs on hover); the identity's ETH as daily
  batches of gas (red below 7, once staked: before that the identity has
  no batch to pay for); the vault's SATORI and ETH; Staking ("Staked: 100
  SATORI with this neuron"; until then "Not staked: Stake with this neuron,
  below"); Transfers ("Staked SATORI can't be sent until you unstake", after
  Unstake "SATORI can be sent from <date> (round N)", then "Free to send");
  what is claimable; the last batch (round, time, each game's direction, what
  was left out, the tx); the last check and the next ("Waits until you stake"
  until then); under them, who plays (`base-play`): while staked "Your
  SATORI is staked with this neuron, so it can't also play Satori Daily by
  hand. Unstake to play manually.", while not "Stake with this neuron to let
  it predict every round, or play Satori Daily by hand.", with Satori Daily
  linked. Stake with this neuron or Unstake, Claim, and Send from the vault
  (SATORI or ETH), each asking
  for the passphrase in place while the vault is locked; each action lists its
  transactions in plain words ("Identity: fee to 0"; the call on hover). Tx
  hashes link to the explorer, except on a local fork. **Settings**: Base
  RPC and the batch's max fee (gwei), prefilled with what is stored, both
  checked before either is saved (`base.setSettings`).
- Agents: `window.satori`'s Base methods and their shapes are in
  [/llms.txt](../../public/llms.txt), the one reference.

## Storage

`meta` keys only, no migration: `base_rpc_url` and `base_max_fee_gwei` (the
settings), `base_pending_batch` (a batch sent and not yet confirmed: its
round, hash, games) and `base_last_batch` (the last batch mined, above; a
game's `latest` and `forecast` as decimal strings; a batch from before the
horizon rule has `t2` instead) ([storage.md](storage.md)). The
config cache (1 h) is in memory and per central: another central URL is
asked at once.

## Testing

- `npm test`: `src/chain/chain.test.js` (viem against `test/fake-rpc.js`, a small
  in-memory Satori behind a custom transport: the status multicall, the lock
  rule, stake and unstake, streams kept by voting weight, per-game
  simulation, payload bytes, fees from `eth_maxPriorityFeePerGas` and the
  pad, receipts, claims' branches, sends), `src/neuron/base.test.js` (the
  batch flow: forecast, direction, a named game dropped by its simulate,
  unweighted games left out, the hash kept at send and waited for, the round
  from the block, the fee ceiling, persist only after success, the schedule;
  the merkle claim's 404s and a partial payment; an RPC on another chain),
  `abi.test.js` (every ABI entry against the deployed D6 build,
  `test/fixtures/abi-deployed.json`, and, when the public RPC answers, against
  the deployed code: every selector, and each view's answer in the shape
  `abi.js` decodes; a local build of the contracts runs ahead of the chain,
  so it is not the reference),
  `config.test.js`, and the keys' Base addresses against viem.
- `npm run e2e`: `e2e/base.spec.js`, the app with the same fake chain behind
  `/rpc` and a stub central serving a merkle proof: status, Unlock, Stake,
  the batch, claims, Unstake, when SATORI can be sent, a send, and
  `stake()` / `unstake()` from the agent API.
- Against a fork: `BASE_FORK=http://127.0.0.1:8546 npx vitest run
  src/chain/fork.test.js` runs the chain module against the real D6
  contracts on an anvil fork (`node scripts/fork.mjs start --port 8546`):
  stake (three steps), the registry's streams (a new junk stream left
  out: no voting weight) and history, a batch and
  `AlreadyPredicted` after it, the airdrop and merkle claims a round later
  (and that the identity's power then equals the vault's balance), unstake, the
  lock still on in round N, a SATORI send in round N + 1, an ETH send.

### Live, in the running app (2026-10-15)

The dev server (`/rpc` → the fork on 8545), a fresh throwaway browser
profile, central2 for register (its `base/config` answered, so the card says
"central addresses"), its merkle routes stubbed with the fork's proof:

1. Funded: the vault 100 SATORI and 0.1 ETH, the identity 0.1 ETH. Before:
   `predictionDelegateInfo(vault).delegate` 0x0, `effectivePredictorFee(identity)`
   1000, `transferLockedUntil(vault)` 0.
2. Unlock → Stake: `setPredictorFee(0)` and
   `setAllowedDelegator(vault)` by the identity, `delegatePredictionPower(identity)`
   by the vault. After: `predictionDelegateInfo(vault)` = the identity, the identity's
   power 100 SATORI, fee 0, `transferLockedUntil` 16,777,215.
3. 10 s later the identity's batch, on its own: round 20741, game 1 DOWN;
   `predictedStreamsCount(identity, 20741)` = 1.
4. Airdrop loaded (600) and a merkle root (5); a round later: the next batch
   (round 20742), then Claim: merkle 5 SATORI and airdrop 100.69 SATORI
   claimed, on-chain rewards skipped (the lens said 0: a staker's share
   needs its loyalty, which lags). The identity's power followed the vault's
   balance (205.69). Batches each round to 20752, the deployer predicting
   every other round so the default stream moves; at round 20752 the lens
   said 341.82 SATORI and Claim sent `hub.claim()`: claimed.
5. Unstake at round 20752: `transferLockedUntil` 20753. A SATORI
   send was refused in round 20752 ("until round 20753") and the card still
   said locked in round 20753; in round 20754 it said free and 1 SATORI
   went to 0x…dEaD.

After the review (the same day, a fresh fork and profile): a junk stream
made with `fork.mjs stream` (stream 2, game 2, voting weight 0) was on the
registry; Unlock → Stake (three transactions, listed on the card); 10 s
later the identity's batch held one game, game 1 DOWN (`predictedStreamsCount`
1), stream 2 left out; the card's first fact named the RPC "/rpc: the local
fork of Base Sepolia"; Unstake: `transferLockedUntil` 20742 at round
20741.

The finishing pass's smoke (2026-10-15 21:05, a fresh profile, the UI only):
setup, Poll now (central2: 83 of 83 accepted), subscribe to `demo-walk` on
the test relay, `fork.mjs fund` (the identity 0.1 ETH; the vault 0.1 ETH and
50 SATORI), Unlock → Stake (three transactions) → 12 s later the
identity's batch, round 20741, game 1 DOWN.

The staking words, live (2026-10-18 01:48 UTC chain time, a fresh profile on
the dev app, the fork; `fork.mjs fund`: the identity 0.1 ETH, the vault 0.1
ETH and 100 SATORI): Home's card said "Your vault's SATORI isn't earning on
Base. Stake with this neuron." (button Stake, chip "Not staked"); Settings ›
Unlock, then the Wallet's "Stake with this neuron": "Staked with this
neuron." with its three transactions, Staking "Staked: 100 SATORI with this
neuron", Transfers "Staked SATORI can't be sent until you unstake"; 19 s
later the identity's batch, round 20744, game 1 DOWN, and Home's Base chip
"Round 20744 sent", the vault "100 SATORI · staked"; Unstake: "Unstaked.",
Transfers "SATORI can be sent from Oct 20, 00:00 UTC (round 20746)",
`transferLockedUntil` 20745; `window.satori` has `stake` and `unstake`, the old names gone.
The Wallet's card staked, with the batch and the Stake transactions
(`docs/screenshots/base.png`), and Home then
([phone](../screenshots/home-staked-live-phone.png),
[computer](../screenshots/home-staked-live-desktop.png)).

## The local fork (dev)

`node scripts/fork.mjs` (anvil 1.8.5 at `~/.foundry/bin`):

- `start [--port 8545]`: an anvil fork of Base Sepolia (chain 84532, the real
  addresses) with 2 s blocks, as Base makes them, so chain time moves.
- `fund <address…> [--eth 0.1] [--satori 100]`: ETH by `anvil_setBalance`;
  SATORI from the deployer (`0x9d31…8817`, impersonated).
- `airdrop <address> <SATORI>`: loads an airdrop allocation.
- `merkle <address> <SATORI>`: sets a merkle root over that address and a
  filler entry, and prints the proof as central's `/merkle/proof` shape (a
  stub central serves it). The merkle lane's reserve is 0 in the round D6
  was deployed and accrues each round, so claim a round later.
- `advance [days]`: moves chain time and mines.
- `predict [up|down]`: the deployer predicts the default game, so the default
  stream's next value moves (and stakers' rewards can show).
- `stream [name]`: a new stream from the deployer (a 0.001 SATORI burn) with
  one value; its game has no voting weight, so the batch leaves it out.
- `stop [--port 8545]`: stops the fork `start` began (its pid is in
  `.fork.<port>.pid`, its log in `.fork.<port>.log`).
