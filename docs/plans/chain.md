# Chain: what is still ahead

[← Roadmap](README.md)

Step 6 built Base: config, the status multicall, delegate and stop, the
identity's daily batch, claims (`hub.claim`, merkle, airdrop) and sends.
[../design/base.md](../design/base.md) is the source of truth, with
Lite's and the dapp's file:line evidence and every deviation. What is left
here is for later steps.

## At the next redeploy (D7): `getLatestUpdateInfo` gains `named`

Contract commit `29311957` (owed since D6, with `219078fe`, `87c50913` and
`eaceb86e`: `contract/HANDOFF-sepolia-redeploy.md`) moves a stream's named
flag into its record, and `registry.getLatestUpdateInfo(streamId)` returns a
fifth value, `bool named`. D6 returns four, as `abi.js` declares them. The
app keeps working at D7 unchanged (a decoder taking the first four ignores
the fifth), but `src/chain/abi.test.js` goes red there on purpose: its live
check sees a fifth word. When D7 deploys:

- refresh `test/fixtures/abi-deployed.json` from the deployed commit's build
  (`ABI_SNAPSHOT=write`, the comment at the top of `abi.test.js`) and move
  `config.js` DEFAULTS to the new addresses;
- declare the fifth output in `abi.js`, and read `named` from
  `getLatestUpdateInfo` in `chain.streams()` instead of a separate
  `isNamedStream` call per stream (one call fewer each; `isNamedStream` stays
  in the registry, so either works);
- recheck the other owed changes against what the app reads: `PredictionMade`
  gains `hour` (the app reads no events), named games refuse bounties (the
  app places none).

## Gasless relay (later)

`SatoriHub.relay` takes an EIP-712 `RelayRequest` and a relayer pays gas for a
SATORI fee (`contract/satori/contracts/next/SatoriHub.sol:899-990`); the relayer is live at
`https://app.satorinet.io/relayer` with open CORS (probed). Fees: 0.25 SATORI
default, Claim 0 (`contract/relayer/fees.json`). Predict is paid by the
identity, which holds no SATORI, and delegated wallets cannot pay a SATORI fee
(`contract/relayer/README.md:37-39`). Needs a ruling
([issue](../issues/relayer-predict-fee.md)).

## The airdrop without Unlock (later)

`airdrop.claimAirdropFor(user)` is permissionless and mints only to `user`
(`contract/satori/contracts/SatoriAirdrop.sol:139-147`), so the identity could
claim the vault's vested airdrop on its own schedule, paying the gas. Step 6
claims it from the vault after Unlock, as Lite does.

This app is Base only (owner, 2026-10-16): no Evrmore balances, sends or
payment channels are planned.
