#!/usr/bin/env bash
# Updates the platform without interrupting a running generation:
#   - builds both images;
#   - restarts the web container at once (UI, API: generation is not affected);
#   - restarts the worker only if its image or settings changed, and only after the current job:
#     the worker is drained (finishes the job, starts nothing new), queued jobs wait and continue
#     on the new worker.
#   ./scripts/update.sh           update from the working copy
#   ./scripts/update.sh --pull    git pull first
# Interrupting the script (Ctrl+C, closed SSH session) releases the drain; the old worker carries on.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "${1:-}" = "--pull" ] && git pull --ff-only
DATA_PATH=$(grep -E '^DATA_PATH=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
DATA_PATH=${DATA_PATH%\"}; DATA_PATH=${DATA_PATH#\"}; DATA_PATH=${DATA_PATH%\'}; DATA_PATH=${DATA_PATH#\'}
case "$DATA_PATH" in "~"|"~/"*) DATA_PATH="$HOME${DATA_PATH#\~}";; esac
DATA_PATH=${DATA_PATH:-./data}

echo "== Building images"
docker compose build

# One-time migration from the single-container version (container genai-platform)
if docker container inspect genai-platform >/dev/null 2>&1; then
  echo "== Migrating from the single-container version: waiting until no job is running or queued"
  while grep -qE '"status": *"(running|queued)"' "$DATA_PATH/state/jobs.json" 2>/dev/null; do
    printf '.'; sleep 30
  done
  echo
  docker rm -f genai-platform >/dev/null
  docker compose up -d --remove-orphans
  exit 0
fi

echo "== web"
docker compose up -d --no-deps web

echo "== worker"
if [ "$(docker inspect -f '{{.State.Running}}' genai-worker 2>/dev/null || echo false)" != true ]; then
  docker compose up -d --no-deps worker
  exit 0
fi
# Ask compose itself whether it would recreate the worker (new image or changed settings).
# Comparing image IDs by hand is unreliable: with the containerd image store a container and its
# image report different digests for the same image.
# (Captured first: grep -q in a pipe would cut compose off with SIGPIPE, and pipefail would fail it.)
if ! plan=$(docker compose up -d --no-deps --dry-run worker 2>&1); then
  echo "$plan"
  echo "  could not check the worker (docker compose with --dry-run is required); it was NOT updated" >&2
  exit 1
fi
if ! grep -q Recreate <<<"$plan"; then
  echo "  unchanged, not restarted"
  exit 0
fi

ctl() { docker exec genai-worker node src/worker/ctl.js "$@"; }
release() { ctl drain 0 >/dev/null 2>&1 || true; }
trap 'release; echo; echo "Interrupted: the worker keeps running the old version, the queue continues"; exit 130' INT TERM HUP

# The drain is a lease: renewed on every poll, it expires by itself if this script dies
first=1
fails=0
while :; do
  if ! status=$(ctl drain 120 2>&1); then
    # A transient docker exec / network hiccup is retried; a persistent one stops the update
    fails=$((fails + 1))
    if [ $fails -ge 4 ]; then
      release
      echo; echo "  the worker does not answer ($status); it was NOT updated" >&2
      exit 1
    fi
    sleep 5; continue
  fi
  fails=0
  [ "$(echo "$status" | grep -o '"busy":[a-z]*' | cut -d: -f2)" = false ] && break
  if [ $first = 1 ]; then
    echo "  a job is running: the worker restarts after it, new jobs wait in the queue"
    first=0
  fi
  printf '.'; sleep 15
done
[ $first = 1 ] || echo
trap - INT TERM HUP
docker compose up -d --no-deps worker
echo "  restarted"
