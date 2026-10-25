# Bounties: paid predictions

[← Roadmap](README.md) · the stream market: [market.md](market.md) · Lite's design:
`neuron/docs/plans/prediction-market.md` (the owner's vision, verbatim)

**Status:** proposed, 2026-10-25. Not built.

## The goal

The stream market is the seller's: "here is my stream, here is its price." A bounty is the buyer's: "I want
this stream predicted, and I will pay whoever predicts it best, by my own measure."

How it plays out (the owner, 2026-10-25):

1. A host posts a bounty on a stream.
2. Predictors start predicting it and send their predictions to the host, privately.
3. The host opens a payment channel to whoever it thinks is best, and pays per observation.
4. Everyone sees who is paid. Predictors start to optimize for answers like the winner's.
5. When someone else gets better, the host opens a channel to the new best, and so on.

The host's scoring function is never published (owner ruling). Predictors approximate it from who gets
paid, however complicated it is.

## The rules

- **No contract of its own.** A host pays through `PaymentChannels` (v3, the stream market's), with the
  roles turned around: the host's wallet is the payer, the predictor's wallet the payee, the host's alias
  signs the vouchers. A contract can't enforce "pay the best" without the rule on chain, and the rule is
  private.
- **Predictions are private.** Each goes to the host alone, encrypted. Nobody else can read or copy them.
  A stream predicted for a bounty is therefore private, the exception in "every stream we produce goes to
  the relays": its `_pred` is not published in the clear while it is sent to a bounty.
- **Payments are public.** The host publishes every voucher it signs, in the clear. Anyone can check
  each against the chain (the channel's signer, payee and deposit) and add them up. That is the only
  check there is: did the host pay what it announced, per observation? Who deserved it can't be checked:
  the rule and the predictions are private.
- **Port Lite's events first** (satorilib `satori_nostr/models.py`), changing only what Base needs.

## The events

| Kind | Lite | Here |
|---|---|---|
| 34607 bounty announcement (public, replaceable, `d = stream:provider:host`) | `BountyAnnouncement`: `stream_name`, `stream_provider_pubkey`, `host_pubkey`, `pay_per_obs_sats`, `paid_predictors`, `competing_predictors`, `scoring_metric`, `scoring_params`, `horizon`, `active`, `timestamp` | The same, without `scoring_metric` and `scoring_params` (the rule is private), plus `market = { chain, contract, token }` as a priced stream's listing says where it pays. Re-announcing replaces it; `active: false` closes it |
| 34608 prediction (NIP-04 to the host) | `PredictionSubmission`: `stream_name`, `stream_provider_pubkey`, `predictor_pubkey`, `predictor_alias_pubkey`, `seq_num`, `predicted_value`, `timestamp` | The same, with `payee` (the predictor's wallet, a 0x address) in place of the Evrmore alias pubkey: where a channel would pay |
| 34604 channel commitment (public, `d = channel`) | each payment's Evrmore commitment, in the clear | the host's newest voucher on that channel, in the clear: `{ bounty (its d), channel, cumulative, signature, seq }`. Cumulative, so the relay keeping only the newest loses nothing |

A predictor learns of a channel opened to it from its first 34604. It reads the channel on chain (its
payee is our wallet, SATORI, the signer is the voucher's) and keeps the voucher as a seller keeps a
buyer's. Collecting is the stream market's: the weekly `settleMany`, at once on a close request.

## The host (the Satori app)

- **Post a bounty** on a stream it follows (Market tab, agent call): pay per observation in SATORI,
  how many predictors it pays (1 by default), the horizon (1). Close it.
- **Receives** 34608s for its bounties and keeps them per predictor and observation, received before
  the outcome only (the track record's rule: by arrival, since a `created_at` can be backdated).
- **Scores** them privately, on each new observation of the stream, with a scorer chosen in the app and
  never announced. It starts with the track record's measure (median error against no change, the last
  28) and Lite's built-in scorers. The ranking shows only to the host.
- **Pays** the current best on each observation: the alias signs the voucher (no Unlock), publishes it
  (34604) and sends it to the predictor. The amounts add up to `pay_per_obs_sats`.
- **A new best** with no channel: opening one moves the host's SATORI, so it needs the wallet. The app
  says "X is now best: open a channel" (Unlock, gas), with a deposit of 100 observations by default.
  The old best's vouchers stop; its channel is asked to close, and v3's reuse picks it up again if it
  becomes best again.

## The predictor (the Satori app)

- **Bounties** on the Market tab: each announced, its stream, pay per observation, how many it pays,
  who has been paid lately (from the 34604s) and the total paid against the promise.
- **Predict for it:** the app predicts the stream (as any it predicts) and sends each prediction to the
  host (34608) instead of publishing it.
- **Earnings:** each channel a host opened to us, what its vouchers owe, what is settled.

Every action has its `window.satori` call (post, close, predict for, the host's open-a-channel).

## Risks: inherent and fixable

- **Self-dealing (inherent).** A host can pay a key of its own and look honest by the totals. With a
  private rule and private predictions nothing can show it. Predictors who think they're good and aren't
  paid leave.
- **Paying less than announced (fixable, it's the design).** Visible from the public vouchers against
  `pay_per_obs_sats` and the stream's observations. The Bounties list shows it.
- **Predictors' payee addresses are only the host's to know.** Fine: they are in the private 34608s.
- **A predictor can't prove it predicted first** (inherent to private predictions). It doesn't need to:
  only the host scores.

## Not in it

Lite's stretch goals (approval-gated private streams, 34609), the main contract's Bounties, a contract
of its own.

## Open decisions (each with the recommendation)

1. **Who opens a channel to a new best:** the host's wallet, when the person agrees (recommended: the
   two-key rule, and the owner's words "opens a payment channel with whoever he thinks is best"), or the
   alias from a bounty budget it holds, automatically.
2. **The host's scorer:** the track record's measure by default, Lite's built-ins to choose from, all
   kept private (recommended); later an agent may rank with its own.

## Steps (smallest first)

1. The events: 34607 and 34608 ported, 34604 for Base vouchers; tests against Lite's fields.
2. The predictor: Bounties on the Market tab, Predict for it, earnings collected.
3. The host: post, close, receive, score, pay, open a channel to a new best.
4. Proven by two browser apps on the fork: a host, two predictors, the best switching.
