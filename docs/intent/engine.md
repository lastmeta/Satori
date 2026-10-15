# Engine intent

## In a nutshell

A neuron takes in several data streams and turns them into forecasts of the
future, for more than one of them. Today a forecast is one prediction of the
next time step. The neuron broadcasts its forecasts to the network over Nostr,
and to whatever else needs them, such as the Base contract or central.

Every neuron's models are unique **for a good reason**. A neuron differs from
others by exploring what relates to what, and it keeps what works. Random
noise on top of models that are otherwise the same does not count. The models
differ in:
- the algorithm;
- the priors and hyperparameters;
- **above all, the data:** which other streams it reads.

Over time each neuron finds a niche, where it is "generally predictive most of
the time, but highly predictive in certain situations".

How the models are cut is open. There could be one per stream, or one combined
model per neuron that predicts all its streams.

## Direction now

- Start with one algorithm, multivariate. Each target reads 1–3 random
  companion streams, and the priors are randomised a little. Both improve over
  time as the neuron keeps what predicts better.
- Specs stay local. Nostr subscriptions will make a neuron's data choices
  visible later.
- Central serves observation history, so a new neuron starts with data
  instead of from nothing.
