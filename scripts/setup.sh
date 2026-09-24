#!/usr/bin/env bash
# Подготовка хоста (Debian/Ubuntu) с AMD Ryzen AI к запуску платформы.
#   ./scripts/setup.sh              — только проверки и создание .env
#   ./scripts/setup.sh --install    — ещё и поставить недостающие пакеты через sudo apt
set -uo pipefail
cd "$(dirname "$0")/.."

INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; WARN=1; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
WARN=0; FAIL=0

echo "== Процессор и графика"
CPU=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)
echo "  $CPU"
GPU=$(lspci -nn 2>/dev/null | grep -iE 'vga|display' | grep -i amd | head -1 | cut -d: -f3- | xargs)
[ -n "$GPU" ] && echo "  $GPU" || warn "не найден AMD GPU в lspci"
case "$CPU" in
  *"Ryzen AI MAX"*) ok "Strix Halo (Radeon 8040S/8050S/8060S)";;
  *"Ryzen AI 9"*)   ok "Strix Point (Radeon 880M/890M)";;
  *"Ryzen AI 7"*|*"Ryzen AI 5"*) ok "Strix/Krackan Point (Radeon 840M/860M)";;
  *) warn "процессор не из линейки Ryzen AI — платформа рассчитана на неё, но может работать на любом GPU с Vulkan";;
esac

echo "== Ядро"
KV=$(uname -r)
KMAJ=$(echo "$KV" | cut -d. -f1); KMIN=$(echo "$KV" | cut -d. -f2)
if [ "$KMAJ" -gt 6 ] || { [ "$KMAJ" -eq 6 ] && [ "$KMIN" -ge 10 ]; }; then ok "ядро $KV"
else warn "ядро $KV: для RDNA 3.5 (gfx115x) нужно 6.10+, лучше 6.12+"; fi

echo "== Пакеты Vulkan / Mesa"
PKGS="mesa-vulkan-drivers libvulkan1 vulkan-tools firmware-amd-graphics"
MISSING=""
for p in $PKGS; do dpkg -s "$p" >/dev/null 2>&1 && ok "$p" || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then
  if [ $INSTALL = 1 ]; then
    sudo apt-get update && sudo apt-get install -y $MISSING || fail "не удалось поставить:$MISSING"
  else
    warn "не хватает:$MISSING  →  ./scripts/setup.sh --install  (firmware-amd-graphics — из non-free-firmware)"
  fi
fi

echo "== Docker"
if docker compose version >/dev/null 2>&1; then ok "$(docker --version | cut -d, -f1), compose $(docker compose version --short)"
else fail "нужен Docker с плагином compose"; fi
id -nG | grep -qw docker || warn "пользователь не в группе docker (команды docker потребуют sudo)"

echo "== Доступ к GPU"
RENDER_GID=$(getent group render | cut -d: -f3)
VIDEO_GID=$(getent group video | cut -d: -f3)
[ -e /dev/dri/renderD128 ] && ok "/dev/dri/renderD128" || fail "нет /dev/dri/renderD128 — драйвер amdgpu не загружен?"
[ -n "$RENDER_GID" ] && ok "группа render: GID $RENDER_GID" || fail "нет группы render"
if command -v vulkaninfo >/dev/null; then
  DEV=$(vulkaninfo --summary 2>/dev/null | grep -m1 -E 'deviceName.*RADV' | cut -d= -f2- | xargs)
  if [ -n "$DEV" ]; then ok "Vulkan: $DEV"
  else warn "Vulkan на хосте видит только llvmpipe. Контейнеру это не мешает, но для проверки: sudo usermod -aG render,video $USER и перелогиниться"; fi
fi

echo "== Память GPU (GTT)"
MEM_GB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 / 1024 ))
GTT_FILE=$(ls /sys/class/drm/card*/device/mem_info_gtt_total 2>/dev/null | head -1)
if [ -n "$GTT_FILE" ]; then
  GTT_GB=$(( $(cat "$GTT_FILE") / 1024 / 1024 / 1024 ))
  VRAM_MB=$(( $(cat "${GTT_FILE%gtt_total}vram_total") / 1024 / 1024 ))
  echo "  RAM ${MEM_GB} ГБ · UMA carve-out ${VRAM_MB} МБ · GTT ${GTT_GB} ГБ"
  REC=$(( MEM_GB * 3 / 4 ))
  if [ "$GTT_GB" -ge $(( REC - 2 )) ]; then ok "GTT достаточен"
  else
    warn "GTT ${GTT_GB} ГБ — мало для видеомоделей. Рекомендуется ~${REC} ГБ (¾ RAM). Параметр ядра:"
    echo "      amdgpu.gttsize=$(( REC * 1024 ))            (ядра до 6.x, МиБ)"
    echo "      ttm.pages_limit=$(( REC * 262144 )) ttm.page_pool_size=$(( REC * 262144 ))   (современный способ, страницы по 4 КиБ)"
    echo "      → добавить в GRUB_CMDLINE_LINUX_DEFAULT в /etc/default/grub, затем sudo update-grub и перезагрузка"
  fi
else
  warn "не удалось прочитать GTT (нет amdgpu?)"
fi

echo "== Конфигурация .env"
if [ ! -f .env ]; then cp .env.example .env; ok "создан .env из .env.example"; else ok ".env уже есть"; fi
set_env() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
[ -n "$RENDER_GID" ] && set_env RENDER_GID "$RENDER_GID"
[ -n "$VIDEO_GID" ] && set_env VIDEO_GID "$VIDEO_GID"
chmod 600 .env
DATA_PATH=$(grep -E '^DATA_PATH=' .env | cut -d= -f2-); DATA_PATH=${DATA_PATH:-./data}
mkdir -p "$DATA_PATH" && ok "каталог данных: $DATA_PATH"
MODELS_PATH=$(grep -E '^MODELS_PATH=' .env | cut -d= -f2-); MODELS_PATH=${MODELS_PATH:-./models}
mkdir -p "$MODELS_PATH" && ok "каталог моделей: $MODELS_PATH ($(df -h "$MODELS_PATH" | awk 'NR==2{print $4}') свободно)"
OUTPUT_PATH=$(grep -E '^OUTPUT_PATH=' .env | cut -d= -f2-); OUTPUT_PATH=${OUTPUT_PATH:-./output}
mkdir -p "$OUTPUT_PATH" && ok "каталог результатов: $OUTPUT_PATH"

echo
if [ $FAIL = 1 ]; then echo "Есть ошибки — исправьте их и запустите снова."; exit 1; fi
echo "Готово. Запуск:  docker compose up -d --build   →   http://$(hostname -I 2>/dev/null | awk '{print $1}'):$(grep -E '^PORT=' .env | cut -d= -f2 || echo 7860)"
echo "При первом открытии интерфейс предложит создать администратора — сделайте это сразу после запуска."
[ $WARN = 1 ] && echo "(есть предупреждения выше)"
exit 0
