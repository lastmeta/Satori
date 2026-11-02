#!/usr/bin/env bash
# Publish explain/index.html to https://explain.satorinet.io.
#
#   ./explain/deploy.sh
#
# Central's satori-explain container (nginx:alpine) serves /root/satori-explain/site
# read-only, so a deploy is a file copy: no build, no restart. The script then checks
# that the live page is byte-for-byte the file in this repo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOST=root@157.180.104.175
PORT=2222
KEY="${SATORI_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

scp -q "${SSH_OPTS[@]}" -P "$PORT" "$HERE/index.html" "$HOST:/root/satori-explain/site/index.html.new"
ssh "${SSH_OPTS[@]}" -p "$PORT" "$HOST" \
  'mv /root/satori-explain/site/index.html.new /root/satori-explain/site/index.html && chmod 644 /root/satori-explain/site/index.html'

if curl -fsS "https://explain.satorinet.io/?v=$(date +%s)" | cmp -s - "$HERE/index.html"; then
  echo "explain.satorinet.io is serving this explain/index.html"
else
  echo "explain.satorinet.io does not match explain/index.html" >&2
  exit 1
fi
