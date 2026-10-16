import { defineConfig } from '@playwright/test';

// The deploy image (e2e/deploy.spec.js; docs/design/deploy.md) at DEPLOY_URL,
// default http://localhost:8090. No webServer: start the image first
// (`docker run --rm -p 8090:80 satori-neuron`). The spec launches its own Chrome.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'deploy.spec.js',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  use: { channel: 'chrome', headless: true },
});
