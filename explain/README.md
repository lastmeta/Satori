# explain.satorinet.io

The Satori ecosystem overview: one static page, `index.html`, for people new to Satori.
It carries its own CSS, diagrams (inline SVG) and the Satori mark; only its fonts load
from Google Fonts.

**Deploy:** edit `index.html`, then run `./explain/deploy.sh` from the repo root. It
copies the file to Central and checks the live page matches.

## How it is served

On Central (157.180.104.175):

- `satori-explain`: an `nginx:alpine` container on `central-lite_default`, serving
  `/root/satori-explain/site` read-only. Recreate it with:

  ```sh
  docker run -d --name satori-explain --network central-lite_default --restart unless-stopped \
    -v /root/satori-explain/site:/usr/share/nginx/html:ro nginx:alpine
  ```

- `nginx-proxy` routes the name to it: the two server blocks in
  `explain.satorinet.io.nginx.conf`, inside the `http` block of `/root/nginx/nginx.conf`.
  Back that file up and run `docker exec nginx-proxy nginx -t` before any reload.
- TLS: certbot, webroot `/var/www/certbot`, certificate `explain.satorinet.io`;
  it renews with the others and the deploy hook reloads nginx.
- DNS: Cloudflare A record `explain.satorinet.io` → 157.180.104.175, not proxied, like
  the other names on Central.
