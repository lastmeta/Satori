// The Content-Security-Policy, sent as an HTTP header on every response.
// No inline script or style; 'wasm-unsafe-eval' is for DuckDB-WASM.
// connect-src: https: for any https central URL and Base RPC; wss: for Nostr relays.
// form-action 'none': every form is handled in script, so none is ever submitted natively (a passphrase in a URL).
// CSP is a build's (the deploy image, `vite preview`): an https page can't open ws:// anyway (mixed content), and ws:
// would only add ws://localhost services. DEV_CSP, the dev server's (plain http), adds ws: for the ws://localhost:7778
// test relay (docs/design/nostr.md).
const policy = (ws) =>
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
  `connect-src 'self' https: wss:${ws ? ' ws:' : ''}; img-src 'self' data:; style-src 'self'; ` +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export const CSP = policy(false);
export const DEV_CSP = policy(true);
