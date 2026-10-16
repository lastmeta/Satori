# The browser neuron as a static site behind central's nginx-proxy
# (docs/design/deploy.md). Build it with scripts/deploy-image.sh: it builds
# dist/ with this deployment's defaults (deploy/build.env) and passes the CSP
# from csp.js, the one source of the header:
#   docker build -f deploy/Dockerfile --build-arg CSP="…" -t satori-neuron .
# nginx 1.30.5 (stable), alpine 3.24, built 2026-09-23; the digest is the tag's index.
FROM nginx:1.30.5-alpine3.24@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94

ARG CSP
RUN test -n "$CSP" || { echo 'CSP is not set: build with scripts/deploy-image.sh' >&2; exit 1; } \
 && printf 'add_header Content-Security-Policy "%s" always;\n' "$CSP" > /etc/nginx/csp.conf \
 && rm -rf /usr/share/nginx/html/*

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/

# A gzipped copy beside each text and wasm file, served by gzip_static (nginx.conf).
RUN find /usr/share/nginx/html -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.wasm' \
      -o -name '*.txt' -o -name '*.webmanifest' \) -exec gzip -9 -k {} + \
 && nginx -t

EXPOSE 80
