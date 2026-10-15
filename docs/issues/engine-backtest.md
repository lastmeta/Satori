# Engine: no Base history long enough to backtest yet; selection notes

[← issues](README.md) · design: [../design/engine.md](../design/engine.md)

Found while building `src/engine` (2026-10-15). Read-only probes of Base Sepolia,
`scripts/engine-fetch-histories.mjs`, `scripts/engine-backtest.mjs`.

## Registry histories are too short to backtest

- Current deployment (`contract/satori/deployments/baseSepolia.json`, registry
  `0x1ED7…743a`): 1 stream ("Satori Predictions"), 1 history entry.
- Previous deployment (`baseSepolia-PRE-humble-20261014.json`, registry `0x7424…D4f7`):
  2 game streams, 8 and 4 entries. Saved as `test/fixtures/engine-base-histories.json`.
- Older (`baseSepolia-PRE-rolling-20260908.json`): no `getHistoryPage`; 4 streams of 1–3 values.

So every Base stream is below the 10-point SES threshold today and the engine
answers naive; the "add damped Holt if a registry backtest shows a win" check in
engine.md cannot run yet. Rerun `node scripts/engine-fetch-histories.mjs` then
`node scripts/engine-backtest.mjs` once streams have weeks of history.

## Reading of "fit SES by grid, keep the lower rolling MAE"

Implemented as: α fitted on the whole series (min one-step SSE, grid 0.02…0.98),
then naive vs SES(α) on one-step MAE over the last 20 points, seeded pick if both
are within 1%. A first version that scored all 49 grid alphas as candidates on the
20-point window was 2.8% worse than naive on a synthetic random walk (window
overfit); this version is within 0.3% on random walks and 25% better on
level-plus-noise series (synthetic, 768 points, 5 node keys). The diversity band
therefore spans two candidates, not the whole grid.

## Direction rule on mean-reverting series (inherent to the rule)

The OLS-slope direction scores ~50% on random walks (as engine.md expects), 57%
with drift, but 39–45% on mean-reverting series (noise around a level, AR(1)),
where the last-k slope points the wrong way. Satori's streams are mostly prices
(random-walk-like), so this is accepted, not fixed. Fix if a stream type that
mean-reverts gets a game: a sign test against the SES level instead of the slope.
