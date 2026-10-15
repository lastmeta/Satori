# Engine

[← OVERVIEW](OVERVIEW.md)

`src/engine/index.js`: `forecast(points) → {model, t1, t2, phi?, weight?} | null`.
Pure functions, no dependency. Step 4 replaced step 3's least-squares line
(`ols-20`) with a one-stream, lag-1 cut of the engine the owner built in
`../namaste_club` ("a simplified engine… take inspiration from it").

Short names: `NC` = `../namaste_club`; `engine.py` = `../neuron/engine-lite/engine.py`.

## What namaste_club does

A pool of about 4,300 workers that submit to central once a day. The parts that
make one forecast:

- **Grid.** All of a stream's history, binned to one row per 12 h UTC bucket
  (the last value in the bucket); empty buckets are dropped
  (`NC/models.py:254-267`; `BUCKET = 43200` at `NC/features.py:22`,
  `NC/regrid_history.py:39`).
- **Returns.** Values become percent changes, and ±inf and NaN become 0
  (`NC/models.py:295-305`). A zero coefficient then means "tomorrow ≈ today",
  a random walk in price space.
- **Model.** A Bayesian VAR in closed form, one regression per target
  (`NC/bvar.py:95-251`):
  - regressors: 5 cyclical time features (`NC/bvar.py:13-27`), the lag-1
    (or lag-2) returns of every stream, and exogenous features;
  - a Minnesota prior centred on zero: own-lag variance λ1² with λ1 = 0.2
    (`NC/bvar.py:88,199`); other streams' lags (λ1·λ2)² scaled by their
    variance ratio (`:200-207`); time features loose, λ1²·100 (`:194`);
  - noise σ² = the variance of the OLS residuals, floored at 1e-6
    (`NC/bvar.py:177-180`);
  - posterior mean (Σ0⁻¹ + XᵀX/σ²)⁻¹·Xᵀy/σ² (`NC/bvar.py:215-229`);
  - it needs rows ≥ features + 5 (`NC/bvar.py:157-164`). A stream it does not
    train on gets the last value (`NC/pool.py:1019-1031`).
- **Forecast.** Two 12 h steps in return space (`NC/bvar.py:283-339`, called at
  `NC/pool.py:979-991`). Each predicted return is the next step's lag; a
  non-finite return is 0; each step is clamped to ±0.5 (`:334-336`); growth
  compounds. The first lag is the return from the newest observation back to
  the newest one at least 6 h older (`NC/pool.py:869-900`).
- **Fade.** submitted = last × (1 + w·(g − 1)) (`NC/calibration.py:108-119`).
  A non-finite or non-positive g counts as 1, and a non-positive result
  becomes last (`NC/pool.py:1003-1016`). w = clamp(2 − model error /
  persistence error, 0, 1); a persistence error of 0 gives w = 0 if the model
  erred, else 1 (`NC/calibration.py:39-50`). The errors are medians of the
  stream's own logged forecasts (`NC/calibration.py:53-94`), each scored
  against the first observation ≥ 24 h later (`NC/measurement.py:101-165`).
  Fewer than 5 → w = 1 (`NC/calibration.py:33-34`). `MODEL_WEIGHT` forces w
  (`NC/pool.py:1001-1010`).
- **Spread between workers.** Random stream subsets and feature hands; λ's
  drawn each day from a tuner's 28-row holdout (`NC/models.py:552-666`);
  coefficients drawn from the posterior (`NC/bvar.py:254-280`); a jitter on the
  blend (`NC/calibration.py:122-127`).
- **Evidence.** Across 1,880 scored forecasts the median absolute error was
  4.09% for the model and 3.32% for persistence (`NC/calibration.py:4-10`),
  hence the fade.

## What Satori Lite does

- `t1` = the model's next value; `t2` = the model again on the history with
  `t1` appended, falling back to `t1` (`engine.py:1153-1186`, the appended row
  at `:1128-1151`).
- Central gets `value` = t2 and `t1_value` = t1 (`engine.py:1052,1102-1103`)
  and scores `value` against the first observation ≥ 24 h after it
  (`central/src/scripts/score.py:249-253`).
- The model sees the stream's whole local history (`engine.py:641-652`).

For a linear AR on returns, appending t1 and predicting again *is* namaste_club's
second iterated step. So here t1 is the first 12 h step and t2 the second:
Lite's two values, namaste_club's 24 h horizon. The payload is unchanged
([central.md](central.md)).

## The engine here: `bar1`, a Bayesian AR(1) on 12 h returns

For each stream that got a new observation, on all its stored observations
(as Lite and namaste_club do):

1. Drop points with a non-finite time or value and sort by time. None left →
   `null`. `last` = the newest value.
2. **Buckets**: b = floor(ts / 43,200) (12 h, UTC-aligned), the last value in
   each.
3. **Returns** between consecutive buckets: r = v_k / v_{k−1} − 1 (non-finite →
   0). Across a gap there is no return.
4. **Pairs** (r_{k−1}, r_k), both present. Fewer than 6 (lag 1 + 5) →
   **`naive`**: t1 = t2 = last. Eight gapless buckets give 6 pairs.
5. **φ** = Σxy / (Σxx + σ²/λ1²), where σ² = max(var(y − φ_ols·x), 1e-6) and
   φ_ols = Σxy/Σxx (0 when Σxx = 0). This is namaste_club's posterior mean with
   one regressor; λ1 = 0.2 shrinks φ toward 0 (the random walk) unless the data
   say otherwise.
6. **First lag** r0 = last / (the newest value at least 6 h older) − 1. It is 0
   when there is no such value or it is more than 24 h older.
7. **Iterate** twice: q = clamp(φ·r, ±0.5) (non-finite → 0), r = q,
   g ← g·(1 + q). This gives g1 (12 h) and g2 (24 h).
8. **Weight** w from a rolling backtest on the stream's own buckets. Take each
   of the last 28 origins o whose buckets o, o+1, o+2 are consecutive and which
   have at least 6 pairs up to o. Fit φ on those pairs, predict v_o·g2 from
   r_o, and score it against v_{o+2}; persistence predicts v_o. Both errors are
   relative, |x − a|/a. w = clamp(2 − median(model)/median(persistence), 0, 1),
   with namaste_club's rule for a zero persistence error. Fewer than 5 origins →
   w = 1.
9. **Fade**: t1 = last·(1 + w·(g1 − 1)), t2 = last·(1 + w·(g2 − 1)), with
   namaste_club's guards.
10. A non-positive value anywhere in the buckets → `naive` (returns need
    positive values).

`bar1` returns `{model: 'bar1', t1, t2, phi, weight}` and `naive` returns
`{model: 'naive', t1, t2}`. `phi` and `weight` are stored on the prediction,
and the Streams table shows the model, with φ and w on hover. An option
`{weight}` forces w, as `MODEL_WEIGHT` does; the backtest uses it.

### Constants (copied)

| Constant | Value | namaste_club |
|---|---|---|
| `STEP_S` | 43,200 s (12 h), UTC-aligned | `features.py:22`, `regrid_history.py:39` |
| `LAMBDA1` | 0.2 | `bvar.py:88` |
| `SIGMA2_FLOOR` | 1e-6 | `bvar.py:180` |
| `MIN_EXTRA_ROWS` | 5 (rows ≥ features + 5) | `bvar.py:158` |
| `HORIZON_STEPS` | 2 | `bvar.py:285`, `pool.py:991` |
| `MAX_STEP_RETURN` | 0.5 | `bvar.py:286` |
| `MIN_SPACING_S` | 6 h | `pool.py:872` |
| `HOLDOUT` | 28 | `models.py:552` |
| `MIN_SAMPLES` | 5 | `calibration.py:34` |
| `DEFAULT_WEIGHT` | 1 | `calibration.py:33` |

## Deviations, and why

From namaste_club:

- **One stream, lag 1, no time or exogenous features.** The browser forecasts
  each stream when it gets a new row, from its own history. Time features enter
  almost unshrunk (λ1²·100) and add 5 coefficients, so they need far more rows
  than a young neuron has; the research simulation put the 24 h error at 1.4–2.5×
  persistence's with few rows. Cross-stream lags and exogenous features need
  aligned multi-stream tables and outside feeds. Lag 2 and the λ tuner pick
  settings across a fleet; one node gains little from them.
- **The fade comes from a rolling backtest, not a log of past submissions.** It
  needs no new storage and works from the first day. It also avoids
  namaste_club's feedback loop, where the logged values were the already-faded
  (and jittered) ones, so a faded model was scored as part persistence.
- **Gaps.** namaste_club drops empty buckets, so a return across a gap counts
  as one 12 h step. A browser tab gets closed, so here a gap breaks the
  return, and a first lag more than 24 h old counts as 0.
- **Non-positive values → naive.** namaste_club computes percent changes on
  any value and only guards the final result.
- **Left out:** posterior draws and the jitter. They spread 4,300 workers
  around the truth; for one node they only add error. Also left out: the
  random model and its 100,000 default (`NC/pool.py:840-845,881`).

From Satori Lite:

- The model is `bar1`/`naive`, not Lite's Starter/XGBoost adapters, and it
  steps by 12 h buckets rather than by rows. Lite's rows arrive every ~11 h, so
  a step is about the same length.
- No per-node diversity (Lite redraws hyperparameters on purpose). It is
  optional and left for later, seeded from the identity as the parked design
  planned ([../future/design/engine.md](../future/design/engine.md)).
