import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Dev only: DuckDB's worker is sent as the file it is (773 KB). Through Vite's
// transform it was 3.9 MB with its source map inlined, and a warning per source.
const DUCKDB_DIST = fileURLToPath(new URL('./node_modules/@duckdb/duckdb-wasm/dist/', import.meta.url));
const WORKER = /^\/node_modules\/@duckdb\/duckdb-wasm\/dist\/(duckdb-browser-(?:eh|mvp)\.worker\.js)$/; // not ?url imports
const rawDuckdbWorker = {
  name: 'raw-duckdb-worker',
  configureServer: (server) => void server.middlewares.use((req, res, next) => {
    const m = WORKER.exec(req.url ?? '');
    if (!m) return next();
    res.setHeader('Content-Type', 'text/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(DUCKDB_DIST + m[1]).on('error', next).pipe(res);
  }),
};

export default defineConfig({
  plugins: [cspHeader, rawDuckdbWorker],
  server: { host: '0.0.0.0', port: 5180, strictPort: true },
  preview: { host: '0.0.0.0', port: 5181, strictPort: true },
  // DuckDB's worker and wasm are loaded by URL (?url), never pre-bundled; its
  // apache-arrow is, else the dev page loads it as ~125 separate modules.
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'], include: ['@duckdb/duckdb-wasm > apache-arrow'] },
  test: { include: ['src/**/*.test.js'], maxWorkers: 2 },
});
