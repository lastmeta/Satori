# One bad game reverts the whole daily Base batch

**Status:** open · **Kind:** fixable flaw · **Fix in:** Docker neuron (`neuron/`); avoided by design in the browser app

## Precondition

Any one game in the day's batch fails a per-game check in
`predictMultipleWithPayloads`. Concretely:

- `StaleValue`: a subscribed stream has not updated since our last prediction
  on it (bridge paused, stream retired);
- `EmptyStream`: the stream has no values yet;
- `DuplicatePrediction` on a non-named game whose target is longer than a day.

Evidence: `contract/satori/contracts/next/SatoriEngine.sol:788-812` reverts the whole call for
any of these.

## Finding (verified)

`submit_batch` retries only once, and only by dropping **named** games on a
`DuplicatePrediction` (`neuron/neuron-lite/satorineuron/base_predict.py:157-174`).
Any other per-game revert loses the whole day for every game; the next try is
the following round (`neuron/neuron-lite/start.py:1236-1239`). The last-submit
time is already written (`start.py:1231`).

## Fix

Pre-check each game (e.g. `eth_call` / simulate a one-game batch, or read
`getLatestUpdateInfo` against the last prediction hour) and send only the games
that pass. The browser app does this ([chain.md](../design/chain.md#daily-prediction-batch)).

Related: the named-game wait uses the neuron's own stored timestamp
(`base_predict.py:146-149`), while the contract uses the on-chain last
prediction hour. After a reinstall the local timestamp is 0 and the neuron
relies on the revert-and-retry. Reading `PredictionMade.hour`
(`contract/satori/contracts/next/SatoriEngine.sol:326`) would make it exact.
