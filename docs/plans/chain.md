# Chain: what is still ahead

[← Roadmap](README.md)

Step 6 built Base: config, the status multicall, stake and unstake, the
identity's daily batch, claims (`hub.claim`, merkle, airdrop) and sends.
[../design/base.md](../design/base.md) is the source of truth, with
Lite's and the dapp's file:line evidence and every deviation. What is left
here is for later steps.

## D7 is bundled (2026-10-23); `named` from `getLatestUpdateInfo` is left

D7 moved a stream's named flag into its record, and
`registry.getLatestUpdateInfo(streamId)` returns `bool named` and
`int232 latestValue` after the four it returned on D6. `abi.js` declares them,
`config.js` has D7's addresses and `test/fixtures/abi-deployed.json` is D7's.
Still open, and either works (`isNamedStream` stays in the registry): read
`named` from `getLatestUpdateInfo` in `chain.streams()` instead of a separate
`isNamedStream` call per stream, one call fewer each. The other owed changes
touch nothing the app reads (`PredictionMade` gains `hour`: no events read;
named games refuse bounties: none placed).

## Gasless relay (later)

`SatoriHub.relay` takes an EIP-712 `RelayRequest` and a relayer pays gas for a
SATORI fee (`contract/satori/contracts/next/SatoriHub.sol:899-990`); the relayer is live at
`https://games.satorinet.io/relayer` with open CORS (probed). Fees: 0.25 SATORI
default, Claim 0 (`contract/relayer/fees.json`). Predict is paid by the
identity, which holds no SATORI, and staked wallets cannot pay a SATORI fee
(`contract/relayer/README.md:37-39`). Needs a ruling
([issue](../issues/relayer-predict-fee.md)).

## The airdrop without Unlock (later)

`airdrop.claimAirdropFor(user)` is permissionless and mints only to `user`
(`contract/satori/contracts/SatoriAirdrop.sol:139-147`), so the identity could
claim the vault's vested airdrop on its own schedule, paying the gas. Step 6
claims it from the vault after Unlock, as Lite does.

This app is Base only (owner, 2026-10-16): no Evrmore balances, sends or
payment channels are planned.
