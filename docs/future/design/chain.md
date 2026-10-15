# Chain: what is still ahead

[← Later steps](../README.md)

Step 6 built Base: config, the status multicall, delegate and stop, the
identity's daily batch, claims (`hub.claim`, merkle, airdrop) and sends.
[../../design/base.md](../../design/base.md) is the source of truth, with
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
