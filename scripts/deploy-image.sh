#!/usr/bin/env bash
# Builds the deploy image (docs/design/deploy.md):
#   1. npm ci, if node_modules is missing or older than package-lock.json;
#   2. dist/ with this deployment's defaults (deploy/build.env; a variable already
#      set in the environment wins), checked for them;
#   3. satori-neuron:<git short sha> (…-dirty with uncommitted changes), also :latest,
#      with the CSP from csp.js;
#   4. checks the image: nginx -t, its CSP line, and the defaults in its bundle.
# Exits 2 when docker is not reachable (dist/ is then built and checked, no image).
set -euo pipefail
cd "$(dirname "$0")/.."

# 1.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi

# 2.
while IFS='=' read -r key value; do
  case "$key" in VITE_*) [ -n "${!key+set}" ] || export "$key=$value" ;; esac
done < deploy/build.env
{ env | grep '^VITE_' || true; } | sort | sed 's/^/build: /'
npm run build

# Each set default, as it must appear in the bundle: the central URL and each relay.
expected=()
[ -z "${VITE_CENTRAL_URL:-}" ] || expected+=("${VITE_CENTRAL_URL%/}")
IFS=',' read -ra relays <<< "${VITE_NOSTR_RELAYS:-}"
for r in "${relays[@]}"; do r="${r// /}"; [ -z "$r" ] || expected+=("$r"); done
[ -z "${VITE_BASE_RPC:-}" ] || expected+=("$VITE_BASE_RPC")
for s in "${expected[@]}"; do
  grep -qF "$s" dist/assets/*.js || { echo "dist/: the bundle lacks $s" >&2; exit 1; }
  echo "dist/: the bundle has $s"
done

# 3.
TAG=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || TAG="$TAG-dirty"
IMAGE="satori-neuron:$TAG"
if ! docker info > /dev/null 2>&1; then
  echo "docker is not reachable (DOCKER_HOST=${DOCKER_HOST:-unset}): dist/ is built and checked; $IMAGE not built" >&2
  exit 2
fi
CSP=$(node --input-type=module -e "import { CSP } from './csp.js'; process.stdout.write(CSP)")
case "$CSP" in *'"'* | *'$'* | *'\'*) echo 'csp.js: an nginx string cannot hold " $ or \' >&2; exit 1 ;; esac
docker build -f deploy/Dockerfile --build-arg CSP="$CSP" -t "$IMAGE" -t satori-neuron:latest .

# 4.
docker run --rm --entrypoint sh "$IMAGE" -c 'nginx -t -q' || { echo "$IMAGE: nginx -t failed" >&2; exit 1; }
want="add_header Content-Security-Policy \"$CSP\" always;"
[ "$(docker run --rm --entrypoint cat "$IMAGE" /etc/nginx/csp.conf)" = "$want" ] \
  || { echo "$IMAGE: /etc/nginx/csp.conf is not csp.js's CSP" >&2; exit 1; }
for s in "${expected[@]}"; do
  docker run --rm --entrypoint sh "$IMAGE" -c 'grep -lF "$1" /usr/share/nginx/html/assets/*.js' sh "$s" > /dev/null \
    || { echo "$IMAGE: the bundle lacks $s" >&2; exit 1; }
  echo "$IMAGE: the bundle has $s"
done
echo "$IMAGE (also satori-neuron:latest): $(docker image inspect -f '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1 / 1e6}')"
echo "try it: docker run --rm -p 8090:80 $IMAGE   then   DEPLOY_URL=http://localhost:8090 npm run e2e:deploy"
