import { defineConfig } from '@playwright/test';

// The installed app (e2e/pwa.spec.js) against a build: `npm run e2e:pwa` builds,
// then runs it against `vite preview` on :5181, which sends the CSP header
// (vite.config.js) and serves dist/ as it is on disk, so a preview already
// running serves the fresh build too. The spec launches its own Chrome.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'pwa.spec.js',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  webServer: { command: 'npm run preview', url: 'http://localhost:5181', reuseExistingServer: true },
});
