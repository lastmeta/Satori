# The special keys: a page each

[← OVERVIEW](OVERVIEW.md) · the code: `src/neuron/roles.js` (each key declared once), `src/ui/roles.js` · the admin's
own page: [admin.md](admin.md) · the dev fee's splitters: [devfee.md](devfee.md)

The contracts give a few addresses powers no one else has. The owner (2026-10-29): "I would like to make a page for all
of them individually", the ones a wallet in this app can sign for first; the governor Safe's keys later, on a page that
prepares the Safe's transactions.

**Who sees a page**: the wallet that holds its key (read with the Base card at most every 15 min, and when the tab
opens), or, for the root publisher, was offered it. Hiding protects nothing (the contracts refuse anyone else); it keeps
pages that mean nothing to anyone else out of the menu. A wallet that holds one and is not the admin is named for it
([wallets.md](wallets.md)).

| Tab | The key (how it is read) | Its actions |
|---|---|---|
| Emission Split | `SatoriRewards.emissionSplitAuthority` (zero: the admin) | the off-chain share (`setOffchainShareBps`); hand the job on (`setEmissionSplitAuthority`; empty: the admin) |
| Emission Schedule | `SatoriHub.emissionHolder()` (the admin unless set) | the step multiplier (`setEmissionRatio`, at least 0.001); hand the job on (`setEmissionAuthority`) |
| Root Publisher | `SatoriMerkle.rootPublisher` / `pendingRootPublisher` | accept an offer; publish a root by hand (`setMerkleRoot`; the Satori Service publishes it daily); offer the job (`setRootPublisher`, two steps; empty cancels) |
| Appoint | `SatoriToken.appointAuthority` (also the engine's governor) | replace the admin, the split and schedule holders, the airdrop loader; the curve operator; the curve's dials f, g, r, b and the dust target (bounds as the engine's, g ≤ r) |
| Wiring | `SatoriToken.wiringAuthority` (also the hub's governor) | the token's controller, transfer hook, airdrop contract and bridge authority; the hub's vote-lock contract, and freezing it for good |

Left out: the one-shot wiring already done (`SatoriEngine.setHub`, `SatoriHub.setSatoriMerkle`: both refuse once set).

**The cards**: each action its value now, a field and Save. Addresses that can't be taken back are typed twice; a
freeze asks first; a lever frozen on chain says Frozen. The checks the contracts make are made first, said plainly.

**Agent calls**: `specialKeys()`, `specialKey(role, action, value)` (public/llms.txt).
