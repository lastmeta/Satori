// The Content-Security-Policy from docs/design/ui.md#security, sent as an HTTP
// header on every response (HTML and worker scripts). test/csp.test.js keeps
// this string equal to the doc.
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
  "connect-src 'self' https: ; img-src 'self' data:; style-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
