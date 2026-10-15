# Mundo sends no CORS headers

**Status:** open · **Fix in:** Mundo · **Matters for:** EVR-less SATORIEVR sends and channel claims (later)

The Docker neuron uses Mundo for fee-sponsored Evrmore transactions:
`GET /simple_partial/request/{network}` and
`POST /simple_partial/broadcast/...?signOnly=true` (`neuron/web/routes.py:25,56-80`;
server `Mundo/satorimundo/mundo/app.py:250,291`). Mundo has no CORS config and,
probed 2026-10-14, returns no `Access-Control-Allow-Origin` on GET or OPTIONS.

Both calls are CORS "simple" requests (GET; POST with `text/plain`), so no
preflight handling is needed. Fix: add `Access-Control-Allow-Origin` to those
two routes (flask-cors) or in Mundo's Caddyfile.
