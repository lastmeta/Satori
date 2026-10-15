# Base: delegate, the daily batch, claims, send

[← OVERVIEW](OVERVIEW.md)

The neuron predicts on Base the way Satori Lite (`../neuron`, the Docker
neuron) does: the **vault** delegates its prediction power to the
**identity**, and the identity signs one batch of up/down predictions a day
on its own, with no passphrase. The vault signs only what moves or locks its
funds: delegating, stopping, claims and sends, each after **Unlock**. Where
the dapp (`../contract/satori-ui`) goes further than Lite (it claims on-chain
rewards, restricts who may delegate to the key, mirrors the engine's predict
gate), the browser follows the dapp.

```
page load ─▶ config (bundled D6 addresses, central's /api/v1/base/config over them, 1 h)
          └─▶ status: one multicall (ETH ×2, SATORI, delegation ×2, fee, allowedDelegator, lock, round, claimable ×2)
Unlock ─▶ Delegate prediction power: identity setPredictorFee(0) → identity setAllowedDelegator(vault) → vault delegatePredictionPower(identity)
       └─▶ Claim: hub.claim() · merkle (central's proof) · airdrop      Send: ETH, or SATORI when not transfer-locked
each round (the identity, no unlock): power > 0 and no batch yet ─▶ registry streams with a game ─▶ history ─▶ engine
          ─▶ UP/DOWN per game ─▶ simulate each game alone ─▶ predictMultipleWithPayloads(the ones that pass) ─▶ receipt ─▶ persist
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
uncompressed public key. The vault's Base address is computed from the public
key in `vault.yaml`, so the status needs no Unlock (Lite's `vault.ethAddress`
needs the decrypted vault). Transactions are signed inside the key's signer
(`src/keys/index.js`), which Lock wipes; the private key is never handed to
viem as a string (`src/chain/index.js` wraps the signer in a viem custom
account).

## Config

- **Addresses** (`src/chain/config.js`): BCFG's DEFAULTS (`:20-36`), plus
  `lens` and Multicall3 from the dapp (`UI/contracts/addresses.ts:199-221`);
  they mirror `contract/satori/deployments/baseSepolia.json`. Central's
  `GET /api/v1/base/config` overlays them (non-empty values only, and only for
  chain 84532), cached 1 h in memory as BCFG does (`:16,66-88`). central2
  answers it; prod returns 404, so the bundled addresses are used there.
  Central's payload has no `lens`: it always comes from the bundle.
- **RPC** (Settings, `meta.base_rpc_url`): empty means the default. In a
  build: central's `rpcUrl` (else `https://sepolia.base.org`), then
  `https://base-sepolia-rpc.publicnode.com` as a fallback, as the dapp lists
  them (`UI/contracts/addresses.ts:218-221`; viem's `fallback` transport). On
  the dev server the default is `/rpc`, which Vite proxies to a local anvil
  fork of Base Sepolia on `127.0.0.1:8545` (`scripts/fork.mjs`), so a dev
  checkout never sends to a public chain, the same rule as the dev central
  and the test relay. A setting is an `https://` URL or a same-origin path;
  the page's CSP (`connect-src 'self' https:`) allows both.

## Status (no Unlock)

One `aggregate3` call to Multicall3 (`src/chain/index.js`, `status()`), plus
`eth_gasPrice`:

| Read | For |
|---|---|
| `getEthBalance(identity)`, `getEthBalance(vault)` | gas; the identity's balance is shown as days of batches left |
| `token.balanceOf(vault)` | the vault's SATORI |
| `rewards.predictionDelegateInfo(vault)` | whom the vault delegates to |
| `rewards.predictionDelegateInfo(identity)` | the identity's incoming power (BP:243-248) |
| `rewards.effectivePredictorFee(identity)` | 10 % until set to 0 (`C/SatoriRewards.sol:119-143`) |
| `hub.allowedDelegator(identity)` | who may delegate to the identity (`C/next/SatoriHub.sol:813-819,1007`) |
| `token.transferLockedUntil(vault)` | the transfer lock |
| `token.getCurrentRound()`, `getCurrentBlockTimestamp()` | the round (`block.timestamp / 86400`, `C/next/SatoriToken.sol:329-331`) and chain time |
| `lens.getTotalClaimableRewards(vault)` | on-chain rewards (`C/SatoriRewardsLens.sol:319-324`) |
| `airdrop.claimableAirdrop(vault)` | the vested airdrop (`C/SatoriAirdrop.sol:187-191`) |

Each read may fail on its own (`allowFailure`), so one reverting view does
not hide the rest.

**The transfer lock.** The token refuses a transfer while
`transferLockedUntil != 0 && transferLockedUntil >= currentRound`
(`C/next/SatoriToken.sol:816-821`). `2^24 − 1` means "while delegated"
(`C/next/SatoriHub.sol:426-429`); stopping sets it to the current round + 1
(`:431-434`), so SATORI is transfer-locked through round N = R + 1 and free
from round N + 1, at 00:00 UTC. The card says "transfer-locked until round
N (free from <date>)". Lite's `stake_status` uses `lock_round > current`
(BP:316) and so shows the tokens as free one round early.

## Delegate prediction power (Unlock)

Lite's "Enable staking" (`ensure_delegation`, BP:273-290; ROUTES:1485-1529)
plus the dapp's instant-signing setup (`UI/components/GameWalletPanel.tsx:536-595`):

1. If `effectivePredictorFee(identity) != 0`, the identity sends
   `rewards.setPredictorFee(0)` (BP:281-282). It is set-once
   (`C/SatoriRewards.sol:651-669`, `AlreadySet`): a key whose fee was ever
   set to something else keeps it, and the simulate says so before any gas.
2. If `allowedDelegator(identity) != vault`, the identity sends
   `hub.setAllowedDelegator(vault)`, as the dapp does (`GameWalletPanel.tsx:545`):
   only our vault can then delegate to the identity
   (`C/next/SatoriHub.sol:842-846`). Lite skips this step.
3. If `predictionDelegateInfo(vault).delegate != identity`, the vault sends
   `hub.delegatePredictionPower(identity)` (BP:286-287).

**Stop delegating**: the vault sends `delegatePredictionPower(0x0)`
(BP:292-301). SATORI stays transfer-locked through the next round (above).

Words: the app already says Unlock/Lock for the vault's passphrase, so
delegation is "Delegate prediction power" / "Stop delegating", the dapp's
words (`UI/components/DelegationTab.tsx:159`), and its result is "SATORI
transfer-locked …". Lite calls the same thing "Staking" ("Stake your vault
& predict on Base").

**Sending a transaction** (`src/chain/index.js`, `write()`), as EVM:60-93:
simulate the call first (a revert throws with the contract's error name and
costs no gas), estimate, fees `maxFeePerGas = 2 × gasPrice`,
`maxPriorityFeePerGas = gasPrice` (EVM:74-75), send, wait for the receipt, and
throw unless its status is success. The gas limit is the estimate + 500,000
(`HOOK_GAS`; unused gas is not charged): the token runs its transfer hook in a
try/catch, so the bare estimate starves the hook, and SATORI that reaches a
delegated vault that way (any claim) leaves it unable to ever undelegate. Found
on the fork while building this step
([issue](../future/issues/token-hook-gas-estimate.md)); Lite and the dapp send
with the bare estimate. After a write the app re-reads until the change shows, 5 × 1 s
as Lite (`_stake_status_after`, ROUTES:1449-1463), then trusts the receipt:
the public RPC is load-balanced and lags a block or two. Writes run one at a
time (one queue for both keys), so the identity's batch and its setup never
race for a nonce.

## The daily batch (the identity, on its own)

Port of `submitBasePredictions` (START:1143-1236) and `submit_batch`
(BP:157-174), with the dapp's predict gate done by simulation
(`UI/lib/predictGate.ts:14-50`).

1. **Due** once per UTC round: skip when the identity's incoming power is 0
   (START:1171) or `engine.predictedStreamsCount(identity, round) != 0`
   (START:1174, BP:213-217).
2. **Streams**: `registry.getAllDataStreams()`, then in one multicall
   `games.binaryGameByStream(id)` (keep `!= 0`), `registry.isNamedStream(id)`
   (a revert reads as not named, as BP:223-230; on D6 it reverts for unknown
   ids) and `registry.getLatestUpdateInfo(id)` (the cadence). Lite finds the
   same streams as Nostr bridge streams `satori-84532-<id>` (START:457-517);
   the browser reads the registry, as the dapp does, so it needs no relay.
3. **History**: `registry.getHistoryPage(id, 0, 768)` (the whole ring,
   oldest first; `C/SatoriRegistry.sol:1375-1393`). Values are `int232`;
   only their ratios matter here.
4. **Forecast** with the engine (`src/engine/`) at step = max(12 h, the
   stream's cadence): 12 h for a stream that updates at least that often, so
   t2 is 24 h ahead, the game's daily target (`targetMinutes` 1440) and
   central's horizon ([engine.md](engine.md)); the cadence for a slower
   stream, else `bar1` never sees back-to-back buckets (D6's one stream, the
   default stream, is daily: its t2 is then two days ahead, as Lite's relay
   `_pred` for a daily stream).
5. **Direction**: UP (`0x01`) if t2 > the latest value, else DOWN (`0x02`);
   payload = the one byte (`solidityPacked(['uint8'])`). This is Lite's
   `direction_from(forecast, latest)` (BP:141-143), where `forecast` is
   Lite's latest relay `_pred` for the stream (START:1200-1206), which is t2
   ([nostr.md](nostr.md#the-engines-step)). For an AR(1), t1 and t2 lie on
   the same side of the latest value, so the choice rarely changes a
   direction. As in Lite, a forecast equal to the latest value is DOWN, so a
   `naive` forecast (too little history: D6's daily default stream has two
   values) always votes DOWN, and so does every browser neuron. Fixable, not
   inherent: the parked alternative (a seeded slope rule,
   [../future/design/engine.md](../future/design/engine.md)) was set aside
   for Lite's rule (owner, 2026-10-15).
6. **Named games** wait 24 clock hours after our last submit (BP:146-149,
   `NAMED_WAIT_HOURS`, Lite 639e3ce; the engine's rule at
   `C/next/SatoriEngine.sol:800-809`): left out until then.
7. **Simulate each game alone** as a one-game `predictMultipleWithPayloads`
   from the identity, and keep the ones that pass. A revert names the reason
   (`StaleValue`, `EmptyStream`, `DuplicatePrediction`, …); an RPC failure is
   not a revert and stops the batch until the next check. This fixes Lite's
   "one stale game sinks the batch"
   ([issue](../future/issues/base-batch-one-bad-game-reverts-all.md)): the
   simulate runs the contract's own pull and checks
   (`C/next/SatoriEngine.sol:777-810`), which no off-chain read reproduces.
8. **Send** `predictMultipleWithPayloads` with the games that passed. If the
   chain still answers `DuplicatePrediction` (`0xe372c20e`) and named games
   are in it, resend once without them (BP:157-174).
9. **Persist after the receipt**: `meta.base_last_batch` = `{round, at, hash,
   games: [{streamId, gameId, named, direction, model, latest, t2}], dropped:
   [{streamId, gameId, error}]}`, and `at` (the block's time) is the last
   submit time for the named-game rule. Lite writes the time before sending
   (START:1228-1232), so a revert loses the day; here a failed send is shown,
   and the next check tries again. A tab closed between the send and the
   receipt: the next load reads `predictedStreamsCount` and skips the round.

### When in the round

**At the first check of the round, never held.** Checks run 10 s after the
page loads and after Delegate, then at the next round's start (00:01 UTC on
the chain's clock) and at least hourly; `window.satori.predictBase()` runs one
at once. Why:

- A tab can close at any moment. One batch per round
  (`AlreadyPredicted`, `C/next/SatoriEngine.sol:716`) means a held batch that
  never goes loses every game of the round; a game dropped at send time loses
  only itself, for one round.
- The streams update during the day. A game fails `StaleValue` only when its
  stream has no value newer than our last prediction on it
  (`C/next/SatoriEngine.sol:810`), and a named game fails only when our last
  prediction on it is under 24 clock hours old. Both happen only when the
  batch moves to an earlier hour than the round before. A tab left open sends
  at 00:01 every round, the same hour each day, so every game passes; the
  default stream (id 1) is written by the batch's own first predict of the
  round (`flushDefaultStream`, `C/next/SatoriEngine.sol:619-638`).
- When a game does fail (an earlier hour than yesterday, a dead stream), it
  is listed with its reason under the last batch, and the next round takes it
  again: 24 clock hours after a dropped named game's last prediction is always
  inside the next round.

Lite instead sends every 24 h from its last submit (START:1256-1274), which
suits an always-on process; a tab open only part of the day would lose
whole rounds (sent at 16:00 one day, open 09:00–15:30 the next: nothing).

## Claims (Unlock)

`claim()` runs three independent claims from the vault; each says what it
did, why it skipped, or its error.

1. **On-chain rewards**: `hub.claim()` (`C/next/SatoriHub.sol:802`) when
   `lens.getTotalClaimableRewards(vault)` > 0, as the dapp
   (`UI/hooks/useDashboard.ts:128,288-311`). The vault earns as a delegator:
   its share of the identity's correct calls (fee 0), folded in at claim time
   (`C/SatoriRewards.sol:1285-1320`). Lite never claims these.
2. **Merkle**: `GET {central}/api/v1/merkle/root`; a 404 there is "no drop
   published" (central's `DropNotAvailable`, or prod, which lacks the route:
   [issue](../future/issues/central-prod-missing-base-routes.md)). Then
   `GET /api/v1/merkle/proof/{vault}`; a 404 is "this vault is not in the
   drop" (`central/src/api/v1/endpoints/merkle.py:26-58`). Then
   `merkle.claimMerkle(amountWei, proof)` when `amountWei >
   alreadyMintedTo(vault)` (ROUTES:1321-1388, BC:94-104). The contract pays
   what its reserve allows and keeps the rest for a later claim
   (`C/SatoriMerkle.sol:185-210`).
3. **Airdrop**: `airdrop.claimAirdrop()` when `claimableAirdrop(vault)` > 0
   (ROUTES:1394-1440, BC:107-121).

## Send (Unlock)

From the vault: ETH (a plain transfer, estimated first), or SATORI
(`token.transfer`) when it is not transfer-locked by the rule above (the app
says until when before it simulates). The card shows the identity's ETH as
daily batches of gas and warns below 7: a batch is counted at 1,500,000 gas
(the estimate + `HOOK_GAS`, which the node wants covered up front) at 2 × the
gas price. Measured on the fork: 408k gas for a round's first one-game batch,
645k–790k once it also scores the previous prediction.

## Deviations from Lite and the dapp, and why

| Deviation | Why |
|---|---|
| Base streams come from the registry (`getAllDataStreams`, `binaryGameByStream`, `getHistoryPage`), not from Nostr bridge streams `satori-84532-1…32` (START:457-517). | No relay needed, all streams, and the same values the engine anchors on; the dapp reads the registry too. |
| The forecast is made at batch time from the registry's history, step max(12 h, cadence); Lite reads its latest relay `_pred` (t2 at the stream's cadence). | Lite's step = cadence gives a 2 h horizon on an hourly stream for a 24 h game. |
| Due once per UTC round at the first check, not every 24 h from the last submit (START:1256-1274). | A tab is open part of the day ([when in the round](#when-in-the-round)). |
| Each game is simulated alone and only passing games are sent; Lite sends all and retries once without named games. | One stale game no longer sinks the batch (Lite's resend is kept as a fallback). |
| The submit time is stored after the receipt; Lite stores it before sending. | A reverted send no longer loses the day; `predictedStreamsCount` guards against a double send. |
| `setAllowedDelegator(vault)` is sent by the identity (the dapp); Lite does not. | Only our vault can delegate to the identity. |
| `hub.claim()` when the lens says > 0 (the dapp); Lite never claims on-chain rewards. | They are the vault's delegator earnings. |
| The transfer lock is shown with `>=` (the token's rule); Lite's display uses `>`. | Lite shows the tokens free one round early. |
| Words: "Delegate prediction power" / "Stop delegating" (the dapp), not Lite's "Staking". | The app's Lock/Unlock is the passphrase. |
| The vault's Base address is computed from `vault.yaml`'s public key. | Status without Unlock; Lite needs the decrypted vault. |
| Named games wait on the chain's clock (block time), not the local clock. | The same rule as the contract, also on a fork moved forward in time. |
| The dev server's default RPC is a local fork (`/rpc`). | A dev checkout never sends to a public chain. |
| Every write's gas limit is the estimate + 500,000. | The token's try/catch hook ([issue](../future/issues/token-hook-gas-estimate.md)). |

## UI and agents

- Home's **Base** card: the RPC and round; the identity's Base address and its
  ETH as daily batches of gas (red below 7); the vault's Base address, SATORI
  and ETH; the delegation; the transfer lock; what is claimable; the last batch
  (round, time, each game's direction, what was left out, the tx); the last
  check and the next. After Unlock: Delegate prediction power or Stop
  delegating, Claim, and Send from the vault (SATORI or ETH). **Settings**:
  Base RPC.
- `window.satori`: `base()`, `delegate()`, `undelegate()`, `claim()`,
  `predictBase()`, `send({ asset, to, amount })`, `setBaseRpc(url)`;
  `status().base` ([/llms.txt](../../public/llms.txt)).

## Storage

`meta` keys only, no migration: `base_rpc_url` (the setting),
`base_last_batch` (the last batch sent, above) and `base_last_submit_ts`
(chain time of that batch, for the named-game rule).

## Testing

- `npm test`: `src/chain/chain.test.js` (viem against `fake-rpc.js`, a small
  in-memory Satori behind a custom transport: the status multicall, the lock
  rule, delegate and stop, the batch's due rules, per-game simulation, the
  named-game wait and the DuplicatePrediction resend, payload bytes, claims'
  branches, sends), `src/neuron/base.test.js` (the batch flow: forecast,
  direction, persist only after success, the schedule), `abi.test.js` (every
  ABI entry against the contracts' build output), `config.test.js`, and the
  keys' Base addresses against viem.
- `npm run e2e`: `e2e/base.spec.js`, the app with the same fake chain behind
  `/rpc` and a stub central serving a merkle proof: status, Unlock, Delegate,
  the batch, claims, Stop delegating, the lock, a send.
- Against a fork: `BASE_FORK=http://127.0.0.1:8546 npx vitest run
  src/chain/fork.test.js` runs the chain module against the real D6
  contracts on an anvil fork (`node scripts/fork.mjs start --port 8546`):
  delegate (three steps), the registry's streams and history, a batch and
  `AlreadyPredicted` after it, the airdrop and merkle claims a round later
  (and that the delegate's power then equals the vault's balance), stop, the
  lock still on in round N, a SATORI send in round N + 1, an ETH send.

### Live, in the running app (2026-10-15)

The dev server (`/rpc` → the fork on 8545), a fresh throwaway browser
profile, central2 for register (its `base/config` answered, so the card says
"central addresses"), its merkle routes stubbed with the fork's proof:

1. Funded: the vault 100 SATORI and 0.1 ETH, the identity 0.1 ETH. Before:
   `predictionDelegateInfo(vault).delegate` 0x0, `effectivePredictorFee(identity)`
   1000, `transferLockedUntil(vault)` 0.
2. Unlock → Delegate prediction power: `setPredictorFee(0)` and
   `setAllowedDelegator(vault)` by the identity, `delegatePredictionPower(identity)`
   by the vault. After: the vault's delegate = the identity, the identity's
   power 100 SATORI, fee 0, `transferLockedUntil` 16,777,215.
3. 10 s later the identity's batch, on its own: round 20741, game 1 DOWN;
   `predictedStreamsCount(identity, 20741)` = 1.
4. Airdrop loaded (600) and a merkle root (5); a round later: the next batch
   (round 20742), then Claim: merkle 5 SATORI and airdrop 100.69 SATORI
   claimed, on-chain rewards skipped (the lens said 0: a delegator's share
   needs its loyalty, which lags). The identity's power followed the vault's
   balance (205.69). Batches each round to 20752, the deployer predicting
   every other round so the default stream moves; at round 20752 the lens
   said 341.82 SATORI and Claim sent `hub.claim()`: claimed.
5. Stop delegating at round 20752: `transferLockedUntil` 20753. A SATORI
   send was refused in round 20752 ("until round 20753") and the card still
   said locked in round 20753; in round 20754 it said free and 1 SATORI
   went to 0x…dEaD.

The screenshot (`docs/screenshots/base.png`) is from step 4, delegated, with
the last batch shown.

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
