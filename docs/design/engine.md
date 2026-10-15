# Engine

[← OVERVIEW](OVERVIEW.md)

About 100 lines of plain JS in the neuron worker. No WASM, no training queue,
no saved model state.

## What Docker does (verified)

- One `StreamModel` per stream for both central-lite and relay paths
  (`neuron/engine-lite/engine.py:641-740`).
- Below 10 rows: `StarterAdapter` (`engine.py:54,1266-1272`). That is
  index-OLS on a random 80-100% window for ≥ 5 rows, a mean of the last k rows for
  2-4 rows (`satoriengine/veda/adapters/starter/starter_model.py:50-106`).
- From 10 rows, default `auto` = `[XgbAdapter, StarterAdapter]`
  (`engine.py:38-48,73-97`; `neuron/web/routes.py:800-807`). ETS and TimesFM are
  opt-in. The comments at `engine.py:541,586` that say auto includes ETS are
  wrong.
- Hyperparameters are redrawn randomly on every fit **on purpose**, so nodes
  differ (`adapters/_rng.py`; `xgb.py:280-386`; `ets_model.py:63-74`).
- Output is two autoregressive steps: predict t+1, append it, predict again;
  ship t+2 as `value` and t+1 as `t1_value` (`engine.py:1128-1186`). Central
  scores against the first observation ≥ 24 h after submission
  (`central/src/scripts/score.py:157-210`), which is about t+2 on a daily
  stream polled every 11 h.
- Base direction: UP(1) if the latest forecast > latest observed, else DOWN(2)
  (`neuron/neuron-lite/satorineuron/base_predict.py:141-143`; inputs at
  `start.py:1201-1218`). Because Starter and XGB forecasts almost never equal
  the last value, Docker's directions vary.

## Evidence on what wins (point forecasts)

On Satori's mostly crypto streams, naive last-value ties or beats every trained
model:

- `neuron/docs/engine/timesfm/README.md` §4: naive MAE 180.5, ETS 218.0, TimesFM
  217.2, XGB 224.8.
- A Node re-run during research on 20 Binance pairs (daily and hourly, h=1 and
  h=2): naive, SES and a median ensemble within 0.2% of each other; Holt and
  damped Holt 0.3-6% worse; Starter-style OLS 2.6×-5.7× worse than naive.

Caveat: Binance closes, not Satori's own histories. Damped Holt is left out of
v1 because it never won and costs ~1,000 fits per stream per observation; add it
if a backtest on registry histories ([chain.md](chain.md#base-streams)) shows a
win.

## v1 point forecast (central-lite and Base streams)

Candidates per stream: **naive** and **SES**.

- Fewer than 10 points: naive (last value). Base streams get registry history
  on day one, so this applies mainly to new central-lite streams.
- From 10 points: fit SES by grid (α step 0.02). Keep the candidate with the
  lower rolling one-step MAE over the last 20 points.
- Horizons in closed form: naive t1 = t2 = last; SES t1 = t2 = level.
- Refit from `observations` on each new value (milliseconds). Nothing is saved
  but the chosen model name in `predictions.model`.

### Diversity between nodes

Docker deliberately makes nodes differ. Each node seeds an RNG from its identity
pubkey and, among candidates whose rolling MAE is within 1% of the best, picks
one with that seed. Accuracy cost is bounded by the 1% band.

## Base direction

A separate duty from the point forecast. Copying Docker's rule onto naive would
send DOWN on every game whenever naive is chosen (forecast == last → tie →
DOWN), and SES with α ≈ 1 nearly ties too, so every browser neuron would cast
the same constant vote. That is a fixable flaw, not a browser limit.

Rule:

1. Direction = sign of an OLS slope over the last *k* registry values, *k* drawn
   once per (node, stream) from the identity seed in [5, 20] (Docker's Starter
   also fits OLS on an RNG window, `starter_model.py:50-106`).
2. A zero slope (flat series) → identity-seeded coin flip, never a fixed DOWN.
3. Fewer than 5 values → seeded coin flip.

Inferred: on random-walk prices no rule beats ~50%; this one at least matches
Docker's spread of votes. Fixture: a random-walk series must not produce all
DOWN across seeds; a strictly rising series gives UP.

## Which value goes where

| Sink | Value | Docker evidence |
|---|---|---|
| central-lite batch | `value` = t2, `t1_value` = t1, formatted as Python floats ([central.md](central.md#payload-fields-verified-parity-planned)) | `engine.py:1052-1058,1097-1106` |
| Base daily batch | direction rule above | replaces `base_predict.py:141-143` |
| `_pred` on Nostr (parity, after v1) | t2, as a string | `engine.py:714-737`; `start.py:1300,1322-1323` |

Inferred open point, for when bounties land: the bounty scorer appears to score
against the next observation (`neuron/neuron-lite/scoring/mae.py`) while `_pred`
ships t2.

## Not ported

XGBoost (pickled joblib models are Python-only, and it loses to naive),
TimesFM/Chronos (hundreds of MB, no win), the training queue
(`satoriengine/veda/training/queue_manager.py`), unwired adapters. If a heavier
model is ever wanted: Pyodide has xgboost 2.1.4 and statsmodels; or ONNX via
onnxruntime-web.

## Tests

Fixtures: series → expected candidate and t1/t2; direction fixtures above;
central-lite payload strings and hash from the Docker image.
