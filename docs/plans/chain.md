# Chain: what is still ahead

[← Roadmap](README.md)

Step 6 built Base: config, the status multicall, delegate and stop, the
identity's daily batch, claims (`hub.claim`, merkle, airdrop) and sends.
[../design/base.md](../design/base.md) is the source of truth, with
Lite's and the dapp's file:line evidence and every deviation. What is left
here is for later steps.

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
