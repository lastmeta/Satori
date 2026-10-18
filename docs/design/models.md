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
| central | one per central stream with a forecast (`db.streams()`) | `bvar`, `bar1`, `bar1d`, `naive` (the latest prediction's) | the stream, 24 h ahead in two 12 h steps (t1, t2) | Network (the Satori Network, `network`) |
| Base | one per registry stream in the last batch, and each one left out after a forecast (`meta.base_last_batch`) | `bar1`, `bar1d`, `naive` | the stream at its horizon (max(24 h, cadence)) | Contract (the Satori contract, `contract`) |
| Nostr | one per subscription with a `_pred` (`nostr.status()`) | `bar1`, `bar1d`, `naive`, `echo` (a value that is not a number, echoed) | `<stream>_pred`, one cadence ahead | Relays (the Satori relays, `relays`) |

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
  algorithms: [kind],          // a list: one today; a future ensemble lists several
  kindLabel,                   // its algorithm in plain words: "Bayesian VAR · reads 3 streams", "No change · not enough history yet"
  description,                 // how it works, one sentence: "Learns how this stream moves together with ltc and safetrade_eth, then predicts 24 h ahead."
  inputs: [{ stream, name }],
  outputs: [{ stream, name, as?,                       // as: the `_pred` stream a Nostr model publishes
      latest: { value, ts },
      forecast: { t1?, t2?, value, step, horizon, at }, // at: when it was made
      direction: 'up' | 'down' | 'flat' | null,
      influence: [{ stream, name, share }],             // largest first; sums to 1 (null shares: not kept yet)
      quality,
      destinations: [{ to: 'network' | 'contract' | 'relays', status, when, ref }] }],
  // central's, as models() gave them before: uuid, model, spec { companions: [{ uuid, name }], lambda1, lambda2 }, score, generation, accepted
}
quality = { mark: 'better' | 'tie' | 'worse' | null, ratio, error, noChange,
            text }   // the mark in words: "7% better", "Same as no change", "12% worse", "Not scored yet"
destinations: network  { status: 'accepted' | 'pending', ref: null }                        // the Satori Network (central)
              contract { status: 'sent' | 'left out', ref: { round, game, direction, tx, error? } } // the Satori contract (Base)
              relays   { status: 'published' | 'waiting', ref: { stream, seq, relays } }         // the Satori relays (Nostr)
// (until 2026-10-18 the destinations were 'central' | 'base' | 'network': renamed to the words people see)
```

## Quality: against no change

**Whose score is it?** The neuron's own. The quality figure is the
neuron's **backtest**: how its model would have done on past data against
"no change", worked out as part of training. It is **not** central's
scoring of the predictions the neuron submitted. The tab says so in one
plain line under the bar: "The neuron's own backtest, made as it trains:
how each model would have done on past data against no change. Not the
Satori Network's score of the predictions it sent." (`engine-note`).

*Later (a plan, not built):* also show the real-world score, central's
scoring of what was sent, next to the backtest, once central serves a
neuron's scores; the two answer different questions (would this model have
helped, did it).

The engine scores every model against **no change** (the last
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
- **not scored yet** (`null`) below 5 origins (a young stream), or an
  echoed value. A model whose score is missing or stale is not left so: the
  [training pass](#the-training-pass) scores it at once, from the stored
  history.
- The forecast scored is the **unfaded** one. The fade weight is computed
  from these same medians (w = clamp(2 − ratio, 0, 1)), so scoring the faded
  forecast on the same origins would be circular; the Model says how far the
  fade pulled what was sent ("Fade: 40% of the way back to no change").
- **The median model**: the median ratio of the models with a backtest
  (naive left out: it says nothing about the models).

Where it comes from: scoring is part of training, so each model's backtest
is kept with it by whatever fit it: central's by the poll that ran the
model (`model_specs`: `score`, `persist`, `influence` and the `fit_key` of
the data they were computed on, migrations 11 and 12); Nostr's by the
intake with each `_pred` (`relay_streams.p_score`, `p_persist`, `p_tests`);
Base's on the batch's games. Whatever lacks a current one, the training
pass fills. The list computes nothing: it reads what is kept.

On the page each mark is **short words in its colour** (`quality.text`), a
tinted pill: "7% better" green, "Same as no change" grey-blue (on a phone
"Same"), "12% worse" amber, "Not scored yet" in a dashed outline. The list
row, the drill-in's header and the status bar's legend say the same. (It
was an icon in a circle beside a symbol, ✓ "−3%", = "+1%", "new": the
owner read neither.) The pill's ink is the colour mixed 65% toward the text,
so it reads on its tint in light and dark. The amber is the model's own mark
against no change, not the engine's status: the fade already pulls a weak
model toward no change, and nothing needs the person.

## The training pass

The owner, 2026-10-18 ([../intent/engine.md](../intent/engine.md)): "Why
aren't you doing anything? I can see that you have work to do." The tab
said *Resting* over "Beats no change on 0 of 83 · ties 2 · worse 0 · 81 not
scored yet": those 81 specs were stored before migration 11, and only a
poll scored a model, so they waited up to 11 h. The neuron never rests
while a model it runs lacks a current fit.

`src/neuron/train.js`. **What lacks a fit** is read from the data each time
(`lacking()`), never queued:

| Model | Current when | Else |
|---|---|---|
| central | its spec's `fit_key` is its data's now: `v1`, λ1, λ2, then the target's and each companion's row count and newest time (`fitKey`, from `db.streams()`'s `observations` and `obs_ts`) | null (stored before migration 12), or new history (a poll's row, a backfill), a new spec, a changed companion |
| Nostr | its latest `_pred` has its backtest (`p_tests` not null; the intake keeps it with each one) | a `_pred` kept before migration 12 |
| Base | its game has `score` or `tests` (the batch keeps them with each game) | a batch from before they were kept: scored from the chain's history (the registry, one read per game as the batch reads it), kept in memory for the session |

naive and echo have nothing to score (naive is no change itself).

**The pass** (`trainPass`) fits each one with stored history only:
central's with `fitter` ([engine.md](engine.md#what-the-models-tab-reads)),
the poll's own scoring with no repair and no proposal, so the spec, its
generation and its mutations never change and the numbers are the poll's on
the same data (tested); Nostr's and Base's with `explainForecast` at their
step and horizon. Central's histories are one read (`db.histories` of the
targets and their companions), then the fits are one write (`db.saveFits`,
only where the spec is still the one fit: a poll that evolved it meanwhile
wins). It **never predicts and never submits**: no prediction row, no
central call (tested with a spy, and in Chrome against the stub central:
no poll, no predictions batch).

**When it runs** (`createTrainer`, one pass at a time, one more after it
when asked during it):

- on load, once the screen shows the models;
- after a poll and after the load-time history, when central's work ends;
- whenever the list is read again (central's streams, the Nostr status, the
  Base status changed), if something lacks a fit.

It waits while central's work runs (a poll, its sign-in, the history) and
stops between models when a poll begins; what it fit is kept, and the
poll's end runs it again for the rest. A closed tab is the same: nothing is
queued, so the next open picks up exactly what still lacks a fit
(restart-safe by construction). A model it tried this session with the same
data is not tried again (a fit that cannot be kept never loops).

**What it shows**: the work task `train`, step `score`: Home's hero and the
Models status read "Scoring models · 12 of 81" in regular green (working,
never critical), then *Resting* once the list is read again with the
scores. A poll and the Base batch lead over it on the hero. It gives the
page a turn between models once 10 ms of work have passed
(`scheduler.yield`, else a task), so the page stays responsive.
`status().train` is the last pass: `{ central, nostr, base, stopped, ms }`.

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
| Working | green (`working`), vivid while sending (`critical`) | the poll, the Base batch or the training pass runs | the step, in Home's hero's words at its pace: "Building models · 40 of 82", "Scoring models · 12 of 81" |
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
not scored with its legend in the rows' words, a swatch of each colour:
"24 better · 40 same as no change · 19 worse" ("· 2 not scored yet" when
there are some); "Median model: 1% less error than no change"; the plain
line on whose score it is.

## The list

Each row, scannable: the mark in words; the name (a Nostr model also "→
`<stream>_pred`"); the kind as a chip; the inputs it reads besides the
stream, as chips by influence ("+eth +gold"); the values labelled, "Now
3,153.92 · in 24 h 3,141.01 ↓", the horizon the model's own (24 h, 1 h,
a day), the arrow after the forecast saying which way it goes from now (on
a phone, two short lines: "Now 3,153.92" and "in 24 h 3,141.01 ↓"); where
its predictions go, as tiny text tags in the chip style ("Network",
"Contract", "Relays": the pictograms they replaced were unreadable). Above it, on the left, the
filters **All · Network · Contract · Relays** (with counts); on the right a
borderless **Sort** with a sort icon (three stacked lines) that shows its
choice subtly ("Sort: Quality"). Tapping it opens a small menu, **Quality**
and **Name**, with a check on the current choice (quality: the lowest ratio
first, not scored last). It is WAI-ARIA's menu button: the current choice
is focused when it opens, the arrows (and Home, End) move, Enter or a tap
chooses, Escape closes back to the button, Tab or a tap elsewhere closes;
the button and each item are 44 px tall. The choice is kept on this device
(`localStorage` `satori-models-sort`, read and written in try/catch as the
theme is, `src/ui/prefs.js`). (It was two segmented buttons, Quality ·
Name, which the owner did not read as a sort.) A computer shows a dense
table; a phone shows each row as the name and where it goes, then the mark,
the kind, the inputs and the values, wrapping, never cut. A tap opens the drill-in; the back link
returns to the list where it was.

## The drill-in

`#models/<id>` (a link or a reload opens it; the back link is the browser's
back when the list came first). Under the model's name, always, **what it
is** in plain words (`kindLabel`): "Bayesian VAR · reads 3 streams",
"Single-stream AR (bar1)", "Single-stream AR on changes (bar1d)", "No
change · not enough history yet", "Echo · the value is not a number"; a
model of several algorithms (`algorithms` is a list) would read "Ensemble ·
3 algorithms". Beside the name, its mark in words. Then the source ("Satori
Network stream"). Top to bottom, joined by short arrows:

- **In**: each input with its share as a bar, ranked; for a model of several
  outputs, a choice of whose inputs.
- **Model**: first how it works, in one sentence (`description`): "Learns
  how this stream moves together with ltc and safetrade_eth, then predicts
  24 h ahead."; bar1 "Learns how each 12 h move of this stream follows the
  one before, then predicts 24 h ahead."; naive, with the true rule (6 lag
  pairs need 8 back-to-back steps): "Repeats the latest value until it has 4
  days of back-to-back history." (8 h for an hourly stream). Then in plain
  lines: "Predicts 24 h ahead in 12 h steps", "Learned
  from 49 steps of history (12 h each)", "Backtest over 28 tests: 15% less
  error than no change", "Fade: none, its forecast is sent as is", "Trained
  2 h ago". **Details** (closed): λ1, λ2, mutations tried and kept, the
  coefficients (or φ), the fade weight, the median error and no change's,
  rows and backtests.
- **Out**: per output: the forecast (t1 and t2, or the one value), the
  latest value, a chart, and where it went: Network ("Accepted Oct 18,
  16:23", or "Pending since …"), Contract ("Round 20743 · UP · tx 0xab…cd",
  linked to the explorer; or "left out: …"), Relays ("`btc_pred` #12 · 2
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
ringed in the surface colour and labelled with its value; each forecast
point labelled with how far ahead it is, "12 h" and "24 h" (one point:
"24 h", "1 h"), so the open and the filled circle mean something without a
legend (two points too close for both, as a week of history on a phone puts
them, are labelled a line apart); a hairline where the forecast was
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
  shows (refreshed after every poll, Nostr publish, Base check and training
  pass; `poll()` resolves after it), each with the backtest kept with it.
- `(await satori.status()).train` → the last training pass, `{ central,
  nostr, base, stopped, ms }`, or null (none this session); while one runs,
  `health().work` is `{ task: 'train', step: 'score', done, total }`.
- `await satori.model(id)` → the drill-in: the model's fields, `model: {
  kind, rows, tests, step, horizon, weight, phi, coef, lambda1, lambda2,
  generation, accepted, trained, quality }`, each output's `history` (the
  chart's points) and `influence` from the refit, `ms` and `readMs`. `id`:
  models()'s, or a central stream's uuid or name. null when there is none.
- `satori.go('models')`, `satori.go('models/<id>')`; the URL's `#models`,
  `#models/<id>`.
- `data-test`: `models-tab`, `engine` (`data-tone`), `engine-title`,
  `engine-line`, `engine-kinds`, `engine-quality` (the bar's legend: its items `.qleg`, its `aria-label` the
  whole line), `engine-median`, `engine-note`,
  `models-filter-<all|network|contract|relays>`, `models-sort` (the Sort button, `aria-expanded`),
  `models-sort-menu`, `models-sort-<quality|name>` (its items, `aria-checked`),
  `models`, `model-row` (`data-id`, `data-mark`) with `model-mark` (the words; `data-short`: the phone's),
  `model-name`, `model-kind`, `model-inputs`, `model-forecast`, `model-to`;
  `models-empty`; the drill-in `model-detail`, `model-back`, `model-title`,
  `model-in` with `model-input`, `model-model` with `model-line` and
  `model-details`, `model-out` with `model-output` (`data-stream`),
  `model-output-name`, `model-output-forecast`, `model-chart`,
  `model-endpoint`, `model-ahead` (the forecast points' "12 h", "24 h"), `model-readout`, `model-destination` (`data-to`),
  `model-kind-label`, `model-quality`;
  `model-loading`, `model-error`.

## Cost

Measured 2026-10-18 on this shared 8-core box, headless Chrome, each live
drill-in 3 times (the median), every one of the 83 models:

| What | Busy box (load 5–6) | Quieter |
|---|---|---|
| A drill-in, live on central2 (83 streams, ~54,760 rows of central's history) | **74 ms** median, max 101 ms; the history read 44 ms | **25 ms** median, max 80 ms; the read 21 ms |
| The same from an agent, `satori.model(id)`, timed in the page | 81–182 ms | |
| `satori.models()` (83 models), timed in the page | 2–12 ms | |
| A drill-in in the e2e (8 streams, 600 hourly rows each) | 22–112 ms, the read 19–75 ms | 15 ms, the read 13 ms |
| The poll's engine, for comparison (83 targets, a champion and a challenger each) | 924–1,111 ms | 503–565 ms (205 ms on a quiet box, [engine.md](engine.md#measured)) |

The refit itself is 4–30 ms; the rest is the one read of 2–4 streams'
history in DuckDB's worker.

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
  `src/db/db.test.js` (migrations 11 and 12, `histories`, `saveFits`,
  `setRelayFit`); `src/neuron/train.test.js` (the training pass: the fit
  key; exactly the models without a current fit, central, Nostr and Base;
  each scored as the poll would with the spec untouched; never a
  prediction; stopped between models and resumed by the next pass; a poll
  that evolved a spec meanwhile wins; it waits for central's work; the work
  state "Scoring models · k of n", refreshed before it ends);
  `neuron.test.js` (a poll's specs carry their fit key: nothing lacks a fit
  after it).
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
  tap target is 44 px; the Sort menu: the filters on the left and Sort on
  the right, open (the current choice checked and focused), the arrows,
  Enter, Escape back to the button, a tap outside, the choice kept over a
  reload, its items 44 px on the phone. `src/ui/prefs.test.js`: the kept
  choice (storage blocked: the default) and the menu's keys.
  `e2e/home.spec.js` checks the Models tab on the phone
  with the others. `e2e/train.spec.js`: a neuron whose stored specs lost
  their scores (cleared through the e2e store page, as a version before
  migration 11 left them) opens to "Scoring models · k of 8" on Home and
  the tab (working green, never *Resting* before it), then every score is
  back, equal to the poll's, and *Resting*; no poll, no predictions batch;
  a reload with nothing to do rests at once.

## Live

2026-10-18 17:12, the dev server on :5180 restarted with the final code,
against central2, a fresh Chrome profile, no stubs (prod blocked, none
asked): setup → the first poll at once: 83 streams, central's history for
all 83 (54,761 rows), 83 of 83 accepted. The tab: *Resting*, "Trained just
now · next run in 11 h", "83 models · 81 bvar · 2 naive", "Beats no change
on 18 of 83 · ties 43 · worse 22", "Median model: the same error as no
change". Each fresh profile draws its own specs (the identity seeds them):
three others that day read 24 / 40 / 19, 17 / 49 / 17 and 19 / 32 / 32, the
median model between 1% less error and the same. Nothing scrolls sideways at
390 px.

![The Models list live on central2](../screenshots/models-live-list-desktop-light.png)

<img src="../screenshots/models-live-list-phone-light.png" alt="The list on a phone, live" width="240"> <img src="../screenshots/models-live-list-phone-dark.png" alt="The list on a phone, live, dark" width="240">

A drill-in live (xrp: 74% ltc, 15% safetrade_eth, 11% itself; 20% less
error than no change over 24 tests; the line breaks where central2's history
has gaps):

![A bvar drill-in live](../screenshots/models-live-drill-desktop-light.png)

## Screenshots

From `e2e/models.spec.js` (`SHOTS=1`): the list and a bvar drill-in, on a
phone (390 px; the drill-in whole) and a computer (1280 px), light and dark:
`docs/screenshots/models-{list,drill}-{phone,desktop}-{light,dark}.png`, a
naive drill-in (the Base default stream) `models-drill-naive-*.png`;
the Sort menu open on a phone, `models-sort-phone-{light,dark}.png`.

The Sort menu open on a phone, light and dark:

<img src="../screenshots/models-sort-phone-light.png" alt="the Sort menu open, phone, light" width="200"> <img src="../screenshots/models-sort-phone-dark.png" alt="the Sort menu open, phone, dark" width="200">

A naive model's drill-in on a phone: what it is, its rule, the chart's labels:

<img src="../screenshots/models-drill-naive-phone-light.png" alt="a naive drill-in, phone, light" width="200"> <img src="../screenshots/models-drill-naive-phone-dark.png" alt="a naive drill-in, phone, dark" width="200">

<img src="../screenshots/models-list-phone-light.png" alt="the list, phone, light" width="200"> <img src="../screenshots/models-list-phone-dark.png" alt="the list, phone, dark" width="200"> <img src="../screenshots/models-drill-phone-light.png" alt="a drill-in, phone, light" width="200"> <img src="../screenshots/models-drill-phone-dark.png" alt="a drill-in, phone, dark" width="200">

![The list on a computer](../screenshots/models-list-desktop-light.png)

![The list on a computer, dark](../screenshots/models-list-desktop-dark.png)

![A bvar drill-in on a computer](../screenshots/models-drill-desktop-light.png)

![A bvar drill-in on a computer, dark](../screenshots/models-drill-desktop-dark.png)
