// Main thread entry: UI only. Spawns the neuron worker. Design: docs/design/ui.md
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  if (e.data?.type === 'pong') document.body.dataset.worker = 'ready';
};
worker.postMessage({ type: 'ping' });
