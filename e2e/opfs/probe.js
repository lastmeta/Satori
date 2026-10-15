// Page side of the OPFS probe: one request/response at a time to the worker.
window.violations = [];
document.addEventListener('securitypolicyviolation', (e) =>
  window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
window.probe = (msg) =>
  new Promise((resolve) => {
    worker.onmessage = (e) => {
      window.violations.push(...(e.data.violations ?? []));
      resolve(e.data);
    };
    worker.postMessage(msg);
  });
