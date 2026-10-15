# A delegated vault that receives SATORI with an estimated gas limit can never undelegate

**Status:** open · **Kind:** fixable flaw (contracts) · **Fix in:** `contract/satori` (token or rewards) · **Avoided in the browser app** by sending every write with 500,000 gas over the estimate (`HOOK_GAS`, `src/chain/index.js`)

## Precondition

A delegated address (a vault that has called `delegatePredictionPower`)
receives SATORI (a claim: `hub.claim()`, `claimMerkle`, `claimAirdrop`; or any
transfer in) in a transaction whose gas limit is `eth_estimateGas`'s answer.
That is the default of every wallet and library (viem, ethers, web3.py's
`build_transaction`, cast).

## Finding (verified on an anvil fork of the D6 stack, 2026-10-15)

- The token runs its transfer hook in a try/catch
  (`contract/satori/contracts/next/SatoriToken.sol:831-842`: `try
  ITransferHook(h).onTokenTransfer(…) {} catch { emit TransferHookFailed(…) }`).
  `eth_estimateGas` returns the least gas at which the transaction succeeds,
  and with the failure swallowed that is a limit at which the hook runs out of
  gas. A transfer of 5 SATORI to a delegated vault: estimate 110,574 gas; sent
  with it, the receipt has `TransferHookFailed`; sent with 1,000,000 the hook
  runs (`DelegatePowerSynced`) and uses 162,959.
- Without the hook, the delegate's `power` is not raised by the received
  amount, while the vault's balance is. Undelegating subtracts the balance
  (`contract/satori/contracts/SatoriRewards.sol:1884`:
  `predictionDelegateInfo[previousDelegate].power - uint96(power)`, with
  `power = token.balanceOf(user)` from `SatoriHub.sol:874`): Panic 0x11. It
  stays so in later rounds. The vault's SATORI stays transfer-locked
  (`transferLockedUntil = 2^24 − 1` while delegated), so its funds are stuck.
- Reproduced with `node scripts/fork.mjs`: fund a vault, delegate, then either
  a deployer transfer in or `claimAirdrop()` with the estimate; `eth_call`
  `delegatePredictionPower(0x0)` from the vault → `panic: arithmetic underflow
  or overflow (0x11)`, also a round later. With a large limit, undelegate works.

The dapp sends claims with its wallet's estimate too
(`contract/satori-ui/src/hooks/useDashboard.ts:288-311`), so its users can hit
it; Lite's claims (web3.py's estimate in `build_transaction`, satorilib
`chain/evm.py:60-93`) as well.

## Fix

In the token: require a gas floor before the try (`if (gasleft() <
HOOK_GAS_FLOOR) revert(...)`), so an estimate that starves the hook fails and
the estimator raises the limit; or in rewards: a saturating subtraction on
undelegate, so a missed sync can't brick it (the power figure would still be
short until then). The first fixes the cause.

## Browser workaround

Every write's limit is the estimate + 500,000 gas (only used gas is charged);
`src/chain/fork.test.js` checks that the delegate's power equals the vault's
balance after the claims and that the vault then undelegates.
