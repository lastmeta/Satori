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
3. **Returns** between back-to-back buckets: r = v_k / v_{k−1} − 1
   (non-finite → 0). Across a gap there is no return. A series with any
   value ≤ 0 is modeled on changes instead (`bar1d`, below).
4. **Pairs** (r_{k−1}, r_k), both present. Fewer than 6 (lag 1 + 5) →
   **`naive`**: t1 = t2 = last. A pair needs three back-to-back buckets, each
   with an observation, so `bar1` needs **an observation every step** (12 h for
   central): 8 gapless buckets give 6 pairs, about 4 days of polls every 11 h.
   A stream observed once a day never gets a pair and stays `naive`. That
   covers a daily central stream such as `crypto_fear_greed`, observed at 00:01
   (`central/src/scripts/extra_streams.py:27`). It also covers a neuron that
   polls once a day, such as a tab open only 9:00–18:00. Gaps are not bridged
   (see Deviations).
5. **φ** = Σxy / (Σxx + σ²/λ1²), where σ² = max(var(y − φ_ols·x), 1e-6) and
   φ_ols = Σxy/Σxx (0 when Σxx = 0). This is namaste_club's posterior mean with
   one regressor; λ1 = 0.2 shrinks φ toward 0 (the random walk) unless the data
   say otherwise.
6. **First lag** r0 = last / (the newest value at least 6 h older) − 1. It is 0
   when there is no such value or when it is more than 24 h older.
7. **Iterate** twice: q = clamp(φ·r, ±0.5) (non-finite → 0), r = q,
   g ← g·(1 + q). This gives g1 (12 h) and g2 (24 h).
8. **Weight** w from a rolling backtest on the stream's own buckets. Take the
   last 28 origins (bucket positions), then drop those whose buckets o, o+1,
   o+2 are not back to back or which have fewer than 6 pairs up to o. On each
   one left, fit φ on the pairs up to o, predict v_o·g2 from r_o, and score it
   against v_{o+2}; persistence predicts v_o. Both errors are relative,
   |x − a|/a. w = clamp(2 − median(model)/median(persistence), 0, 1),
   with namaste_club's rule for a zero persistence error. Fewer than 5 origins →
   w = 1.
9. **Fade**: t1 = last·(1 + w·(g1 − 1)), t2 = last·(1 + w·(g2 − 1)), with
   namaste_club's guards.
`bar1` returns `{model: 'bar1', t1, t2, phi, weight}` and `naive` returns
`{model: 'naive', t1, t2}`.

### `bar1d`: a series with values ≤ 0 (step 6)

A named Base stream's value is a signed counter that starts at 0
(docs/design/base.md); returns of such a series mean nothing (a step from 0,
a sign change). Until step 6 a non-positive bucket was a gap and a
non-positive last value gave `naive`, so such a stream always forecast its
last value, and the Base batch voted DOWN on it forever. Now, when any value
is ≤ 0, the same model runs on additive changes:

- r = v_k − v_{k−1} between back-to-back buckets; the first lag is last − the
  value ≥ 6 h older; the pairs, φ and the 6-pair minimum are as above;
- each iterated step is φ × the one before, clamped to ± the largest change
  seen in the series (the ±50 % clamp is relative, and has no meaning here);
  t1 = last + w·q1, t2 = last + w·(q1 + q2);
- the backtest scores v_o + q1 + q2 and persistence v_o against v_{o+2} by
  absolute error (a level may be 0), and w is the same function of the two
  medians.

It returns `{model: 'bar1d', t1, t2, phi, weight}`. A shift of the whole
series shifts the forecast by the same amount and leaves φ and w unchanged
(tested). A series of positive values is untouched (namaste_club's parity
tests run as before). Central's and Nostr's streams take the same rule, so a
stream with zeros or negatives (a temperature, a rate) is modeled on changes
too, where before its non-positive values were gaps.

`phi` and `weight` are stored on the prediction,
and the Streams table shows the model, with φ and w on hover. An option
`{weight}` forces w, as `MODEL_WEIGHT` does; the backtest uses it.

### Constants

Copied from namaste_club, except `HOLDOUT`: namaste_club's calibration uses
every logged forecast, so the backtest window borrows its λ tuner's holdout.

| Constant | Value | namaste_club |
|---|---|---|
| `STEP_S` | 43,200 s (12 h), UTC-aligned | `features.py:22`, `regrid_history.py:39` |
| `LAMBDA1` | 0.2 | `bvar.py:88` |
| `SIGMA2_FLOOR` | 1e-6 | `bvar.py:180` |
| `MIN_EXTRA_ROWS` | 5 (rows ≥ features + 5) | `bvar.py:158` |
| `HORIZON_STEPS` | 2 | `bvar.py:285`, `pool.py:991` |
| `MAX_STEP_RETURN` | 0.5 | `bvar.py:286` |
| `MIN_SPACING_S` | 6 h | `pool.py:872` |
| `HOLDOUT` | 28 | the λ tuner's holdout, `models.py:552` (borrowed) |
| `MIN_SAMPLES` | 5 | `calibration.py:34` |
| `DEFAULT_WEIGHT` | 1 | `calibration.py:33` |

## The step (relay streams)

`forecast(points, { step })` takes the bucket in seconds; the default is
`STEP_S` (12 h), central's. Everything is counted in buckets (6 lag pairs of
back-to-back buckets before `bar1`, 28 backtest origins, two clamped steps),
and the first lag's minimum spacing is half a step (6 h at 12 h), so a series
on any grid gives the same model
(tested: the same values on a 15 min grid with `step: 900` give exactly the
12 h result). A Nostr stream uses its `cadence_seconds` (12 h when it has
none) and publishes t2, two cadences ahead, as Lite's `predictForRelay`
returns the first row of `_runForecast`'s second, autoregressed forecast
(`engine-lite/engine.py:733-735, 1176-1186`) ([nostr.md](nostr.md#the-engines-step)).

## Deviations, and why

From namaste_club:

- **One stream, lag 1, no time or exogenous features.** The browser forecasts
  each stream when it gets a new row, from its own history. Time features enter
  almost unshrunk (λ1²·100) and add 5 coefficients, so they need far more rows
  than a young neuron has; the research simulation put the 24 h error at 1.4–2.5×
  persistence's with few rows. Cross-stream lags and exogenous features need
  aligned multi-stream tables and outside feeds. Lag 2 and the daily λ tuner
  are left out too, so one setting is pinned by the tests and the parity
  fixture.
- **The fade comes from a rolling backtest, not a log of past submissions.** It
  needs no new storage and no wait for submissions to be scored: the history
  is the record, and it has an opinion from 14 buckets (about 7 days). It also
  avoids namaste_club's feedback loop, where the logged values are the fleet's
  mean of what was submitted, already faded and jittered (`NC/pool.py:516-534`),
  so a faded model is scored as part persistence.
- **Gaps.** namaste_club drops empty buckets, so a return across a gap counts
  as one 12 h step. A browser tab gets closed, so here a gap breaks the
  return, and a first lag more than 24 h old counts as 0. The cost: a stream
  with fewer than one observation per step (a daily stream, or a neuron that
  polls once a day) stays `naive`, rather than being fit on 24 h returns
  labelled 12 h.
- **Values ≤ 0: changes, not returns.** namaste_club computes percent
  changes on any value and only guards the final result. Here a series with
  any value ≤ 0 is modeled on additive changes (`bar1d`, above): a named
  Base stream is a signed counter from 0. (Until step 6 such values were
  gaps and a non-positive last value gave `naive`.)
- **Left out:** posterior draws and the jitter. They spread 4,300 workers
  around the truth; for one node they only add error. Also left out: the
  random model and its 100,000 default (`NC/pool.py:840-845,881`).

From Satori Lite:

- The model is `bar1`/`naive`, not Lite's Starter/XGBoost adapters, and it
  steps by 12 h buckets rather than by rows. Lite's rows arrive every ~11 h, so
  a step is about the same length.
- No per-node diversity (Lite redraws hyperparameters on purpose). It is
  optional and left for later, seeded from the identity as the parked design
  planned ([../plans/engine.md](../plans/engine.md)).

## Verified

- `npm test` (`src/engine/engine.test.js`):
  - namaste_club's tests ported as they are (`NC/tests/test_engine.py`):
    iterate (`:179-200`), the weight rules (`:391-404`), blend (`:406-409`),
    weights from error samples (`:418-433`) and too few samples (`:435-439`);
  - recovery: φ = 0.5 over 400 buckets comes back in (0.4, 0.6) with λ1 = 0.5
    and with 0.2; λ1 = 1e-4 shrinks it below 0.1;
  - minimum data (7 buckets → naive, 8 → bar1); once a day stays naive (a
    daily stream at 00:01, a 9:00–18:00 tab), polls every 11 h reach bar1;
    several points in a bucket; a constant series (φ = 0, t1 = t2 = last); a
    gap; a stale first lag; non-finite values; any order;
  - `bar1d`: a series with a 0 or a negative is modeled on changes; a steady
    counter rising from −10 forecasts last + 2 and + 4 (UP), falling the
    mirror; a shift moves the forecast by the shift (φ and w unchanged); an
    AR(1) of changes gives φ > 0;
  - a model that keeps losing in the backtest gets w < 1;
  - a random-walk guard: over 500 seeds of 8–40 buckets with 1% steps, the mean
    |t2/last − 1| is 0.06% (bound 0.1%, a tenth of one step's typical move).
- **Parity with namaste_club's own code.** `scripts/engine_parity.py` runs
  namaste_club's `create_dataset`, `train_bvar_model` (lag 1, one stream,
  `TIME_COLS = []`), `_gather_market_state` (compiled alone from `pool.py`),
  `iterate_forecast`, `weight_from_errors` and `blend` on 10 series. It writes
  `test/fixtures/engine-parity.json`, and the JS engine matches it to 9 decimal
  places. The backtest weight is this app's deviation, so the script rebuilds
  it from those same calls on each origin's truncated history. The series have
  no gaps and no stale lag, where the two engines differ on purpose. The step-4
  brief's golden values (zigzag φ = −0.705304, t1 = 103.56200, t2 = 104.56234;
  1% compounding t1 = 148.87674, t2 = 150.34611 with 28 samples; the point an
  hour on, r0 = 110/104 − 1, t1 = 108.50565, t2 = 108.85275) came out the
  same from namaste_club's code, and the zigzag also by hand from the formula.
- `npm run e2e`: the app in Chrome makes `naive` until the stream has 8
  back-to-back buckets, then `bar1` with the same t1, t2, φ and weight as
  node, and sends them as Lite's payload.
- Live, on the dev server against central2, in a fresh profile with throwaway
  keys: Poll now stored 83 streams and central accepted 83 of 83 predictions.
  Every stream was `naive`, with t1 = t2 = its latest value: a new neuron has
  one observation per stream. `bar1` starts once a stream has an observation
  in 8 back-to-back 12 h buckets, about 4 days of polls every 11 h. A daily
  stream, or a neuron that polls once a day, stays `naive`.

![Home after Poll now: the Model column](../screenshots/engine.png)

## Measured

`node scripts/backtest.mjs` (read only) runs the neuron as the app does: a
poll every 11 h stores the latest value, and the engine forecasts from all the
history stored so far, starting from none. Each t2 is scored against the first
observation ≥ 24 h later, as is persistence (the last value). Errors are
median |forecast − actual| / actual, pooled over forecasts.

History available on 2026-10-15:

- **Central** serves only each stream's latest observation, so it has none.
- **Base registry**: one stream, 2 daily entries. Too little to score.
- **Binance 1 h closes** (the series namaste_club trains on): 21 of its 24
  symbols over the last 400 days (MKR, EOS and XMR are gone). 871 forecasts
  each, 18,291 in all.

| | forecasts | engine | unfaded (w = 1) | persistence | engine / persistence |
|---|---:|---:|---:|---:|---:|
| all | 18,291 | 1.792% | 1.791% | 1.791% | 1.0006 |
| first 30 days of history | 1,386 | 1.927% | 1.930% | 1.910% | 1.0088 |
| after 30 days | 16,905 | 1.777% | 1.779% | 1.779% | 0.9991 |

- Per symbol, engine / persistence ranges from 0.981 (UNI) to 1.055 (FIL).
  It is at or below 1 on 9 of the 21 symbols.
- The engine is closer than persistence on 48.8% of forecasts and farther on
  49.5%. The rest are equal (`naive`, or w = 0).
- `bar1` makes 99% of the forecasts (88% in the first 30 days). Its mean
  weight is 0.97.

Reading: on liquid crypto pairs the engine **ties persistence**. It neither
wins nor loses in a way that matters (+0.06% of persistence's error overall).
The shrinkage already keeps φ small, so the unfaded model is itself within a
hair of persistence, and the fade has little to correct. The fade matters where
the model is clearly worse: w = 2 − ratio, so it halves the model at 1.5×
persistence's error and drops it at 2×. On streams that do not move
(persistence error 0) it pins the model to persistence. namaste_club found
those streams on safetrade, where its model lost (4.09% vs 3.32%). This app's
backtest cannot test them: there is no history to test on.

Not measured here: the research brief's simulation of time features
(1.4–2.5× persistence's error with few rows) was not re-run.
