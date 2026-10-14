# Engine

[← OVERVIEW](OVERVIEW.md)

About 150 lines of plain JS in the neuron worker. No WASM, no training queue.

## What Docker does (verified)

- One `StreamModel` per stream for both central-lite and relay paths
  (`neuron/engine-lite/engine.py:641-740`).
- Below 10 rows: `StarterAdapter` (`engine.py:54,1270-1272`). That is
  index-OLS on a random 80-100% window for ≥ 5 rows, a mean of the last k rows for
  2-4 rows (`adapters/starter/starter_model.py:52-106`).
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

## Evidence on what wins

On Satori's mostly crypto streams, naive last-value ties or beats every trained
model:

- `neuron/docs/engine/timesfm/README.md` §4: naive MAE 180.5, ETS 218.0, TimesFM
  217.2, XGB 224.8.
- A Node re-run during research on 20 Binance pairs (daily and hourly, h=1 and
  h=2): naive, SES and a median ensemble within 0.2% of each other; Holt and
  damped Holt 0.3-6% worse; Starter-style OLS 2.6×-5.7× worse than naive, never
  better on any series.

Caveat: that bench used Binance closes, not Satori's own histories. Non-random-walk
streams (weather, fear/greed) may favour SES/Holt; the selector below handles
that by measuring per stream.

## v1 design

Candidates per stream: **naive**, **SES**, **damped Holt**.

- Fewer than 10 points: naive (last value). Strictly better than Docker's
  Starter on this data.
- From 10 points: fit SES and damped Holt by coarse grid (α step 0.02;
  β ∈ {.01,.05,.1,.2,.3}; φ ∈ {.8,.9,.95,.98}). Keep the candidate with the lowest
  rolling one-step MAE over the last 20 points; naive wins ties.
- Output both horizons in closed form: naive t1 = t2 = last; SES t1 = t2 = level;
  damped Holt t1 = l + φb, t2 = l + (φ + φ²)b.
- Refit on every new observation (milliseconds per stream). State
  `(kind, α, β, φ, level, trend)` is saved in `engine_state`.

### Diversity between nodes

Docker deliberately makes nodes differ. A deterministic engine would make every
browser neuron submit identical values. Keep that property cheaply: each node
seeds an RNG from its identity pubkey, and among candidates whose rolling MAE is
within 1% of the best, picks one with that seed. Accuracy cost is bounded by the
1% band.

## Which value goes where

| Sink | Value | Docker evidence |
|---|---|---|
| central-lite batch | `value` = t2, `t1_value` = t1 | `engine.py:1099-1106` |
| `_pred` on Nostr | t2 | `predictForRelay`, `engine.py:714-737` |
| Base daily direction | UP(1) if latest `_pred` forecast > latest observed, else DOWN(2); ties DOWN | `neuron/neuron-lite/satorineuron/base_predict.py:141-143` |

Same as Docker for v1. Inferred open point, recorded not decided: the bounty
scorer appears to score against the next observation
(`neuron/neuron-lite/scoring/mae.py`) while `_pred` ships t2; settle it when
bounties land.

## Not ported

XGBoost (pickled joblib models are Python-only, and it loses to naive),
TimesFM/Chronos (hundreds of MB, no win), the training queue
(`satoriengine/veda/training/queue_manager.py`), unwired adapters. If a heavier
model is ever wanted: Pyodide has xgboost 2.1.4 and statsmodels; or ONNX via
onnxruntime-web.

## Tests

Fixtures: series → expected candidate and t1/t2. A port check that the hash
recipe and payload fields match `engine.py:1044-1106`.
