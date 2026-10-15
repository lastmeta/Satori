# Engine intent

The owner's intent for the engine (2026-10-15). Quotes are the owner's words,
lightly cleaned up from dictation. [../design/engine.md](../design/engine.md)
describes what is built; this file says what it is for.

## The ultimate goal

> "We want every neuron to make predictions about data streams using models
> that they build and improve over time. But we want those models to be
> unique."

"Model" is meant broadly: any method of making a prediction counts. Each
neuron builds several models, at least one per data stream it predicts.

Models should differ along three axes:

1. **The algorithm** used to make the model.
2. **The hyperparameters or priors** given to that algorithm.
3. **The data used to make the prediction.** This is the most important axis.
   > "If I want to predict … the price of gold … of course I'm going to consume
   > the price of gold. The jobs numbers, the weather … I might consume other
   > data streams along with my primary data stream and make a model given all
   > of it."

## Unique for a good reason

> "I want them to be unique for a good reason, not because they just have a
> random element that we add in on top, but they're all basically the same
> underneath."

Neurons should differ because each is **exploring** a different part of the
space: what relates to what, which priors or assumptions to hold, and which
ways of building a model to use. Each keeps what works.

As neurons evolve, each tries to capture a **niche**. It should be "generally
predictive most of the time, but highly predictive … in certain situations, in
certain domains", or "when the outside world looks a certain way". The owner's
example is a neuron that reads the price of gold against the weather and knows
when gold suppliers will have a hard time.

## The first step (MVP)

> "The most basic way to achieve our goal is we can still stick with one
> algorithm, but it needs to be an algorithm that somehow can ingest more than
> one data stream. If it's multivariate then we can start correlating data
> streams with each other."

This continues the `namaste_club` experiments. There, a neuron consumes an
arbitrary number of streams and looks for relationships between them. That
search should not be deterministic: it starts somewhat random, then as it
trains it tries to improve, by choosing better hyperparameters and better
streams.

The minimum wanted now:

- **Randomise the priors a little.**
- **Make it multivariate.** Each model reads its target stream plus a random
  set of companion streams. For example, a neuron predicting 10 streams makes
  10 models, each reading its target and two random others.

Decided with the owner:

- The number of companions is random (1–3).
- Specs are kept locally. They need not be published to central. Everything
  will eventually go through Nostr, where a neuron's subscriptions, and so
  its data choices, are visible to all.
- Central gets an observations-history endpoint (on the `base-upgrade`
  branch, deployed to dev central first), so a new neuron can learn from
  history instead of starting from nothing.

## Direction

> "This engine has to evolve in a big way over time, but we are concerned with
> the very most basic improvement right now."

The work is iterative: start simple, then improve and change it over time.
The longer path widens each axis in turn:

- more and stranger companion data, such as Nostr streams and outside data;
- more algorithms;
- smarter search over the three axes;
- recognising the situations in which a model is strong.
