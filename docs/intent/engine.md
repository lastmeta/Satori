# Engine intent

## In a nutshell

A neuron takes in several data streams and turns them into forecasts of the
future, for more than one of them. A forecast predicts a stream one cadence
ahead. The default cadence is a day, which is what central and the Base
contract score. The neuron broadcasts its forecasts to the network over Nostr,
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

A neuron tries to make the best predictions it can.
- **It reads more than it predicts.** It can consume a stream only because
  the stream helps it predict others.
- **It only predicts where it can do well.** It doesn't have to predict, or
  broadcast, every stream it sees.

**Automatic first, user control second.** The neuron runs on its own. It looks
for new streams, evaluates them, drops the ones that don't help, and keeps
cycling. A user, or the user's agent, can still take full control by pinning
a stream to:
- always consume it;
- use it for predicting a particular stream;
- predict it.

## Direction now

- Never rest with work pending. If anything is untrained or unscored, the
  neuron does it now, picking up where it left off when the app opens. It
  doesn't wait for the next poll.

- Focus on the streams that pay: those from central, and those from the Base
  contract (relayed over Nostr). That is why people run a neuron. Other Nostr
  streams, which may or may not carry a reward, come later.
- For the MVP the neuron predicts everything it sees. Stream roles and user or
  agent pins wait.

- Start with one algorithm, multivariate. Each target reads 1–3 random
  companion streams, and the priors are randomised a little. Both improve over
  time as the neuron keeps what predicts better.
- Specs stay local. Nostr subscriptions will make a neuron's data choices
  visible later.
- Central serves observation history, so a new neuron starts with data
  instead of from nothing.
