import { defineConfig } from 'vite';
import { CSP } from './csp.js';

// Sends the CSP header on every dev/preview response, 304s included
// (Vite's `server.headers` option skips 304 revalidations).
const csp = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  next();
};
const cspHeader = {
  name: 'csp-header',
  configureServer: (server) => void server.middlewares.use(csp),
  configurePreviewServer: (server) => void server.middlewares.use(csp),
};

export default defineConfig({
  plugins: [cspHeader],
  server: { host: '0.0.0.0', port: 5180, strictPort: true },
  preview: { host: '0.0.0.0', port: 5181, strictPort: true },
  // DuckDB's worker and wasm are loaded by URL (?url), never pre-bundled.
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  test: { include: ['src/**/*.test.js'], maxWorkers: 2 },
});
