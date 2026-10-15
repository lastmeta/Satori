#!/bin/sh
# Regenerate test/fixtures/identity-parity.json with the real satorilib, inside
# the shipped Docker image (its Python deps are the ones Docker uses). The local
# satorilib source is copied over the image's copy. docker cp instead of -v:
# the daemon cannot see this ecryptfs checkout through bind mounts.
#   sh scripts/identity_fixtures.sh            generate fixtures
#   sh scripts/identity_fixtures.sh verify     check test/fixtures/identity-js.json
set -eu
cd "$(dirname "$0")/.."
IMAGE=${IMAGE:-satorinet/satori-lite:latest}
SATORILIB=${SATORILIB:-/code/Satori/satorilib/src}
if [ "${1:-}" = verify ]; then SCRIPT=identity_crossverify.py; else SCRIPT=identity_fixtures.py; fi
CID=$(docker create --network none -e FIXTURE_IMAGE="$IMAGE" --entrypoint python "$IMAGE" -I /work/$SCRIPT)
trap 'docker rm -f "$CID" >/dev/null' EXIT
docker cp "$SATORILIB" "$CID:/satorilib"
docker cp scripts/. "$CID:/work"
docker cp test/fixtures/. "$CID:/out"
docker start -a "$CID"
if [ "$SCRIPT" = identity_fixtures.py ]; then
  docker cp "$CID:/out/identity-parity.json" test/fixtures/identity-parity.json
else
  docker cp "$CID:/out/identity-js.json" test/fixtures/identity-js.json
fi
