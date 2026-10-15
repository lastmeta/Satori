// The Content-Security-Policy, sent as an HTTP header on every response.
// No inline script or style; 'wasm-unsafe-eval' is for DuckDB-WASM.
// connect-src: https: for any https central URL; wss: for Nostr relays; ws:
// for ws:// relays, which only a plain-http page (the dev server) can open:
// an https page blocks ws:// as mixed content whatever the CSP says.
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
  "connect-src 'self' https: wss: ws:; img-src 'self' data:; style-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
