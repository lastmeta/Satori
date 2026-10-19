# Engine: what is still ahead

[← Roadmap](README.md)

The point forecast is built (step 4): see
[../design/engine.md](../design/engine.md) (`bar1`, a Bayesian AR(1) on
12 h returns faded toward persistence, after `../namaste_club`). What is left
here is for later steps.

## Base direction (an option, set aside in step 6)

Step 6 follows Satori Lite, by the owner's direction (2026-10-15): UP(1) if
t2 > the latest registry value, else DOWN(2)
(`neuron/neuron-lite/satorineuron/base_predict.py:141-143`;
[../design/base.md](../design/base.md)). Its consequence, a forecast equal
to the last value voting DOWN (so `naive` always did), is resolved by the
owner's tie rule (2026-10-19): a tie follows the stream's last move, and only
a flat history is DOWN. The alternative studied, still set aside:

1. Direction = sign of an OLS slope over the last *k* registry values, *k* drawn
   once per (node, stream) from the identity seed in [5, 20] (Docker's Starter
   also fits OLS on an RNG window, `starter_model.py:50-106`).
2. A zero slope (flat series) → identity-seeded coin flip, never a fixed DOWN.
3. Fewer than 5 values → seeded coin flip.

Inferred: on random-walk prices no rule beats ~50%; this one at least matches
Docker's spread of votes.

## Diversity between nodes (built)

Built as the owner directed (2026-10-15, [../intent/engine.md](../intent/engine.md)):
each central target has its own `bvar` spec (1–3 companion streams, λ1, λ2),
drawn from the identity and evolved after each poll
([../design/engine.md](../design/engine.md#bvar-a-model-per-central-stream-unique-to-each-neuron)).
Left for later:

- **Public specs.** Nostr subscriptions will make a neuron's data choices
  visible; the specs stay local until then.
- **Nostr and Base streams in bvar.** A Nostr stream can be a companion once
  its cadence is regridded to central's 12 h buckets; their targets once their
  histories align with central's.
- **More algorithms** (the first axis of uniqueness): one algorithm for now.
- **Lag 2, time features**, the posterior draws: left out, as for `bar1`.

## Which value goes where

| Sink | Value | Docker evidence |
|---|---|---|
| central-lite batch (built) | `value` = t2, `t1_value` = t1 | `engine.py:1052-1058,1097-1106` |
| Base daily batch (built, step 6) | UP if the forecast at the horizon > the latest value, else DOWN, as Lite; horizon max(24 h, cadence) in n = max(1, floor(horizon / max(12 h, cadence))) equal steps | `base_predict.py:141-143`; [../design/base.md](../design/base.md) |
| `_pred` on Nostr (built, step 5) | the forecast one cadence ahead (the owner's rule; Lite sends t2, two cadences ahead), as a string | `engine.py:714-739,1153-1186`; `start.py:1300,1322-1323`; [../design/nostr.md](../design/nostr.md) |

The owner's rule (2026-10-15, [../intent/engine.md](../intent/engine.md)): a
forecast is one cadence ahead. For bounties (later) that is also what Lite's
bounty scorer scores against, the next observation
(`neuron/neuron-lite/scoring/mae.py`).

## Not ported

XGBoost (pickled joblib models are Python-only, and it loses to naive on
Satori's streams: `neuron/docs/engine/timesfm/README.md` §4, naive MAE 180.5,
ETS 218.0, TimesFM 217.2, XGB 224.8), TimesFM/Chronos (hundreds of MB, no win),
the training queue (`satoriengine/veda/training/queue_manager.py`). If a heavier
model is ever wanted: Pyodide has xgboost 2.1.4 and statsmodels; or ONNX via
onnxruntime-web.
