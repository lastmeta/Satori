# One bad game reverts the whole daily Base batch

**Status:** open in Lite · **Kind:** fixable flaw · **Fix in:** Docker neuron (`neuron/`); avoided in the browser app (built in step 6: each game simulated alone)

## Precondition

Any one game in the day's batch fails a per-game check in
`predictMultipleWithPayloads`. Concretely:

- `StaleValue`: a subscribed stream has not updated since our last prediction
  on it (bridge paused, stream retired);
- `EmptyStream`: the stream has no values yet;
- `DuplicatePrediction` on a non-named game whose target is longer than a day.

Evidence: `contract/satori/contracts/next/SatoriEngine.sol:783-810` reverts the whole call for
any of these.

## Finding (verified)

`submit_batch` retries only once, and only by dropping **named** games on a
`DuplicatePrediction` (`neuron/neuron-lite/satorineuron/base_predict.py:157-174`).
Any other per-game revert loses the whole day for every game; the next try is
the following round (`neuron/neuron-lite/start.py:1236-1239`). The last-submit
time is already written (`start.py:1231`).

## Fix

Simulate each game as a one-game batch (`eth_call` / `simulateContract`) and
send only the games that pass. Reading `getLatestUpdateInfo` off-chain is not a
substitute: the call first runs `satoriRegistry.updateValues` (`SatoriEngine.sol:783`),
which pulls a fresh value for due PULL streams before the `EmptyStream` /
`StaleValue` checks (`:791-810`), so an off-chain read drops games that would
pass. The browser app simulates
([base.md](../../design/base.md#the-daily-batch-the-identity-on-its-own)).

The simulate also fixes the reinstall case: Docker's named-game wait uses its
own stored timestamp (`base_predict.py:146-149`), which is 0 after a reinstall,
while the contract uses the on-chain last prediction hour (`:800-809`), which
the simulate evaluates exactly.
