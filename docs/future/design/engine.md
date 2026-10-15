# Engine: what is still ahead

[← OVERVIEW](OVERVIEW.md)

The point forecast is built (step 4): see
[../../design/engine.md](../../design/engine.md) (`bar1`, a Bayesian AR(1) on
12 h returns faded toward persistence, after `../namaste_club`). What is left
here is for later steps.

## Base direction (step 6)

A separate duty from the point forecast. Satori Lite sends UP(1) if the latest
forecast > the latest observed value, else DOWN(2)
(`neuron/neuron-lite/satorineuron/base_predict.py:141-143`; inputs at
`start.py:1201-1218`). Copying that onto this engine would send DOWN whenever
the forecast equals the last value: `naive` always, and `bar1` when its weight
is 0 or φ is 0. Every browser neuron would then cast the same constant vote.
That is a fixable flaw, not a browser limit.

Rule:

1. Direction = sign of an OLS slope over the last *k* registry values, *k* drawn
   once per (node, stream) from the identity seed in [5, 20] (Docker's Starter
   also fits OLS on an RNG window, `starter_model.py:50-106`).
2. A zero slope (flat series) → identity-seeded coin flip, never a fixed DOWN.
3. Fewer than 5 values → seeded coin flip.

Inferred: on random-walk prices no rule beats ~50%; this one at least matches
Docker's spread of votes. Fixture: a random-walk series must not produce all
DOWN across seeds; a strictly rising series gives UP.

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
| Base daily batch (step 6) | direction rule above | replaces `base_predict.py:141-143` |
| `_pred` on Nostr (step 5) | t2, as a string | `engine.py:714-737`; `start.py:1300,1322-1323` |

Inferred open point, for when bounties land: the bounty scorer appears to score
against the next observation (`neuron/neuron-lite/scoring/mae.py`) while `_pred`
ships t2.

## Not ported

XGBoost (pickled joblib models are Python-only, and it loses to naive on
Satori's streams: `neuron/docs/engine/timesfm/README.md` §4, naive MAE 180.5,
ETS 218.0, TimesFM 217.2, XGB 224.8), TimesFM/Chronos (hundreds of MB, no win),
the training queue (`satoriengine/veda/training/queue_manager.py`). If a heavier
model is ever wanted: Pyodide has xgboost 2.1.4 and statsmodels; or ONNX via
onnxruntime-web.
