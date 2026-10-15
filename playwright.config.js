import { defineConfig } from '@playwright/test';

// Uses the system Google Chrome (channel 'chrome'): no Playwright-managed
// Chromium is installed on this box. Runs against the dev server on :5180,
// which sends the production CSP header (vite.config.js).
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://localhost:5180', channel: 'chrome', headless: true },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5180',
    reuseExistingServer: true,
  },
});
