#!/usr/bin/env bash
# Проверяет, что контейнер платформы видит iGPU через RADV и что Vulkan-куча равна GTT, а не UMA carve-out.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec platform sh -c '
  vulkaninfo --summary 2>/dev/null | grep -E "deviceName|driverName|driverInfo"
  echo "-- Vulkan memory heaps:"
  vulkaninfo 2>/dev/null | grep -A3 -E "memoryHeaps\[[0-9]\]" | grep -E "size|flags"
  echo "-- $(sd-cli --version 2>/dev/null | head -1)"
'
