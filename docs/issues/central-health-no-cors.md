# /health has no CORS header

**Status:** open · **Kind:** fixable, minor · **Fix in:** central nginx

nginx answers `/health` itself with `healthy\n` and no
`Access-Control-Allow-Origin` (`central/nginx.conf:58-62,142-146`; verified
live 2026-10-14), so FastAPI's CORS-enabled `/health` (`central/src/main.py:227-233`)
is never reached. A browser cannot read it.

Fix: `add_header Access-Control-Allow-Origin * always;` on that location, or
proxy it to FastAPI. The browser app uses `GET /` meanwhile, so this is not
blocking.
