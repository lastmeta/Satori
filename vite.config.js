import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { CSP } from './csp.js';
import { defaultsFrom, DEV_DEFAULTS, BUILD_DEFAULTS } from './src/config.js';

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

// Builds only: dist/sw.js, the service worker (src/pwa/sw.js; docs/design/pwa.md), with the files it
// precaches: the page and every hashed asset but DuckDB's mvp bundle (for browsers without wasm
// exceptions, fetched only there). Its cache is named after the files and the page, so a build that
// changes either is a new worker, which waits for the page's "Update ready, reload".
const serviceWorker = {
  name: 'service-worker',
  apply: 'build',
  enforce: 'post', // after the page (index.html) is in the bundle
  generateBundle(_, bundle) {
    const files = ['/', ...Object.keys(bundle).filter((f) => f.startsWith('assets/') && !f.includes('-mvp')).sort().map((f) => `/${f}`)];
    const name = `satori-${createHash('sha256').update(files.join() + bundle['index.html'].source).digest('hex').slice(0, 12)}`;
    const code = readFileSync(new URL('./src/pwa/sw.js', import.meta.url), 'utf8').replace(/^export /gm, '');
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: `${code}\nstart(self, ${JSON.stringify(files)}, '${name}');\n` });
  },
};

const config = {
  plugins: [cspHeader, rawDuckdbWorker, serviceWorker],
  // /rpc: the dev server's default Base RPC, a local anvil fork of Base Sepolia (node scripts/fork.mjs start),
  // on the page's own origin, which the CSP allows ('self'); a build has no proxy and no such default.
  server: {
    host: '0.0.0.0', port: 5180, strictPort: true,
    proxy: { '/rpc': { target: 'http://127.0.0.1:8545', changeOrigin: true, rewrite: () => '/' } },
  },
  preview: { host: '0.0.0.0', port: 5181, strictPort: true },
  // DuckDB's worker and wasm are loaded by URL (?url), never pre-bundled; its
  // apache-arrow is, else the dev page loads it as ~125 separate modules.
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'], include: ['@duckdb/duckdb-wasm > apache-arrow'] },
  test: { include: ['src/**/*.test.js'], maxWorkers: 2 },
};

export default defineConfig(({ command, mode }) => {
  // The VITE_* defaults (src/config.js, docs/design/deploy.md): a bad one stops here, not in the bundle.
  defaultsFrom(loadEnv(mode, process.cwd(), 'VITE_'), command === 'serve' ? DEV_DEFAULTS : BUILD_DEFAULTS);
  return config;
});
