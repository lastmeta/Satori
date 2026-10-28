# UI intent

## In a nutshell

The neuron is set-and-forget automation, and the UI is designed to save
people's time and attention. When someone opens it, they should see at a
glance whether everything is fine ("yep, it's good") or whether there's a
problem. Their first question is whether the neuron is making its
predictions every day on its own, and whether anything is broken or has
quietly stopped. Optimize for time, ease and beauty. Show it, don't explain
it in walls of text.

## Direction now

- Design for the phone first, which forces a choice of the top few things
  to show. On a computer, the same view becomes a dashboard that shows
  everything at once.
- The first screen is the neuron's health: whether it is predicting, and its
  connections. Technical detail (keys, addresses, endpoints, relays) moves
  behind settings or account. It is not the main screen.
- This is not a game. Manual play lives in Satori Daily.
- A **Models** tab shows the engine. Its status sits on top, above a list of
  models, each named for the stream it predicts. Opening a model shows,
  simply and in order:
  - the streams that go in, ranked by how much each helps;
  - the model;
  - the predictions that come out, and where they go.

  It's the neuron's pipeline (extract, transform, load), told without a
  canvas. The Streams tab stays for now and may later become "streams I
  publish".
- **Words people see (owner, 2026-10-18).** People don't think about servers.
  - Central is the **Satori Service** ("Network" for short). It is free to
    submit to.
  - Nostr is the **Satori Network**, named only where detail is needed.
  - Base is the **Satori contract**. It costs gas, so people need to know it
    is separate.

  Code identifiers keep their names. Later, central may simply read the
  relays, and the Satori Service and the relays become one thing.
- **Icons over words, but only when they're instantly understood.** An icon
  stands alone only if its meaning is obvious, or if the same icon is paired
  with its word somewhere nearby (a filter, a header). If it's at all
  ambiguous, use the word.
- Healthy is green, never gray. Three shades on one scale:
  - "sky green" (lighter, softer) when all is well and the neuron is waiting,
    reached by a slow fade over minutes;
  - regular green while it works;
  - a brighter, more vivid green when it must not be closed right now.

  Gray only means off or not used.
- Never a silent wait. When the neuron is doing something significant, one
  moving indicator shows it, never several. A short status says what it is
  doing and changes step by step, slowly enough to read, so nobody waits on
  the same words for more than a few seconds.
