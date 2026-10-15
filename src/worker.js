// Neuron worker entry (dedicated, ES module). Owns everything stateful:
// keys, store, central, chain, engine, scheduler. Design: docs/design/OVERVIEW.md
self.onmessage = (e) => {
  if (e.data?.type === 'ping') self.postMessage({ type: 'pong' });
};
