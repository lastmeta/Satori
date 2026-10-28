# Network intent

## In a nutshell

Neurons talk to each other. The **Satori Service** is a decentralized
network of Nostr relays where anyone can publish a data stream and anyone
can subscribe to one (owner, 2026-10-20). Raw data and predictions are both
just data streams. To predict something, a neuron may want others'
predictions about it or about related things, so predictions are shared as
readily as raw data, through the relays, not through a central server.

The relays carry data: numbers, at cadences from about a minute to a day
(most around an hour to a day). They are not for high-frequency streaming
or for AI agents talking to each other.

Later, as local AI spreads, neurons may need to reach each other directly
(hole punching through a rendezvous, or WebRTC). That is a separate layer
from the relays.

## Direction now

- **A marketplace of data streams in the neuron.** A stream doesn't have
  to be free. Its publisher can charge a tiny amount per observation, paid
  in SATORI on Base, without gas on every payment, as the Spilman payment
  channels did on Evrmore. The best predictor of something can sell its
  predictions.
- **Everything a neuron produces is published** (owner, 2026-10-25): every
  stream it makes, predictions included (those it sends to the Satori
  Service and the Satori contract), goes to the relays unless it is private.
  Following a stream and predicting it are separate choices.
- Research the Base equivalent of payment channels first, and whether it
  belongs in the Satori contract, in a new contract, or off the shelf.
- Hold the fixes to today's relay code (found 2026-10-20) until the design
  settles, so nothing is fixed twice.
