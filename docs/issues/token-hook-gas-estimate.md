# A staked vault that receives SATORI with an estimated gas limit can never unstake

**Status:** Fixed in contracts (humble 86e2bdb3); live once D7 deploys · **Kind:** fixable flaw (contracts) · **Fix in:** `contract/satori` branch `humble` (86e2bdb3, sweep item B1, stamped in 43412a4a) · **Severity:** on D6 (deployed from d9d22632), anyone can trap any staked vault's SATORI for good, until D7

**The fix (contracts, humble 86e2bdb3).** The token reverts a transfer with
`HookFailedWithoutReason()` when its hook fails with no revert data (out of
gas), instead of swallowing it; the hub passes an empty-returndata Rewards
failure up unchanged; the rewards contract's subtraction of the booked amount
stays as a second layer. Tests: `satori/test/next/DelegationSyncGas.test.js`
and `SatoriToken.test.js` (MockTransferHook modes 1 to 3). D7, deployed from
`humble` at or after those commits, fixes the freeze; D6 still has it.

**What the app does until D7** (2026-10-19, [../design/health.md](../design/health.md#staking-out-of-sync)):
Stake is advice, its card saying the risk before staking; the frozen state
is detected exactly (the identity accepts only this vault, so its power must
equal the vault's SATORI) and shown as *Staking is out of sync* on Home, the
Contract chip and the Wallet card ("Unstaking will fail until the contract
fix. Don't add SATORI to the vault."); Unstake says the same instead of
"reverted: Panic". On D7 a starved transfer reverts with
`HookFailedWithoutReason`, which the app says as "The transaction ran out of
gas; try again" (`src/chain/abi.js` `NEXT_ERRORS`). `node scripts/fork.mjs
grief <vault>` reproduces the freeze on the local fork.

Found on the fork while building step 6; confirmed independently on a fork of
Base Sepolia (block 48160485, round 20741; the deployed D6 bytecode is source
d9d22632, the rewards contract recompiled byte-identical). Paths are relative
to `/code/Satori/`; `C` = `contract/satori/contracts`.

## Precondition

A staked address (one that has called `delegatePredictionPower`) receives
SATORI (any transfer in, a claim, a mint) in a transaction whose gas limit is
the node's `eth_estimateGas` answer, the default of every wallet and library
(viem, ethers, web3.py's `build_transaction`, cast). Anyone can send it: 1 wei
of SATORI to the vault, or the permissionless `airdrop.claimAirdropFor(vault)`.

## Mechanism (verified)

1. The token runs its transfer hook in `try … catch { emit
   TransferHookFailed }` with all the gas left (`C/next/SatoriToken.sol:839-842`).
   The token is not a proxy.
2. The hub's `onTokenTransfer` wraps `rewards.syncPredictionDelegation` in a
   second try/catch that emits `ChildSyncFailed` (`C/next/SatoriHub.sol:462-466`).
3. The sync (`C/SatoriRewards.sol:1776-1847`) is what adds received SATORI to
   the power of the address it stakes with. When it is skipped, that booked
   power is less than the staker's balance.
4. Unstaking, the hub passes the live balance, `token.balanceOf(user)`
   (`C/next/SatoriHub.sol:874`), and rewards subtracts it from that
   power: `predictionDelegateInfo[previousDelegate].power - uint96(power)`
   (`C/SatoriRewards.sol:1884`): Panic 0x11, now and in every later round.
5. The vault stays locked `LOCK_INDEFINITE` (`C/next/SatoriHub.sol:75,426-429`;
   `C/SatoriRewards.sol:2024`): a transfer out reverts `Locked`; unstaking,
   staking with another address and `burnForVote` all panic. Only `claim()` still works.

**The gas band.** The hook runs in full only at ≥ 169,649 gas: the four
nested frames each keep back 1/64, so the hook needs about 4.1 % over the gas
used. At 150k–169,648 the inner catch fires (`ChildSyncFailed`); lower, the
outer one (`TransferHookFailed`). The public Base Sepolia RPC (reth) estimates
165,420 for a transfer to a real staked vault, so **on the real chain it is
`ChildSyncFailed`**; anvil estimates 110,574 (`TransferHookFailed`).
Monitoring must watch both events. ("The estimate is the least gas at which
the transaction succeeds" holds for anvil only; reth's estimate falls in the
inner band.)

## Exposure

- **Any third party can grief any staked vault**: 1 wei with a default
  estimate, or `claimAirdropFor(vault)` with its estimate.
- **The real D6 vault `0x03AbFED741a344C578304040D6CACAc86960e97d`** (100
  SATORI, staked with `0xe8Dfe519…1FFF`) is exposed now.
- **Co-stakers**: the shortfall lands on whichever staker with that
  address unstakes last.
- **No admin recovery**: no function resets that power or the lock.
  The only workaround: another wallet stakes at least the shortfall with the
  same address, so the stuck vault can leave; that wallet is then stuck in
  its place.
- **Satori Lite** claims from the vault through `build_transaction`, which
  uses the raw estimate (`neuron/web/routes.py:1382,1431`; satorilib
  `chain/evm.py:60-93`). **The dapp** claims through ethers v6, which uses the
  raw estimate (`contract/satori-ui/src/hooks/useDashboard.ts:288-311`).
  **The relayer** uses estimate × 1.2, probably enough, untested. **The
  operator's airdrop sweep** uses the default estimate
  (`contract/satori/scripts/sweep-airdrop.js:237`). Wallets' own buffers
  (MetaMask's) are unverified.
- **This app** sends its own contract calls with 500,000 gas over the
  estimate (`HOOK_GAS`, `src/chain/index.js`), so its claims keep the books
  right (`src/chain/fork.test.js` checks the identity's power equals the
  vault's balance after them, and that the vault then unstakes). That
  protects only its own writes: a transfer or `claimAirdropFor` that someone
  else sends to its user's vault can still brick it.

## Fix

**Now: a rewards UUPS upgrade** (tested on the fork, `upgradeTo`
0x5a886170…): at `C/SatoriRewards.sol:1884`, subtract what this staker
(`delegator` below) **booked**, not its live balance. The stuck vault then
unstakes, co-stakers stay exact, and staking again books the live balance.

```solidity
uint256 booked;
{ uint256 n = _delegationPeriods[delegator].length;
  if (n > 0 && _delegationPeriods[delegator][n - 1].endRound == 0)
      booked = _lookupBalanceAt(_delegationPeriods[delegator][n - 1], type(uint24).max); }
uint96 cur = predictionDelegateInfo[previousDelegate].power;
uint96 prevLeft = cur > booked ? cur - uint96(booked) : 0;
predictionDelegateInfo[previousDelegate].power = prevLeft;
emit PredictionUndelegated(delegator, previousDelegate, booked, prevLeft);
```

Optional with it: a permissionless `resync(delegator)`; a receipt whose sync
was skipped earns no staking yield until the staker stakes again.

**At the next redeploy, the root:** the token's and the hub's catches must not
swallow an out-of-gas: revert when the hook failed with `gasleft()` at or
under about 1/64 of what it was given, or drop the hub's try/catch. A gas
floor in the hub cannot work, because the token's catch swallows it.

Not fixes (an earlier version of this note suggested them):

- A gas floor in the token: it needs a redeploy (the token is not a proxy)
  and is not enough while the hub's catch remains.
- A saturating subtraction at `:1884`: it takes the missing power from the
  co-stakers. Subtract the booked amount instead.
