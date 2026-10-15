# Engine: what is still ahead

[← OVERVIEW](OVERVIEW.md)

The point forecast is built (step 4): see
[../../design/engine.md](../../design/engine.md) (`bar1`, a Bayesian AR(1) on
12 h returns faded toward persistence, after `../namaste_club`). What is left
here is for later steps.

## Base direction (an option, set aside in step 6)

Step 6 follows Satori Lite, by the owner's direction (2026-10-15): UP(1) if
t2 > the latest registry value, else DOWN(2)
(`neuron/neuron-lite/satorineuron/base_predict.py:141-143`;
[../../design/base.md](../../design/base.md)). Its consequence stays: a
forecast equal to the last value votes DOWN, so `naive` always does, and so
does `bar1` when its weight or φ is 0; every browser neuron then casts the
same vote. A fixable flaw, not a browser limit. The alternative studied:

1. Direction = sign of an OLS slope over the last *k* registry values, *k* drawn
   once per (node, stream) from the identity seed in [5, 20] (Docker's Starter
   also fits OLS on an RNG window, `starter_model.py:50-106`).
2. A zero slope (flat series) → identity-seeded coin flip, never a fixed DOWN.
3. Fewer than 5 values → seeded coin flip.

Inferred: on random-walk prices no rule beats ~50%; this one at least matches
Docker's spread of votes.

## Diversity between nodes (optional)

Docker deliberately makes nodes differ: hyperparameters are redrawn on every fit
(`adapters/_rng.py`; `xgb.py:280-386`; `ets_model.py:63-74`), and namaste_club
draws coefficients from the posterior per worker. If wanted here, seed an RNG
from the identity pubkey and draw λ1 or a small posterior perturbation from it.
The accuracy cost should be bounded and measured with `scripts/backtest.mjs`.

## Which value goes where

| Sink | Value | Docker evidence |
|---|---|---|
| central-lite batch (built) | `value` = t2, `t1_value` = t1 | `engine.py:1052-1058,1097-1106` |
| Base daily batch (built, step 6) | UP if t2 > the latest value, else DOWN, as Lite; step max(12 h, cadence) | `base_predict.py:141-143`; [../../design/base.md](../../design/base.md) |
| `_pred` on Nostr (built, step 5) | t2 (`_runForecast` returns the second, autoregressed forecast), as a string; the step is the stream's cadence | `engine.py:714-739,1153-1186`; `start.py:1300,1322-1323`; [../../design/nostr.md](../../design/nostr.md) |

For bounties (later): the bounty scorer scores against the next observation
(`neuron/neuron-lite/scoring/mae.py`) while `_pred` and the bounty DM ship t2
(flagged for the owner in [../../design/nostr.md](../../design/nostr.md#the-engines-step)).

## Not ported

XGBoost (pickled joblib models are Python-only, and it loses to naive on
Satori's streams: `neuron/docs/engine/timesfm/README.md` §4, naive MAE 180.5,
ETS 218.0, TimesFM 217.2, XGB 224.8), TimesFM/Chronos (hundreds of MB, no win),
the training queue (`satoriengine/veda/training/queue_manager.py`). If a heavier
model is ever wanted: Pyodide has xgboost 2.1.4 and statsmodels; or ONNX via
onnxruntime-web.
