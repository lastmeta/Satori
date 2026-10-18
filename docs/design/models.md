# Models: the engine, model by model

[← OVERVIEW](OVERVIEW.md) · intent: [../intent/ui.md](../intent/ui.md) (the
owner's direction, 2026-10-18) · the engine: [engine.md](engine.md)

The owner's ask: the neuron is an ETL process (streams come in, get
combined, a model is trained, it predicts, and the predictions are loaded
into central, Base and Nostr), and nothing showed that line. Not a canvas:
the simplest view. The **Models** tab (Home · Models · Streams · Wallet ·
Settings) shows:

- on top, **the engine's status**: is it working right now, are the models
  any good;
- **every model**, each named for the stream it predicts (one model per
  predicted stream today);
- **a model's drill-in** (`#models/<id>`), top to bottom as the pipeline:
  **In** (the streams it reads, ranked by how much each moves its forecast),
  the **Model**, **Out** (what it predicts, and where each forecast went).

The Streams tab stays as it is (it may later become "streams I publish").
Nothing new goes over the network: the tab reads what the neuron already
keeps, except a Base model's drill-in, which reads that stream's history
from the chain (one read, as the batch does).

Code: `src/neuron/models.js` (the data: pure but for the drill-in's reads),
`src/ui/drill.js` (what each part says: pure), `src/ui/models.js` (the
templates), the engine's `explainForecast`, `influence` and `explainModel`
([engine.md](engine.md#what-the-models-tab-reads)).

## The models

Every model the neuron runs, from what the app already holds:

| Source | Models | Kind | Output | Goes to |
|---|---|---|---|---|
| central | one per central stream with a forecast (`db.streams()`) | `bvar`, `bar1`, `bar1d`, `naive` (the latest prediction's) | the stream, 24 h ahead in two 12 h steps (t1, t2) | Central |
| Base | one per registry stream in the last batch, and each one left out after a forecast (`meta.base_last_batch`) | `bar1`, `bar1d`, `naive` | the stream at its horizon (max(24 h, cadence)) | Base |
| Nostr | one per subscription with a `_pred` (`nostr.status()`) | `bar1`, `bar1d`, `naive`, `echo` (a value that is not a number, echoed) | `<stream>_pred`, one cadence ahead | Network |

A model's id is `<source>:<key>`: `central:<stream uuid>`, `base:<stream
id>`, `nostr:<relay stream uuid>`.

**Outputs are a list.** Today each model predicts one stream, so it has one
output and is named for it. The engine may later make one model for several
streams (a single VAR, a network); such a model's `name` reads like "bvar ·
3 streams", its Out draws every output with its own chart and destinations,
In shows the inputs of the output chosen (each input's influence differs per
output), and its quality is the median of its outputs' ratios. Nothing in
the view assumes one output (a unit test draws a fabricated two-output
model).

```
{ id, source: 'central' | 'base' | 'nostr', name, kind, quality, trained,
  inputs: [{ stream, name }],
  outputs: [{ stream, name, as?,                       // as: the `_pred` stream a Nostr model publishes
      latest: { value, ts },
      forecast: { t1?, t2?, value, step, horizon, at }, // at: when it was made
      direction: 'up' | 'down' | 'flat' | null,
      influence: [{ stream, name, share }],             // largest first; sums to 1 (null shares: not kept yet)
      quality,
      destinations: [{ to: 'central' | 'base' | 'network', status, when, ref }] }],
  // central's, as models() gave them before: uuid, model, spec { companions: [{ uuid, name }], lambda1, lambda2 }, score, generation, accepted
}
quality = { mark: 'better' | 'tie' | 'worse' | null, ratio, error, noChange }
destinations: central { status: 'accepted' | 'pending', ref: null }
              base    { status: 'sent' | 'left out', ref: { round, game, direction, tx, error? } }
              network { status: 'published' | 'waiting', ref: { stream, seq, relays } }
```

## Quality: against no change

The engine already scores every model against **no change** (the last
value, "persistence") in its rolling backtest ([engine.md](engine.md#the-backtest-score-and-fade)):
at each of the last 28 origins, the model fit on the data up to the origin
forecasts the horizon (24 h for central), and both its error and no change's
are measured against what came. The tab uses exactly those numbers:

- `error` = the median of the model's errors (`score`), `noChange` = the
  median of no change's on the same origins, `ratio` = error / noChange.
- **better** below 0.95, **worse** above 1.05, **tie** between. The band is
  evolution's margin (`MARGIN`, 5 %): the change a neuron needs to see before
  it keeps a mutation. Inside it, the backtest can't tell the two apart.
- **naive** is no change itself: a tie by construction (`=`, ratio 1).
- **not scored yet** (`null`) below 5 origins (a young stream), an echoed
  value, or a central spec stored before this tab (its next poll scores it).
- The forecast scored is the **unfaded** one. The fade weight is computed
  from these same medians (w = clamp(2 − ratio, 0, 1)), so scoring the faded
  forecast on the same origins would be circular; the Model says how far the
  fade pulled what was sent ("Fade: 40% of the way back to no change").
- **The median model**: the median ratio of the models with a backtest
  (naive left out: it says nothing about the models).

Where it comes from: central's `score` and `persist` are kept by the poll
that ran the model (`model_specs`, migration 11); Base's on the batch's
games; Nostr's are computed on demand from the stored history, once per
published `_pred` (`nostrScores`, cached by seq).

On the page each mark is a shape and a colour plus a short number: ✓ green
(better, "−3%": 3% less error), = grey-blue (tie, "+1%"), − amber (worse,
"+8%"), a dashed ring (not scored, "new"). The amber is the model's own mark
against no change, not the engine's status: the fade already pulls a weak
model toward no change, and nothing needs the person.

## Influence: how much each input moves the forecast

For a `bvar` model (a Bayesian VAR(1) of the target and its 1–3 companions,
[engine.md](engine.md#the-model)), the target's forecast is Σₖ coef[0][k] ×
(input k's last step). An input's influence is its **standardized
coefficient** in that equation: |coef[0][k]| × σ(input k's step over the
rows the model learned from), how far a typical step of that input moves the
forecast. The tab shows them as shares that sum to 100%, the target's own
last step included ("eth (itself)"), largest first. The plain line on the
page: "Each bar: how far a typical move of that stream shifts this forecast,
as a share of all of them."

- `bar1`, `bar1d` and `naive` read the stream alone: itself, 100%.
- The shares say what the model leans on, not how far it moves the forecast
  at all: in a model shrunk toward the random walk the coefficients are tiny
  and still sum to 100%. The Backtest and Fade lines say how much it does.
- The sign is left out of the bars (a companion can push either way); the
  coefficients are under Details.
- With every coefficient 0, the forecast is the last value: itself, 100%.

Tested (`src/engine/bvar.test.js`): a fit of three series where one
companion drives the target ranks it first (above 60%) on three seeds, the
shares sum to 1, |coef| × σ by hand, the sign ignored. Live, a stream that
trails another by 12 hours was 98% that other stream (the e2e's eth and
bitcoin).

## The engine's status (top of the tab)

| Title | Tone | When | Line |
|---|---|---|---|
| Working | green (`working`), vivid while sending (`critical`) | the poll or the Base batch runs | the step, in Home's hero's words at its pace: "Building models · 40 of 82" |
| Resting | sky (`idle`) | otherwise | "Trained 2 h ago · next run in 9 h" (the newest forecast; central's next poll) |
| No models yet | sky | before the first poll | "The first poll builds them · in 1 min" |
| Needs a look | amber (`warn`) | the engine itself failed: the last run's local error (the database or the engine) | "The last run failed: …" |

The tones are Home's ([health.md](health.md#the-tone-three-greens)); amber
only when something is wrong with the engine. Central's own failures (a
refused batch, a timeout) are Home's to say. **One moving indicator**: the
Models tab shows the step with the still "working" mark, never a second
turning ring (`e2e/models.spec.js` checks the tab has no running animation
while a poll is held). The step text comes from the same work state
(`src/neuron/work.js`) through its own pacer (`src/ui/hold.js`), keyed on the
step, so a count ticks at once.

Under it: "83 models · 81 bvar · 2 naive"; a bar of better / tie / worse /
not scored; "Beats no change on 24 of 83 · ties 40 · worse 19"; "Median
model: 1% less error than no change".

## The list

Each row, scannable without reading: the mark and its number; the name (a
Nostr model also "→ `<stream>_pred`"); the kind as a chip; the inputs it
reads besides the stream, as chips by influence ("+eth +gold"); the latest
value → the forecast with an arrow (↑ ↓ →); small icons for where its
predictions go (Central, Base, Network). Above it: **All · Central · Base ·
Network** (with counts) and **Quality · Name** (quality: the lowest ratio
first, not scored last). A computer shows a dense table; a phone shows each
row in two lines (the name and where it goes; the kind, the inputs and the
values, wrapping, never cut). A tap opens the drill-in; the back link
returns to the list where it was.

## The drill-in

`#models/<id>` (a link or a reload opens it; the back link is the browser's
back when the list came first). Top to bottom, joined by short arrows:

- **In**: each input with its share as a bar, ranked; for a model of several
  outputs, a choice of whose inputs.
- **Model**: in plain lines: "Predicts 24 h ahead in 12 h steps", "Learned
  from 49 steps of history (12 h each)", "Backtest over 28 tests: 15% less
  error than no change", "Fade: none, its forecast is sent as is", "Trained
  2 h ago". **Details** (closed): λ1, λ2, mutations tried and kept, the
  coefficients (or φ), the fade weight, the median error and no change's,
  rows and backtests.
- **Out**: per output: the forecast (t1 and t2, or the one value), the
  latest value, a chart, and where it went: Central ("Accepted Oct 18,
  16:23", or "Pending since …"), Base ("Round 20743 · UP · tx 0xab…cd",
  linked to the explorer; or "left out: …"), Network ("`btc_pred` #12 · 2
  relays").

**Computed on demand** (`modelDetail`): the stored spec and the stored
history of the target and its companions (one read, `db.histories`), refit
as the poll fit it (`explainModel`; Nostr and Base: `explainForecast` at
their step and horizon). Until new history arrives it is the poll's model
exactly (the e2e compares the drill-in's influence with the one the poll
kept). In and the Model are that refit; Out is what was sent. When the
refit is another kind than the forecast sent (history came after the poll),
In and the Model fall back to what the list kept. An open drill-in follows
its model: after a poll, a `_pred` published or a Base batch it is
recomputed (the e2e publishes one more observation with a Nostr model open
and sees its `#17` in Out).

**The chart** (one series, so no legend; the title names it): the history
from 7 horizons before the forecast was made (at most 400 points) as a 2 px
line in the accent colour, broken where observations stop for over four of
their usual intervals; the forecast to scale in time and value, dashed from
the last point, t1 as a ring and the endpoint (the value sent) filled,
ringed in the surface colour and labelled; a hairline where the forecast was
made; the range's top and bottom as hairlines with their values outside the
plot; the first time and "+24 h" under it. Hover, or the arrow keys once
focused, moves a crosshair and the readout under the chart says that point
("Oct 17, 14:00 · 2,597.00"; at rest, the forecast's). Every value the
readout gives is also in the text above it or the table of history the agent
API returns. It is drawn px for px at the block's measured width
(`ResizeObserver`), so text and dots keep their size on a phone and a
computer, from the theme's tokens, light and dark. Two constraints shaped
it: the CSP allows no inline style (`style-src 'self'`), so geometry is SVG
attributes; and ArrowJS 1.0.6 builds an inserted chunk outside the SVG
namespace, so a chart's children are fixed and only their attributes move.

**Huge or tiny values** (a Base registry value is often a ratio × 10¹⁸) print
in four digits and a power of ten ("5.906e16", "1.234e−6"), never "0".

## Agents

- `await satori.models()` → every model, as above. It reads what the tab
  shows (refreshed after every poll, Nostr publish and Base check; `poll()`
  resolves after it), with the Nostr models' backtests from their history.
- `await satori.model(id)` → the drill-in: the model's fields, `model: {
  kind, rows, tests, step, horizon, weight, phi, coef, lambda1, lambda2,
  generation, accepted, trained, quality }`, each output's `history` (the
  chart's points) and `influence` from the refit, `ms` and `readMs`. `id`:
  models()'s, or a central stream's uuid or name. null when there is none.
- `satori.go('models')`, `satori.go('models/<id>')`; the URL's `#models`,
  `#models/<id>`.
- `data-test`: `models-tab`, `engine` (`data-tone`), `engine-title`,
  `engine-line`, `engine-kinds`, `engine-quality`, `engine-median`,
  `models-filter-<all|central|base|network>`, `models-sort-<quality|name>`,
  `models`, `model-row` (`data-id`, `data-mark`) with `model-mark`,
  `model-name`, `model-kind`, `model-inputs`, `model-forecast`, `model-to`;
  `models-empty`; the drill-in `model-detail`, `model-back`, `model-title`,
  `model-in` with `model-input`, `model-model` with `model-line` and
  `model-details`, `model-out` with `model-output` (`data-stream`),
  `model-output-name`, `model-output-forecast`, `model-chart`,
  `model-endpoint`, `model-readout`, `model-destination` (`data-to`);
  `model-loading`, `model-error`.

## Cost

Measured 2026-10-18 on this shared 8-core box (load average 5–6 from other
work), headless Chrome:

| What | Time |
|---|---|
| A drill-in, live on central2 (83 streams, 54,756 rows of central's history), each model 3 times, the median | **74 ms** (median of 83; max 101 ms), of which 44 ms reading the history and ~30 ms the refit |
| The same from an agent, `satori.model(id)` | 81–182 ms |
| `satori.models()` (83 models) | 2–12 ms |
| A drill-in in the e2e (8 streams, 600 hourly rows each) | 22–112 ms, the read 19–75 ms |
| The poll's engine, for comparison (83 targets, a champion and a challenger each) | 924–1,111 ms here (205 ms on a quiet box, [engine.md](engine.md#measured)) |

Two changes made it cheap: the drill-in reads its 2–4 streams in one query
(one query per stream: ~100 ms of a ~110 ms drill-in in the e2e), and the
agent API reads the tab's state instead of every stream's row again
(`db.streams()`, ~0.6 s live: `models()` took 1.6 s, `model(id)` 0.7–0.9 s).

## Verify

- `npm test`: `src/neuron/models.test.js` (the quality classes and their
  edges, naive and not scored, a perfect no change, several outputs' median;
  the list from central rows, Nostr subscriptions and a Base batch with what
  was left out; the summary; sort and filter; the status's four states;
  the drill-in recomputed for a bvar model, a Nostr model, a Base model with
  and without the chain; the Nostr scores cached per seq);
  `src/ui/drill.test.js` (a fabricated **two-output model**: Out draws both
  outputs, each with its forecast, chart and destinations, and In follows
  the chosen output; the Model's plain lines and Details; quality and
  destinations in words; the chart's scales, the endpoint, the step to
  scale, a gap; the row and the status); `src/engine/bvar.test.js`
  (influence), `engine.test.js` (`explainForecast`), `evolve.test.js` (what
  `runModels` keeps; `explainModel` gives the poll's numbers again);
  `src/db/db.test.js` (migration 11, `histories`).
- `npm run e2e`: `e2e/models.spec.js`: a new neuron on the stub central with
  8 streams and 600 hours of history, staked on the fake chain (its batch:
  2 Base models) and subscribed to a stream on a test relay (16
  observations: a Network model). The status (Resting, Working with no
  animation on the tab while a poll is held, the counts by kind and mark),
  `models()`, filter by destination, sort by name and quality, a row's
  chips, a bvar drill-in (In ranked and summing to 100%, the Model, Details,
  Out with its chart and Central's acceptance) and `model(id)` against the
  list, back to the list where it was, a Base drill-in, a deep link over a
  reload, an unknown id; at 390 and 360 px nothing scrolls sideways and every
  tap target is 44 px. `e2e/home.spec.js` checks the Models tab on the phone
  with the others.

## Live

2026-10-18, the dev server on :5180 restarted, against central2, a fresh
Chrome profile, no stubs (prod blocked, none asked): setup → the first poll
at once: 83 streams, central's history for all 83 (54,756 rows), 83 of 83
accepted. The tab: *Resting*, "Trained just now · next run in 11 h", "83
models · 81 bvar · 2 naive", "Beats no change on 24 of 83 · ties 40 · worse
19", "Median model: the same error as no change" (another fresh profile drew
other specs: 17 better, 49 ties, 17 worse, the median 1% less error). Nothing
scrolls sideways at 390 px.

![The Models list live on central2](../screenshots/models-live-list-desktop-light.png)

<img src="../screenshots/models-live-list-phone-light.png" alt="The list on a phone, live" width="240"> <img src="../screenshots/models-live-list-phone-dark.png" alt="The list on a phone, live, dark" width="240">

A drill-in live (neo: 55% safetrade_nock, 19% itself; 15% less error than no
change over 24 tests; the line breaks where central2's history has gaps):

![A bvar drill-in live](../screenshots/models-live-drill-desktop-light.png)

## Screenshots

From `e2e/models.spec.js` (`SHOTS=1`): the list and a bvar drill-in, on a
phone (390 px; the drill-in whole) and a computer (1280 px), light and dark:
`docs/screenshots/models-{list,drill}-{phone,desktop}-{light,dark}.png`.

<img src="../screenshots/models-list-phone-light.png" alt="the list, phone, light" width="200"> <img src="../screenshots/models-list-phone-dark.png" alt="the list, phone, dark" width="200"> <img src="../screenshots/models-drill-phone-light.png" alt="a drill-in, phone, light" width="200"> <img src="../screenshots/models-drill-phone-dark.png" alt="a drill-in, phone, dark" width="200">

![The list on a computer](../screenshots/models-list-desktop-light.png)

![The list on a computer, dark](../screenshots/models-list-desktop-dark.png)

![A bvar drill-in on a computer](../screenshots/models-drill-desktop-light.png)

![A bvar drill-in on a computer, dark](../screenshots/models-drill-desktop-dark.png)
