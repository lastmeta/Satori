#!/usr/bin/env bash
# Deploy the app to https://app.satorinet.io (docs/design/deploy.md "Deploying"), from a clean checkout:
#
#   ./scripts/deploy.sh
#
# 1. dist/ built and checked by deploy-image.sh (its exit 2, no local docker, is the usual case);
# 2. the build context shipped to central and satori-neuron:<git short sha> (also :latest) built
#    there with csp.js's CSP: the build only copies files, no npm next to the production database;
# 3. the satori-neuron container replaced (nginx-proxy resolves it per request: no reload);
# 4. all but the last 8 <sha> and test-<sha> images removed: each is about 140 MB, and before this
#    step 249 had filled 30 GB of central's disk (2026-11-08). A running image is refused, so stays;
# 5. checks app.satorinet.io serves this dist/index.html and network.satorinet.io still answers,
#    then prints the undo (the previous image).
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=root@157.180.104.175
PORT=2222
KEY="${SATORI_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
S() { ssh "${SSH_OPTS[@]}" -p "$PORT" "$HOST" "$@"; }

# The image is named by the commit, so only committed work is deployed.
[ -z "$(git status --porcelain)" ] || { git status --short >&2; echo "deploy.sh: commit first" >&2; exit 1; }
SHA=$(git rev-parse --short HEAD)

# 1.
./scripts/deploy-image.sh || [ $? -eq 2 ]

# 2.
CSP=$(node --input-type=module -e "import { CSP } from './csp.js'; process.stdout.write(CSP)")
case "$CSP" in *'"'* | *'$'* | *'\'*) echo 'csp.js: an nginx string cannot hold " $ or \' >&2; exit 1 ;; esac
CTX=$(mktemp)
tar -czf "$CTX" dist deploy/Dockerfile deploy/nginx.conf
S 'mkdir -p /root/satori-neuron/ctx && rm -rf /root/satori-neuron/ctx/*'
scp -q "${SSH_OPTS[@]}" -P "$PORT" "$CTX" "$HOST:/root/satori-neuron/ctx.tgz"
rm -f "$CTX"
S "cd /root/satori-neuron/ctx && tar -xzf ../ctx.tgz && docker build -q -f deploy/Dockerfile --build-arg CSP=\"$CSP\" -t satori-neuron:$SHA -t satori-neuron:latest . >/dev/null"

# 3.
OLD=$(S "docker inspect -f '{{.Config.Image}}' satori-neuron 2>/dev/null || true")
RUN="docker run -d --name satori-neuron --network central-lite_default --restart unless-stopped"
S "docker rm -f satori-neuron >/dev/null 2>&1; $RUN satori-neuron:$SHA >/dev/null"
UNDO="ssh -i $KEY -p $PORT $HOST 'docker rm -f satori-neuron; $RUN ${OLD:-satori-neuron:<previous sha>}'"

# 4.
S 'docker images satori-neuron --format "{{.Repository}}:{{.Tag}}" | grep -E ":(test-)?[0-9a-f]{7}$" | tail -n +9 | xargs -r docker rmi >/dev/null 2>&1 || true'

# 5.
live=
for _ in $(seq 15); do
  if curl -fsS "https://app.satorinet.io/?v=$(date +%s)" 2>/dev/null | cmp -s - dist/index.html; then live=1; break; fi
  sleep 1
done
[ -n "$live" ] || { echo "app.satorinet.io does not serve this dist/index.html; undo: $UNDO" >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' https://network.satorinet.io/)
[ "$code" = 200 ] || { echo "network.satorinet.io answered $code; undo: $UNDO" >&2; exit 1; }
echo "app.satorinet.io serves satori-neuron:$SHA (was ${OLD:-none}); network.satorinet.io 200"
echo "central disk: $(S "df -h / | tail -1 | awk '{print \$5\" used, \"\$4\" free\"}'")"
echo "undo: $UNDO"
