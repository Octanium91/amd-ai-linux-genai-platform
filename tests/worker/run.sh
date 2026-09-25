#!/usr/bin/env bash
# Runs the worker queue regression test without a GPU: the worker code from server/src runs in a
# throwaway container of the worker image, with a fake sd-cli and a tmpfs data directory.
# Nothing of a running deployment is touched.
#   ./tests/worker/run.sh            (needs the image: docker compose build worker)
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -r server/src/common server/src/worker "$tmp/"
echo '{"type":"module"}' > "$tmp/package.json"
mkdir -p "$tmp/bin" && cp tests/worker/fake-ffmpeg "$tmp/bin/ffmpeg" && chmod +x "$tmp/bin/ffmpeg" tests/worker/fake-sd-cli
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp --tmpfs "/data:uid=$(id -u),gid=$(id -g)" \
  -v "$tmp":/src:ro -v "$tmp/bin":/fake/bin:ro -v "$PWD/tests/worker/fake-sd-cli":/fake/sd-cli:ro \
  -v "$PWD/tests/worker/driver.mjs":/driver.mjs:ro \
  --entrypoint node genai-platform-worker:latest /driver.mjs
