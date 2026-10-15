// e2e (app.spec.js): a service worker left on the dev origin, which the dev app unregisters.
self.addEventListener('fetch', () => {});
