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
public rate limits apply, so reads are batched with multicall.

ABIs are copied from `base_predict.py:29-75` and `base_claim.py:19-76`; calldata
for a fixed call is checked against web3's output (the existing
`neuron/tests/test_base_claim.py` builds calldata offline).

## Lock / unlock

Port of `ensure_delegation` / `ensure_undelegated`
(`neuron/neuron-lite/satorineuron/base_predict.py:242-323`; UI
`neuron/web/routes.py:1440-1529`):

**Lock**
1. If `rewards.effectivePredictorFee(identity) != 0`: identity signs
   `rewards.setPredictorFee(0)` (set-once).
2. If `rewards.predictionDelegateInfo(vault).delegate != identity`: vault signs
   `hub.delegatePredictionPower(identity)`.
3. Set `base_predict_enabled`; run stream selection now.

**Unlock**: vault signs `hub.delegatePredictionPower(0x0)`; clear the flag.

**Status**: `predictionDelegateInfo` + `token.transferLockedUntil(vault)` (uint24
max = indefinite). After a write, wait for the receipt and poll until the read
flips: the load-balanced RPC lags (Docker re-reads for the same reason).

The vault is decrypted only for these writes and the claims.

## Stream selection

Port of `_networkEnsureBaseStreams` (`neuron/neuron-lite/start.py:453-543`), run
each reconcile while locked:

1. For ids 1..32 build `satori-<chainId>-<id>` under provider
   `streamProvider` (the bridge's Nostr pubkey). Skip ids we already have, or
   that the user unsubscribed.
2. One multicall: `games.binaryGameByStream(id)` for all 32; keep non-zero.
3. Find them on relays; never auto-subscribe a paid stream.
4. Subscribe; add a `<name>_pred` publication.

Docker scans a fixed 32 (`BASE_STREAM_SCAN`); kept for parity. Inferred: game
enumeration from registry events would be cleaner and is a later change.

## Daily prediction batch

Port of `submitBasePredictions` (`start.py:1143-1239`) and `submit_batch`
(`base_predict.py:157-174`). Due when `now ≥ base_last_submit_ts + 24 h`
(scheduling in [runtime.md](runtime.md)).

1. Skip if not locked, or if `rewards.predictionDelegateInfo(identity).power == 0`.
2. Skip if `engine.predictedStreamsCount(identity, block.timestamp / 86400) != 0`
   (already predicted this round).
3. For each active `_pred` publication whose source is `satori-<chainId>-<id>`:
   latest forecast vs latest observation → direction (UP 1 / DOWN 2, ties DOWN,
   `base_predict.py:141-143`); `gameId = binaryGameByStream(id)`;
   `named = registry.isNamedStream(id)`.
4. **Pre-check each game** with `simulateContract` on a one-game batch and drop
   the ones that revert (`StaleValue`, `EmptyStream`, `DuplicatePrediction`).
   Docker does not, and one bad game reverts the whole day's batch
   ([issue](../issues/base-batch-one-bad-game-reverts-all.md)).
5. Named games are included only if 24 clock hours have passed since the last
   prediction (`named_allowed`, `base_predict.py:146-149`). The browser reads
   the last prediction hour from chain (`PredictionMade` carries the hour,
   `contract/satori/contracts/next/SatoriEngine.sol:326`) instead of trusting local storage,
   which can be wiped. The simulate in step 4 also catches it.
6. Write `base_last_submit_ts` **before** sending (as Docker does,
   `start.py:1226-1232`), so a crash never double-spends gas.
7. Identity signs `engine.predictMultipleWithPayloads([(gameId, toHex([dir]))])`.
8. Record in `base_submits`.

Gas: the identity needs Base ETH. The Lock page shows both addresses' ETH and
warns when low.

## Claims

**Merkle reward** (`base_claim.py:94-104`; `neuron/web/routes.py:1321-1390`):
`GET {central}/api/v1/merkle/proof/{vaultEthAddress}` → `{amountWei, proof}`
(404 = not in the drop); claimable = amount − `merkle.alreadyMintedTo(vault)`;
vault signs `merkle.claimMerkle(amount, proof)`. Blocked on prod central until
deployed.

**Airdrop** (`base_claim.py:107-121`): read `airdropAllocation`,
`airdropClaimed`, `claimableAirdrop`; vault signs `airdrop.claimAirdrop()`.

**On-chain prediction rewards**: `hub.claim()` (contract
`contract/satori/contracts/next/SatoriHub.sol:802`) is not called by the Docker neuron. v1 adds it pending
owner confirmation (OVERVIEW decision 6).

## Balances

New in v1, not in Docker (`start.py:4623-4627` hard-returns 0): `getBalance`
(ETH) and `token.balanceOf` for vault and identity, one multicall.

## Gasless relay (later)

`SatoriHub.relay` takes an EIP-712 `RelayRequest` and a relayer pays gas for a
SATORI fee (`contract/satori/contracts/next/SatoriHub.sol:899-990`); the relayer is live at
`https://app.satorinet.io/relayer` with open CORS (probed). Fees: 0.25 SATORI
default, Claim 0 (`contract/relayer/fees.json`). It would remove "fund two
addresses with ETH", but Predict is paid by the identity, which holds no SATORI,
and locked wallets cannot pay a SATORI fee (`contract/relayer/README.md:37-39`).
Needs a ruling ([issue](../issues/relayer-predict-fee.md)).

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
