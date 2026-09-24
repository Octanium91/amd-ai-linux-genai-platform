#!/usr/bin/env bash
# Checks that the platform container sees the iGPU through RADV and that the Vulkan heap equals GTT, not the UMA carve-out.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec platform sh -c '
  vulkaninfo --summary 2>/dev/null | grep -E "deviceName|driverName|driverInfo"
  echo "-- Vulkan memory heaps:"
  vulkaninfo 2>/dev/null | grep -A3 -E "memoryHeaps\[[0-9]\]" | grep -E "size|flags"
  echo "-- $(sd-cli --version 2>/dev/null | head -1)"
'
