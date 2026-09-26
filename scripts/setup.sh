#!/usr/bin/env bash
# Prepares a Debian/Ubuntu host with an AMD Ryzen AI APU to run the platform.
#   ./scripts/setup.sh              — checks only, plus creating .env
#   ./scripts/setup.sh --install    — also install missing packages via sudo apt
set -uo pipefail
cd "$(dirname "$0")/.."

INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; WARN=1; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
WARN=0; FAIL=0

# The platform runs as the user who will own data/, models/ and output/. Under sudo that is the
# invoking user, not root; plain root is refused (the containers would write root-owned files).
if [ "$(id -u)" = 0 ]; then
  if [ -n "${SUDO_UID:-}" ] && [ "$SUDO_UID" != 0 ]; then
    RUN_UID=$SUDO_UID; RUN_GID=$SUDO_GID; RUN_USER=$SUDO_USER
  else
    echo "Run setup.sh as the user who will run the platform (sudo is used where needed)." >&2
    exit 1
  fi
else
  RUN_UID=$(id -u); RUN_GID=$(id -g); RUN_USER=$(id -un)
fi
RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)

echo "== CPU and graphics"
CPU=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)
echo "  $CPU"
GPU=$(lspci -nn 2>/dev/null | grep -iE 'vga|display' | grep -i amd | head -1 | cut -d: -f3- | xargs)
[ -n "$GPU" ] && echo "  $GPU" || warn "no AMD GPU found in lspci"
case "$CPU" in
  *"Ryzen AI MAX"*) ok "Strix Halo (Radeon 8040S/8050S/8060S)";;
  *"Ryzen AI 9"*)   ok "Strix Point (Radeon 880M/890M)";;
  *"Ryzen AI 7"*|*"Ryzen AI 5"*) ok "Strix/Krackan Point (Radeon 840M/860M)";;
  *) warn "not a Ryzen AI CPU — the platform targets that lineup but may work on any GPU with Vulkan";;
esac

echo "== Kernel"
KV=$(uname -r)
KMAJ=$(echo "$KV" | cut -d. -f1); KMIN=$(echo "$KV" | cut -d. -f2)
if [ "$KMAJ" -gt 6 ] || { [ "$KMAJ" -eq 6 ] && [ "$KMIN" -ge 10 ]; }; then ok "kernel $KV"
else warn "kernel $KV: RDNA 3.5 (gfx115x) needs 6.10+, 6.12+ recommended"; fi

echo "== Vulkan / Mesa packages"
PKGS="mesa-vulkan-drivers libvulkan1 vulkan-tools firmware-amd-graphics"
MISSING=""
for p in $PKGS; do dpkg -s "$p" >/dev/null 2>&1 && ok "$p" || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then
  if [ $INSTALL = 1 ]; then
    sudo apt-get update && sudo apt-get install -y $MISSING || fail "could not install:$MISSING"
  else
    warn "missing:$MISSING  →  ./scripts/setup.sh --install  (firmware-amd-graphics comes from non-free-firmware)"
  fi
fi

echo "== Docker"
if docker compose version >/dev/null 2>&1; then ok "$(docker --version | cut -d, -f1), compose $(docker compose version --short)"
else fail "Docker with the compose plugin is required"; fi
id -nG | grep -qw docker || warn "user is not in the docker group (docker commands will need sudo)"

echo "== GPU access"
RENDER_GID=$(getent group render | cut -d: -f3)
VIDEO_GID=$(getent group video | cut -d: -f3)
[ -e /dev/dri/renderD128 ] && ok "/dev/dri/renderD128" || fail "no /dev/dri/renderD128 — is the amdgpu driver loaded?"
[ -n "$RENDER_GID" ] && ok "render group: GID $RENDER_GID" || fail "no render group"
if command -v vulkaninfo >/dev/null; then
  DEV=$(vulkaninfo --summary 2>/dev/null | grep -m1 -E 'deviceName.*RADV' | cut -d= -f2- | xargs)
  if [ -n "$DEV" ]; then ok "Vulkan: $DEV"
  else warn "Vulkan on the host only sees llvmpipe. The container is not affected, but to check: sudo usermod -aG render,video $RUN_USER and log in again"; fi
fi

echo "== GPU memory (GTT)"
MEM_GB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 / 1024 ))
GTT_FILE=$(ls /sys/class/drm/card*/device/mem_info_gtt_total 2>/dev/null | head -1)
if [ -n "$GTT_FILE" ]; then
  GTT_GB=$(( $(cat "$GTT_FILE") / 1024 / 1024 / 1024 ))
  VRAM_MB=$(( $(cat "${GTT_FILE%gtt_total}vram_total") / 1024 / 1024 ))
  echo "  RAM ${MEM_GB} GB · UMA carve-out ${VRAM_MB} MB · GTT ${GTT_GB} GB"
  REC=$(( MEM_GB * 3 / 4 ))
  # amdgpu keeps GTT through TTM, which by default holds at most half of the RAM resident: with a
  # larger GTT but the default TTM limit, buffers above it are swapped out and the GPU waits
  TTM_PAGES=$(cat /sys/module/ttm/parameters/pages_limit 2>/dev/null || echo 0)
  GTT_BYTES=$(cat "$GTT_FILE")
  if [ "$TTM_PAGES" -gt 0 ] && [ $(( TTM_PAGES * 4096 )) -lt $(( GTT_BYTES / 100 * 95 )) ]; then
    NEED=$(( (GTT_BYTES + 4095) / 4096 ))
    warn "the kernel (TTM) keeps at most $(( TTM_PAGES * 4096 / 1024 / 1024 / 1024 )) GB of the ${GTT_GB} GB GTT in RAM: the rest is swapped out and heavy jobs run several times slower. Add:"
    echo "      ttm.pages_limit=$NEED ttm.page_pool_size=$NEED"
    echo "      → to GRUB_CMDLINE_LINUX_DEFAULT in /etc/default/grub (next to amdgpu.gttsize), then sudo update-grub and reboot"
  fi
  if [ "$GTT_GB" -ge $(( REC - 2 )) ]; then ok "GTT is large enough"
  else
    warn "GTT is ${GTT_GB} GB — too small for video models. ~${REC} GB (¾ of RAM) is recommended. Kernel parameters (both):"
    echo "      amdgpu.gttsize=$(( REC * 1024 )) ttm.pages_limit=$(( REC * 262144 )) ttm.page_pool_size=$(( REC * 262144 ))"
    echo "      (gttsize in MiB sets the GTT size; the ttm values in 4 KiB pages let the kernel keep that much in RAM)"
    echo "      → add to GRUB_CMDLINE_LINUX_DEFAULT in /etc/default/grub, then sudo update-grub and reboot"
  fi
else
  warn "could not read GTT (no amdgpu?)"
fi

echo "== .env configuration"
if [ ! -f .env ]; then cp .env.example .env; ok "created .env from .env.example"; else ok ".env already exists"; fi
set_env() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
[ -n "$RENDER_GID" ] && set_env RENDER_GID "$RENDER_GID"
[ -n "$VIDEO_GID" ] && set_env VIDEO_GID "$VIDEO_GID"
set_env PUID "$RUN_UID"
HOST_TZ=$(timedatectl show -p Timezone --value 2>/dev/null || true)
[ -n "$HOST_TZ" ] || HOST_TZ=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')
[ -n "$HOST_TZ" ] && set_env TZ "$HOST_TZ" && ok "time zone: $HOST_TZ"
set_env PGID "$RUN_GID"
ok "the containers run as $RUN_USER (PUID $RUN_UID, PGID $RUN_GID)"
chmod 600 .env
[ "$(id -u)" = 0 ] && chown "$RUN_UID:$RUN_GID" .env
# Read a path from .env the way docker compose does: without quotes, with ~ expanded
env_path() {
  local v
  v=$(grep -E "^$1=" .env | tail -1 | cut -d= -f2-)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  case "$v" in "~"|"~/"*) v="$RUN_HOME${v#\~}";; esac
  echo "${v:-$2}"
}
DATA_PATH=$(env_path DATA_PATH ./data)
MODELS_PATH=$(env_path MODELS_PATH ./models)
OUTPUT_PATH=$(env_path OUTPUT_PATH ./output)
mkdir -p "$DATA_PATH" && ok "data directory: $DATA_PATH"
mkdir -p "$MODELS_PATH" && ok "models directory: $MODELS_PATH ($(df -h "$MODELS_PATH" | awk 'NR==2{print $4}') free)"
mkdir -p "$OUTPUT_PATH" && ok "output directory: $OUTPUT_PATH"
# Mount points of the models/output volumes inside DATA_PATH; otherwise Docker creates them as root
mkdir -p "$DATA_PATH/models" "$DATA_PATH/output"

# Files left by an older root-running container (or copied with sudo) must belong to the host user
FOREIGN=$(find "$DATA_PATH" "$MODELS_PATH" "$OUTPUT_PATH" ! -user "$RUN_UID" 2>/dev/null | head -1)
if [ -n "$FOREIGN" ]; then
  if [ $INSTALL = 1 ] || [ "$(id -u)" = 0 ]; then
    sudo chown -R "$RUN_UID:$RUN_GID" "$DATA_PATH" "$MODELS_PATH" "$OUTPUT_PATH" && ok "ownership of data/models/output fixed"
  else
    warn "some files are not owned by $RUN_USER (e.g. $FOREIGN) → ./scripts/setup.sh --install, or: sudo chown -R $RUN_UID:$RUN_GID \"$DATA_PATH\" \"$MODELS_PATH\" \"$OUTPUT_PATH\""
  fi
fi

echo
if [ $FAIL = 1 ]; then echo "There are errors — fix them and run again."; exit 1; fi
echo "Done. First start:  docker compose up -d --build   (later updates: ./scripts/update.sh)"
echo "  UI:  http://$(hostname -I 2>/dev/null | awk '{print $1}'):$(grep -E '^PORT=' .env | cut -d= -f2 || echo 7860)"
echo "On first open the web UI offers to create the administrator — do it right after the start."
[ $WARN = 1 ] && echo "(see the warnings above)"
exit 0
