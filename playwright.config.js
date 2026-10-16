import { defineConfig } from '@playwright/test';

// Uses the system Google Chrome (channel 'chrome'): no Playwright-managed
// Chromium is installed on this box. Runs against the dev server on :5180,
// which sends the CSP header (vite.config.js), and two in-memory test relays
// on :7781 and :7782 for e2e/nostr.spec.js (not the dev relay on :7778).
export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['pwa.spec.js', 'deploy.spec.js'], // a build's (npm run e2e:pwa) and the deploy image's (npm run e2e:deploy)
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  use: { baseURL: 'http://localhost:5180', channel: 'chrome', headless: true },
  webServer: [
    { command: 'npm run dev', url: 'http://localhost:5180', reuseExistingServer: true },
    { command: 'node scripts/test-relay.mjs 7781 7782', port: 7782, reuseExistingServer: true },
  ],
});
