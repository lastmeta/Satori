# Dev Fee: the splitters' page

[← OVERVIEW](OVERVIEW.md) · the contract: `contract/satori/contracts/SatoriSplitterImmutable.sol`,
its narrative `contract/docs/narratives/A_splitter.md` · ported from the dapp's Dev fee and Dev fee
admin tabs (`contract/satori-ui/src/components/DevFeeTab.tsx`, `DevFeeAdminTab.tsx`,
`SplitterRotation.tsx`, `hooks/useDevFee.ts`)

The token pays its dev fee to `PLATFORM_FEE_RECIPIENT()` (an immutable on the token): a
`SatoriSplitterImmutable`, the top of a tree of splitters. On Base Sepolia: A
`0x6C57…4238` pays 60% to C `0x52b7…d2ed` and 40% to B `0xc082…F5f7`, and C and B each pay
two people 50/50. A splitter's shares never change; each slot's address can (the payee
moves it), and nothing arrives on its own: a slot's SATORI waits in its splitter until a
`withdraw` pays it, to the slot's payee whoever calls it.

**Who sees it** (the owner, 2026-10-29: "it's not for anybody else"). The **Dev Fee** tab
is in the menu only when the wallet holds a slot in a splitter of the tree, or is (or was
offered) a splitter's authority. The tree is walked from the token each time (A, then the
splitters among its payees), so nothing is configured and a slot moved to the wallet shows
at the next read. Hiding it protects nothing: the splitters are public. It keeps a page
that means nothing to anyone else out of the way.

Every action is the wallet's (the inline Unlock in its card; gas from the wallet's Base ETH).

## The cards

- **How it splits** (the owner, 2026-10-29: "a representation of the contract"), at the top:
  the tree as a picture. The top splitter, then each branch as a box (its authority, or
  none; what share must agree to redirect it), then every payee as a dot with its share on
  its line and what it has not claimed yet (its `releasable` plus its part of what still
  waits in the top). The wallet is green (a dot, or "Authority: you"). A line it can change
  carries a word, explained under the picture: **move** (its own slot), **vote** (redirect
  the branch it is in, with the others' agreement), **redirect** (as the branch's authority,
  alone). It shows the line down to the wallet's own splitter and everything under it, not the
  siblings (the owner, 2026-10-29); the top's authority sees everything, a branch's authority
  every branch but only its own branch's payees. Display only: `devFee()` and the actions below cover it.

- **Your share**, one per slot: the splitter, "50% of this splitter · 30% of the whole dev
  fee", and what is claimable: the slot's `releasable` plus its part of what still waits
  one level up (the top's `releasable` for this branch × the slot's share). **Claim** moves
  that down first when there is any (`withdraw` on the top for the branch's slot; anyone
  may) and then claims the slot (`withdraw` on the branch). The dapp has these as two
  buttons; here they are one.
- **Who can trigger your payout** (folded): by default anyone, which is harmless (the
  payout goes to the payee whoever presses it); `setWithdrawCaller(address)` names one
  address (the payee can always still claim), empty reopens it. A move clears it.
- **Move your slot** (folded): `rotateRecipient(newPayee)` hands the slot and every future
  payment to another address. It can't be undone from this wallet, so the address is typed
  twice. The chain refuses the zero address, the splitter itself and an address that
  already holds a slot there; the page says those first.
- **Redirect this splitter** (folded; on a branch where the wallet holds a slot): moves the
  branch's slot in the top to another address, every payee's future income. Proposals
  can't be listed (hash-keyed), so the target is typed and its tally read:
  `approveRotation` / `revokeRotation`, then `rotateAt` by anyone once the threshold is met
  (typed twice).
- **Authority** (when the wallet is a splitter's authority or was offered it): accept an
  offer (`acceptAuthority`); redirect alone (`rotateAt`, typed twice); offer it to another
  address (`transferAuthority`, it moves when they accept); give it up for good
  (`renounceAuthority`, asked first).

SATORI only, as the dapp: the splitters also split ETH and any token, but the dev fee is SATORI.

## Agent calls

`devFee()` the page's state; `devFeeClaim(splitter)`, `devFeeTrigger(splitter, caller)`,
`devFeeMoveSlot(splitter, to)`, `devFeeProposal(splitter, to)`, `devFeeVote(splitter, to)`,
`devFeeUnvote(splitter, to)`, `devFeeRedirect(splitter, to)`, `devFeeOffer(splitter, to)`,
`devFeeAccept(splitter)`, `devFeeGiveUp(splitter)`: each the card's action, needing Unlock
(public/llms.txt).
