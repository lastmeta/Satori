# Chain

[← OVERVIEW](OVERVIEW.md)

v1 transacts on **Base Sepolia only** (chainId 84532), with viem in the neuron
worker. Evrmore is used in v1 only for message signing ([identity.md](identity.md));
Evrmore transactions come later.

## Config

`GET {central}/api/v1/base/config`, cached 1 h, over bundled DEFAULTS
(`neuron/neuron-lite/satorineuron/base_config.py:20-36,66-88`). Keys:
`chainId, rpcUrl, token, merkle, airdrop, rewards, engine, games, registry, hub,
streamProvider`. DEFAULTS mirror `contract/satori/deployments/baseSepolia.json`.

Prod central returns 404 for this route today; dev central2 serves it
([issue](../issues/central-prod-missing-base-routes.md)). The browser bundles the
addresses and lets the user pick the central and the RPC URL. Default RPC
`https://sepolia.base.org` answers browser preflights (probed 2026-10-14);
public rate limits apply, so reads are batched with multicall. **`eth_getLogs`
is not used**: that RPC caps it at a 200-block range (probed 2026-10-14, error
-32614), about 400 s of Base.

ABIs are copied from `base_predict.py:29-125` (engine, games, hub, token,
rewards, registry) and `base_claim.py:19-76`, plus the registry views below
(`contract/satori/contracts/interfaces/ISatoriRegistry.sol:55-91`). Calldata for a
fixed call is checked against web3's output (`neuron/tests/test_base_claim.py`
builds calldata offline).

## Delegate / revoke

Port of `ensure_delegation` / `ensure_undelegated`
(`neuron/neuron-lite/satorineuron/base_predict.py:242-323`; UI
`neuron/web/routes.py:1440-1529`):

**Delegate**
1. If `rewards.effectivePredictorFee(identity) != 0`: identity signs
   `rewards.setPredictorFee(0)` (set-once).
2. If `rewards.predictionDelegateInfo(vault).delegate != identity`: vault signs
   `hub.delegatePredictionPower(identity)`.
3. Set `base_predict_enabled`; run [Base streams](#base-streams) now.

**Revoke**: vault signs `hub.delegatePredictionPower(0x0)`; clear the flag.

**Status**: `predictionDelegateInfo` + `token.transferLockedUntil(vault)`
(`contract/satori/contracts/next/SatoriToken.sol:392`; uint24 max = indefinite),
shown as "transfers locked until". After a write, wait for the receipt and poll
until the read flips: the load-balanced RPC lags (Docker re-reads for the same
reason).

The vault is decrypted only for these writes and the claims.

## Base streams

Replaces `_networkEnsureBaseStreams` (`neuron/neuron-lite/start.py:453-543`).
Docker finds bridge streams on Nostr relays, which needs a connected relay
(it returns early with none, `start.py:466-467`, so a fresh Docker install with
no subscriptions never selects any: `start.py:4410-4412,304-310`). The browser
reads the chain instead, so a fresh install works and v1 needs no relay:

1. `registry.getAllDataStreams()` (`ISatoriRegistry.sol:65`); one multicall of
   `games.binaryGameByStream(id)` (`contract/satori/contracts/SatoriGames.sol:83`);
   keep non-zero. Replaces Docker's fixed 1..32 scan.
2. On first sight of a stream: `registry.getHistoryPage(id, offset, limit)`
   (`ISatoriRegistry.sol:90`; ring buffer of 768,
   `contract/satori/contracts/SatoriRegistry.sol:28`) into `observations`. The
   engine has history on day one.
3. Each tick while delegated: `getLatestUpdateInfo(id)` (`ISatoriRegistry.sol:91`)
   for all games in one multicall; fetch new entries when `latestHour` moved.

Why this is the same data (verified): bridge observations carry the on-chain
round (`start.py:627-633`), and the contract anchors each prediction on the
registry value after pulling a fresh one (`SatoriEngine.sol:772-783`).

## Daily prediction batch

Port of `submitBasePredictions` (`start.py:1143-1239`) and `submit_batch`
(`base_predict.py:157-174`), with a different due rule.

**Due**: whenever delegated and `engine.predictedStreamsCount(identity, round) == 0`,
round = `block.timestamp / 86400` (`SatoriEngine.sol:81,716`;
`base_predict.py:127,203-208`). Checked at every catch-up and once per tick.
Docker's `last + 24 h` rule (`start.py:1256-1281`) suits an always-on process;
in a tab open only part of the day it skips whole rounds (submit 16:00 day N,
tab open 09:00-15:30 day N+1 → round N+1 lost).

1. Skip if not delegated, or `rewards.predictionDelegateInfo(identity).power == 0`.
2. Skip if `predictedStreamsCount(identity, round) != 0`.
3. For each Base game: direction from [engine.md](engine.md#base-direction);
   `gameId = binaryGameByStream(id)`.
4. **Simulate each game** as a one-game `predictMultipleWithPayloads` with
   `simulateContract` from the identity; drop the ones that revert
   (`EmptyStream`, `DuplicatePrediction`, `StaleValue`,
   `SatoriEngine.sol:792-810`). This is the only per-game check: it runs the
   contract's own pull (`updateValues`, `:783`) and its named-game and long-target
   waits (`:800-809`), which no off-chain read reproduces. Docker does not
   pre-check, and one bad game reverts the whole batch
   ([issue](../issues/base-batch-one-bad-game-reverts-all.md)).
5. Write `base_last_submit_ts` **before** sending (as Docker does,
   `start.py:1226-1232`), so a crash never double-spends gas. It is for display
   and crash safety only, not the due rule.
6. Identity signs `engine.predictMultipleWithPayloads([(gameId, toHex([dir]))])`
   with the surviving games.
7. Record in `base_submits`.

Gas: the identity needs Base ETH. The Delegate page shows both addresses' ETH
and warns when low.

## Claims

**Merkle reward** (`base_claim.py:94-104`; `neuron/web/routes.py:1321-1390`):
`GET {central}/api/v1/merkle/proof/{vaultEthAddress}` → `{amountWei, amount,
proof, root}` (`central/src/api/v1/endpoints/merkle.py:45-58`; shape per
`routes.py:1321-1324`). 404 has two meanings: no drop published
(`DropNotAvailable`) or address not in the drop. Call `GET /merkle/root` first
(`merkle.py:26`) so the page can say "no drop published yet" apart from "not in
the drop". Claimable = amount − `merkle.alreadyMintedTo(vault)`; vault signs
`merkle.claimMerkle(amount, proof)`. Blocked on prod central until deployed.

Earning this drop needs the central gate: a reward or balance + pool
contribution ≥ 250 SATORI on the vault's Base address
([OVERVIEW](OVERVIEW.md#how-v1-earns-verified)). The Delegate and Status pages
show the vault's SATORI balance against 250.

**Airdrop** (`base_claim.py:107-121`): read `airdropAllocation`,
`airdropClaimed`, `claimableAirdrop`; vault signs `airdrop.claimAirdrop()`.

**On-chain prediction rewards**: `hub.claim()` lets any account claim its own
rewards (`contract/satori/contracts/next/SatoriHub.sol:802-806`). The **vault**
calls it: as delegator it accrues its share of the identity's wins, folded in at
claim time (`contract/satori/contracts/SatoriRewards.sol:1305-1320`). The
identity's own bucket is near zero with fee 0 and no balance (inferred), so the
page shows the identity's `rewards.unclaimedRewards` (`SatoriRewards.sol:204`)
and offers its claim only when non-zero. The vault's amount is read by
simulating `hub.claim()` from the vault address (no key needed). Docker never
calls `hub.claim`.

## Balances

New in v1, not in Docker (`start.py:4623-4627` hard-returns 0): `getBalance`
(ETH) and `token.balanceOf` for vault and identity, one multicall.

## Gasless relay (later)

`SatoriHub.relay` takes an EIP-712 `RelayRequest` and a relayer pays gas for a
SATORI fee (`contract/satori/contracts/next/SatoriHub.sol:899-990`); the relayer is live at
`https://app.satorinet.io/relayer` with open CORS (probed). Fees: 0.25 SATORI
default, Claim 0 (`contract/relayer/fees.json`). Predict is paid by the
identity, which holds no SATORI, and delegated wallets cannot pay a SATORI fee
(`contract/relayer/README.md:37-39`). Needs a ruling
([issue](../issues/relayer-predict-fee.md)).

## Evrmore (later)

- Balances: ElectrumX JSON-RPC over WSS on port 50004.
  `electrumx1.satorinet.io`, `electrum1-mainnet.evrmorecoin.org` and
  `electrum2-mainnet.evrmorecoin.org` answered over WSS with valid certificates
  (probed 2026-10-14); `evrx-1.satoriog.com` did not. Docker uses raw TCP/TLS
  on 50001/50002 (`satorilib/src/satorilib/electrumx/electrumx.py:103-116`,
  `connection.py:56`), which a browser cannot open.
- SATORIEVR sends: needs a JS asset-transfer builder; `app/libs/evrmorejs-lib`
  exists in the workspace as a starting point. The EVR-less send goes through
  Mundo, which sends no CORS header ([issue](../issues/mundo-no-cors.md)).
- Payment channels: a JS port of the P2SH/CSV scripts
  (`satorilib/src/satorilib/wallet/evrmore/scripts/channels/`), about 1,500 lines
  of neuron logic (`start.py:1589-3440`). Largest single porting cost.
