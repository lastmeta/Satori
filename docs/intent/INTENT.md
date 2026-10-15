# Intent

An alternative to the Docker neuron (`../neuron`, Satori Lite): the Satori
neuron as an app that lives entirely in the browser. It runs client-side and
needs no server of our own.

- The Docker neuron stays. This is a second way to run a neuron, not a replacement.
- The owner's preferred toolkit for client-side apps is ArrowJS and DuckDB-WASM.
- The end goal is full neuron behaviour in the browser ("it'll do it all").
- It is named `satori` (lowercase) inside `Satori/` because the earlier names are
  taken and earlier codebases are not to be changed.

## Build it in steps (owner, 2026-10-15)

Lay an essentialist foundation first, then evolve it quickly.

**Step 1 — MVP (minimal viable prototype):** a client-side app with:
- **key management**, the most important part;
- a basic UI;
- basic data management in a database (DuckDB-WASM is preferred; IndexedDB is
  acceptable), which must work really well;
- the core flow: get data from somewhere → pass it to the engine → build a model
  → extract a prediction → publish the prediction;
- a linear model as the engine, kept absolutely simple.

**Later:** Nostr, Base, central, a better engine, and so on. The full design for
these is already researched and parked in [../plans/](../plans/README.md).
