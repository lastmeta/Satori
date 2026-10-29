# Admin: the Satori contract's admin page

[← OVERVIEW](OVERVIEW.md) · the contracts: `SatoriRewards.sol` (`admin`, `setAdmin`, `setCapabilities`,
`setOfficialRelayer`, `setRegistrationFee`), `SatoriHub.sol` (`registerAdapter`, `registerGameAdapter`),
`SatoriEngine.sol` (`setOffchainReporter`), `SatoriVoting.sol` (`setGameApproved`) · ported from the dapp's Admin tab
(`contract/satori-ui/src/components/AdminTab.tsx`, `hooks/useOwner.ts`)

The admin is `SatoriRewards.admin()`: one address, the protocol's operator. On Base Sepolia it is the deployer.

**Who sees it** (the owner, 2026-10-29: "an admin page that only the admin can see"). The **Admin** tab is in the menu
only when the wallet is the admin, read with the Base card (at most every 15 min) and when the tab opens. Hiding it
protects nothing (the contracts refuse anyone else); it keeps a page that means nothing to anyone else out of the way.

Only what the admin alone may do. Two jobs default to the admin but are their own keys, each with its own page: the
emission split (`emissionSplitAuthority`, the off-chain share) and the emission schedule (`emissionAuthority`, the
step multiplier). The dapp's tab mixed them in, with the root publisher's and the airdrop loader's; here each key
gets its own page.

Every action is the wallet's (the inline Unlock in its card; gas from the wallet's Base ETH).

## The cards

- **Capabilities**: a switch for each of the hub's eight (create streams, author games, register stream adapters,
  register game adapters, bounties, stake with someone, name a claimer, vote) and Save, which sets the whole mask
  (`setCapabilities`). The mask has no getter: it is read bit by bit (`capabilityAllowed(bit, 0x0)`). The admin
  itself is always allowed.
- **Games**: each stream's game, approved or not, with Approve / Disapprove (`setGameApproved`). The default game is
  always approved (the contract refuses to set it).
- **Official relayer** (`setOfficialRelayer`; empty: none), **Registration fee** (`setRegistrationFee`, SATORI, above
  0), **Off-chain reporter** (`setOffchainReporter`; empty: off): each its value now, a field and Save.
- **Register an official adapter** (folded): stream or game, its address and name (`registerAdapter` /
  `registerGameAdapter`, no fee).
- **Hand the admin to another address** (folded; typed twice): `setAdmin`, at once (not two-step). The token's appoint
  authority can also replace the admin.

## Agent calls

`admin()` the page's state; `adminCapabilities(bits)`, `adminGame(gameId, approved)`, `adminRelayer(to)`,
`adminRegistrationFee(satori)`, `adminReporter(to)`, `adminRegisterAdapter(kind, address, name)`, `adminTransfer(to)`:
each the card's action, needing Unlock (public/llms.txt).
