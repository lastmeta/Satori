# Market: paid data streams

[← Roadmap](README.md) · intent: [../intent/network.md](../intent/network.md)

**Status:** approved by the owner, 2026-10-20 ("Let's do it"). Step 0 (a
relay everyone can reach) and step 2 (the channel contract, deployed on Base
Sepolia) are done; step 1 (the track record) is built, 2026-10-20, not yet
deployed ([../design/track-record.md](../design/track-record.md)); step 3
(sell and buy in the neuron) is built, 2026-10-21, not yet deployed
([../design/market.md](../design/market.md#selling-and-buying-over-the-relays)).

## The goal

The Satori Network is the relays: anyone publishes a data stream, anyone
subscribes. Predictions are streams too. A stream doesn't have to be free:
its publisher can charge a tiny amount per observation, in SATORI on Base,
with no gas on each payment. Then the best predictor of something can sell
its predictions, and a neuron can buy the streams that help it predict.

## What we had on Evrmore

Satori Lite built a stream market on Evrmore and tested it, but it was
never used (`neuron/docs/plans/stream-market-e2e-testing.md`; kinds
34603–34606 in satorilib). It used **Spilman channels**: the buyer locks
coins in a 2-of-2 P2SH output, with a refund transaction on a timelock
signed up front. Each payment is a new partially signed transaction that
pays the seller a little more, sent over Nostr (the 34604 commitment). The
seller broadcasts the latest one to collect. That broadcast closes the
channel, so the seller can't take part of the money and keep selling.

## The same thing on Base

On an EVM chain the contract holds the deposit and enforces the rules, so
the channel gets simpler and loses Spilman's main limit:

| | Spilman (Evrmore) | Payment channel (Base) |
|---|---|---|
| Open | a funding tx to a 2-of-2 P2SH, plus a timelocked refund tx signed first | `open()`: the deposit goes into the contract |
| Each payment | a partially signed tx paying a bit more | a signed **voucher**: "channel X owes the seller N in total", 65 bytes, free |
| The seller collects | broadcasts the latest tx, which ends the channel | `settle()`: takes what is owed so far and the channel stays open, as often as it likes |
| More money | a new channel | `topUp()` |
| The buyer's refund | the refund tx after its timelock | `requestClose()`, then `withdraw()` after a grace period |
| Gas | an Evrmore fee per close | open, each settle, close; **nothing per payment** |

Vouchers are **cumulative**: each one states the total owed so far, so only
the latest matters and none can be replayed. The contract checks the
signature against the channel's signer and pays the seller the difference
between the voucher and what it has already paid.

This is the design the field is converging on. Tempo's TIP-20 channel
reserve has the same shape and the same voucher type,
`Voucher(bytes32 channelId,uint96 cumulativeAmount)` (not its domain, ids or
API, so its helpers don't apply to ours; any EIP-712 signer does). x402's
`batch-settlement` scheme uses cumulative vouchers against an escrow, and
ERC-8184 (a draft, since renumbered 8190) proposes it as a standard for AI
agents paying per call ([sources](#sources)).

**What Lightning adds is routing:** paying someone you have no channel with,
through intermediaries. We don't need it. A buyer pays each seller directly,
and on Base a channel costs a fraction of a cent to open. The EVM attempts
at routed networks (Raiden, Connext's channels) added a lot of complexity
and were mostly abandoned.

**Can the relays be the payment channel?** They carry it, and that is
enough. The money sits in the contract on Base. Vouchers and observations
travel over Nostr as encrypted events. A relay can drop a voucher but can't
forge or change one: the signature is checked against the chain.

### The other options, and why not

| Option | How it works | Why not first |
|---|---|---|
| **Probabilistic payments** (Livepeer) | each payment is a lottery ticket worth price ÷ p with win chance p; only winners go on chain; one deposit pays any number of sellers | lumpy pay for small sellers; more cryptography (the seller's random commitments, a reserve, penalties) and more to audit. The upgrade path if per-seller deposits become a burden |
| **Streaming** (Superfluid, on Base) | money flows per second while subscribed; the receiver can spend it at once | needs SATORI wrapped as a Super Token; a buffer deposit lost if the stream runs dry; it pays for time, not for observations, so a seller that stops publishing is still paid |
| **A transfer per payment** (x402 `exact`, plain transfers) | each observation is an on-chain transfer | gas on every payment, which is what we're avoiding |
| **A ledger on central, paid by Merkle drop** | buyers deposit, central keeps balances, the daily drop pays sellers | central again; the intent is the relays, not a server |

### Off the shelf, our own, or in the Satori contract

- **Off the shelf:** nothing fits as is. Tempo's reserve is a precompile on
  Tempo's own chain, not a contract on Base. x402's escrow is built around
  its HTTP facilitator and takes deposits by EIP-3009 or Permit2. ERC-8184's
  reference contract runs USDC on Polygon. I found no audited ERC-20 channel
  contract deployed on Base.
- **Inside the Satori contract:** it would tie the market to D7 and to the
  pre-deploy sweep (46 items open), and add to the surface of the contract
  that holds everyone's rewards. A channel needs nothing from the hub.
- **Recommended: a small contract of its own.** It would be immutable, with
  no admin and no fee, and work with any ERC-20 (SATORI is the app's
  default). It uses the same voucher type as Tempo's reserve. About 150
  lines, the textbook construction; it can be built, reviewed and deployed
  on its own schedule.

### SATORI on Base: what to know

- **Transfer locks.** The token blocks transfers out of a wallet that is
  staked with a neuron, or that predicted this round or the last
  (`SatoriToken.sol` lock lanes; `relayer/README.md`). A neuron playing on
  chain therefore can't open or top up a channel from its vault or its
  identity. Spending from a channel moves nothing out of those wallets, so a
  channel funded once keeps working after the vault stakes. And sellers can
  receive while locked: the lock checks only the sender.
  - *Proposed:* `open` names a payer separate from the wallet that funds
    it, so any unlocked wallet can fund a neuron's channel (the vault before
    it stakes, a reward address, an exchange withdrawal). The refund always
    goes to the payer.
- **Permit.** SATORI has EIP-2612 `permit`, so opening a channel is one
  transaction, with no separate approve.
- **The hook.** A payment to a staked vault runs the token's delegation
  hook. A `settle` sent with a bare gas estimate could starve it: the
  token-hook issue, fixed on `humble` (86e2bdb3), live with D7. The app
  already pads its gas.
- **Gas.** Base mainnet was at 0.006 gwei on 2026-10-20 (`eth_gasPrice`).
  Measured with SATORI: opening 147k gas (197k with permit), a settle 70–87k,
  more with the hook. At that price each costs well under a cent.

## The design

### The contract

Built 2026-10-20: `PaymentChannels`, in the contract repo
(`contract/satori/contracts/channels/PaymentChannels.sol`, branch
`humble`; design and tests in `contract/docs/design/payment-channels.md`).
It is deployed at **`0xeF3f87042cd9619729E5D69Da2fF90F89EA6976c`** on Base
Sepolia, by CREATE2, so the same address on every chain.

```
open(payer, payee, token, signer, deposit, salt) → channelId   // funded by msg.sender; also openWithPermit
topUp(channelId, amount)                                       // anyone; adds funds, nothing else
settle(channelId, cumulative, signature)                       // anyone; pays payee the new part
settleMany(channelIds, cumulatives, signatures)                // the same in one tx; skips what can't pay
close(channelId, cumulative, signature)                        // payee: settle and refund the rest now
requestClose(channelId)                                        // payer or signer: starts the grace period
cancelClose(channelId)                                         // payer only; moves no tokens
withdraw(channelId)                                            // payer or signer, after the grace period: refund to payer
events: Opened, ToppedUp, Settled, CloseRequested, CloseCancelled, Closed
```

- **Signatures: ECDSA first, then ERC-1271.** A voucher the signer's key
  signed always counts. Asking contract code first would let a payer void
  every voucher it gave by adding code to its signer's address (EIP-7702);
  the adversarial review found this and it is fixed. A contract signer can
  still change its answer, so **a seller accepts only key (EOA) signers**:
  the neuron's identity is one.
- **Only the payer cancels a close** (`cancelClose`, which moves no tokens,
  so a staked vault can still use it). If the signer could, a leaked
  identity could keep a refund from ever coming due.

- `settle` is open to anyone, because the money can only go to the payee
  and only up to what the signer signed. So the seller's identity, or anyone
  else, can submit it.
- `requestClose` and `withdraw` are open to the signer, because the refund
  can only go to the payer. Unsubscribing then needs no Unlock.
- The grace period is one constant. **Proposed: 7 days.** A browser seller
  runs only while a tab is open, so it needs time to see a close request and
  settle. It settles daily anyway, so at most about a day's earnings wait
  on that.

### Two keys, as everywhere in Satori

- **The vault** funds a channel (Unlock, gas). That is the only step that
  moves the buyer's money.
- **The identity is the channel's signer.** It signs vouchers on its own,
  per observation, with no Unlock. On the seller's side it sends `settle`,
  paying the gas it already holds for the daily batch, and the money lands
  in the vault.
- **If the identity leaks,** the thief can only overpay the sellers you
  already have channels with, up to their deposits. It can't redirect money
  to itself. That is the same bounded risk the identity carries today.

### Over the relays

1. **Announce.** The 34600 carries the price per observation (in the
   token's smallest unit, as a string), the chain, the token, the payee (the
   seller's vault) and the contract's address.
2. **Subscribe.** The buyer opens a channel on chain, then sends a 34602
   naming the channel. The seller checks it on chain: its payee, its token,
   enough left, not closing.
3. **Deliver.** For each observation, the seller sends one event per paying
   subscriber, encrypted to that subscriber's Nostr key (NIP-44). Each event
   has its own `d` tag per subscriber; today's code shares one, so a relay
   keeps only the last subscriber's event.
4. **Pay.** On receiving observation n, the buyer's identity signs the
   voucher for the new total and sends it to the seller, encrypted (34603).
   The seller checks the signature, that the total rose by the price, and
   that it fits the deposit, then sends observation n + 1. The first
   observation is free, as in Lite. The buyer risks at most one
   observation's price. The seller risks what it hasn't settled, so it
   settles often.
5. **Collect.** The seller settles daily (`settleMany`, one transaction
   for all its channels), when what's owed is worth it, and at once on
   seeing a close request. It also stops serving that channel then: the
   grace period doesn't restart while the buyer keeps paying.
6. **Stop.** Unsubscribing sends `requestClose`. The seller settles within
   the grace period, then the buyer's refund is withdrawn.

Payments are checked against the chain. That fixes Lite's forged-payment
flaw by design: today a 34603 is believed from its content.

### Track record: how a buyer knows who's good

A market needs a way to tell good sellers from bad, or "the best predictor
can charge" doesn't work.
- **Free streams:** the neuron scores any prediction stream against its
  source, the way the Models tab scores its own models against no change. It
  uses only predictions it received before the outcome.
- **Paid streams:** with each paid prediction, the seller publishes a
  public commitment, a hash of (stream, seq, value, salt). After the
  outcome, it reveals the value and salt. Anyone who saw the commitment
  before the outcome can check and score it. (A commitment's `created_at`
  can be backdated, so scorers go by when they received it.)
- The Streams tab shows each stream's verified record next to its price.

### Risks: inherent and fixable

- **Resale (inherent).** A buyer can republish what it bought. What a
  prediction stream sells is freshness, and that fades quickly.
- **Copying rewarded predictions (inherent when published in the clear).**
  Predictions for streams that pay rewards (the Satori Network's, the
  contract's games), published free before they are scored, can be
  submitted by a copier as its own. *Proposed:* sell them, or reveal them
  only after the outcome.
- **A seller offline through the whole grace period (fixable by choice of
  grace).** It loses what it hadn't settled. Daily settling plus 7 days'
  grace bounds this.
- **Per-seller deposits (inherent to channels).** Twenty sellers means
  twenty deposits. Probabilistic payments remove this if it ever matters.

## Steps (proposed, smallest first)

0. **One relay everyone can reach.** TLS in front of satorian, or Lite
   neurons on `wss://nostr.satorinet.io` with central's watcher able to
   reach it. Without it, browser and Lite neurons can't trade at all
   ([issue](../issues/relays-not-wss.md)). Every design needs it, so it is
   not a fix that a redesign would undo. Done 2026-10-20 for the browser:
   `wss://relay.satorinet.io` fronts satorian, and the app maps central's
   `ws://` entry to it, so Lite and browser neurons share one relay. Live
   on neuron.satorinet.io: a fresh profile discovers 925 streams from 44
   providers.
1. **Track record for prediction streams**, free ones first, on the Streams
   tab. Useful on its own, and the base the market stands on. Built
   2026-10-20 (not yet deployed; [../design/track-record.md](../design/track-record.md)):
   every `_pred` on the relays naming its source (up to 200) is watched on
   its own with its source; each prediction is scored against the source's
   next observation, only if this app received it first; the last 28
   against no change in the Models tab's words, on the Streams tab and in
   `records()`. Satorian's 120 are watched 2 s after a load.
2. **The channel contract:** TDD, an adversarial review, then Base Sepolia
   and the local fork. It is independent of D7. Done 2026-10-20 (above):
   30 Hardhat tests and six Foundry invariants. Two review passes found the
   EIP-7702 issue and smaller ones, all fixed. A viem-signed voucher was
   settled on the fork with D6 SATORI.
3. **Paid streams in the neuron.**
   - **Sell:** a price on one of its prediction streams, encrypted
     delivery, vouchers checked, daily settle.
   - **Buy:** Subscribe with a cap, vouchers sent automatically,
     Unsubscribe to close.
   - The Wallet shows the market balance and earnings. `window.satori`
     gets the same calls.
   - Proven by two browser neurons trading on the fork.

**Later, recorded, not next:**
- Satori Lite speaks the same protocol, from a spec written in step 3.
- The engine buys on its own, under a budget, when a stream earns its price
  in better predictions ("it reads more than it predicts",
  [../intent/engine.md](../intent/engine.md)).
- The relay redesign: discovery, and paying relays for carrying Satori
  traffic rather than for uptime. Best done once the market shows what
  traffic matters.
- Bounties, Lite's second market layer (34607–34608).
- Probabilistic payments, if per-seller deposits bite.

## Open decisions (each with the recommendation)

1. **A separate channel contract**: yes. Built.
2. **Where it's built:** the contract repo (`humble`). The owner had it
   built in this session, not by that repo's session.
3. **The token:** SATORI, in a contract that takes any ERC-20.
4. **The grace period:** 7 days.
5. **Rewarded predictions:** sold or revealed after the outcome, not free
   in the clear. Still open.
6. **Step 0 now**, while the other relay fixes wait. Done.

## Direct links between neurons (later)

For the intent's direct layer: browsers can't open raw UDP sockets, so
plain UDP hole punching would leave browser neurons out. **WebRTC data
channels** are UDP hole punching, standardized: ICE with STUN, a TURN relay
for networks that can't be punched through, and encryption built in. They
run in every browser and in Python (aiortc), Go (pion) and C++
(libdatachannel). The rendezvous a hole punch needs can be the Satori
relays themselves: the offer, answer and candidates travel as encrypted
Nostr events, so no new server is needed beyond STUN and a fallback TURN.

## Sources

- Tempo, TIP-20 channel reserve: https://rustdocs.tempo.xyz/src/tempo_contracts/precompiles/tip20_channel_reserve.rs.html
- x402 FAQ (`upto`, `batch-settlement`): https://docs.x402.org/faq
- x402 batch-settlement scheme: https://docs.x402.org/schemes/batch-settlement
- ERC-8184 draft (renumbered 8190): https://ethereum-magicians.org/t/erc-8184-draft-payment-channels-with-signed-vouchers-streaming-micropayments-for-ai-agents/28012
- Livepeer probabilistic micropayments: https://docs.livepeer.org/v2/developers/guides/payments/probabilistic-micropayments
- Superfluid Super Tokens: https://docs.superfluid.org/docs/protocol/super-tokens/overview
- In this workspace: `contract/satori/contracts/next/SatoriToken.sol` (locks,
  permit), `contract/relayer/README.md` (locked wallets),
  `neuron/neuron-lite/start.py` and satorilib `satori_nostr/client.py`
  (Lite's Evrmore channels).
