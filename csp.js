// The Content-Security-Policy, sent as an HTTP header on every response.
// No inline script or style; 'wasm-unsafe-eval' is for DuckDB-WASM.
// connect-src https: lets the user choose any https central URL.
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
  "connect-src 'self' https:; img-src 'self' data:; style-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
