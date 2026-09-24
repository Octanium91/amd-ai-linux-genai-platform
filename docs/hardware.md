# Железо: Ryzen AI под Linux

## Линейка Ryzen AI

Платформа ориентирована на APU AMD с архитектурой **Zen 5 + RDNA 3.5 + XDNA 2**. Встроенная графика не имеет своей памяти: ей выделяется часть общей оперативной памяти (UMA/GTT). Поэтому объём RAM и её пропускная способность определяют, какие модели влезут и как быстро они будут работать.

| Семейство | Процессоры (примеры) | iGPU | CU | Память | Чего ждать |
|---|---|---|---|---|---|
| **Strix Halo** | Ryzen AI MAX+ 395, MAX 390/385 | Radeon 8060S / 8050S | 40 / 32 | до 128 ГБ, 256-бит LPDDR5X | Wan 2.2 5B реально использовать, AnimateLCM — быстро |
| **Strix Point** | Ryzen AI 9 HX 370, 365 | Radeon 890M / 880M | 16 / 12 | до 96 ГБ, 128-бит LPDDR5X/DDR5 | AnimateLCM и изображения — комфортно, Wan — часами |
| **Krackan Point** | Ryzen AI 7 350, Ryzen AI 5 340 | Radeon 860M / 840M | 8 / 4 | 128-бит | изображения и короткие AnimateLCM-ролики, медленнее Strix Point |

Число CU и шина памяти — по данным AMD и обзоров ([TechPowerUp](https://www.techpowerup.com/324874/amd-details-the-radeon-890m-rdna-3-5-igpu-of-strix-point-a-bit-more), [Tom's Hardware](https://www.tomshardware.com/pc-components/cpus/amd-unwraps-ryzen-ai-300-series-strix-point-processors-50-tops-of-ai-performance-zen-5c-density-cores-come-to-ryzen-9-for-the-first-time)). Точные характеристики конкретной модели смотрите на [amd.com](https://www.amd.com/en/products/processors/laptop/ryzen.html). Оценки «чего ждать» экстраполированы по числу CU и пропускной способности памяти; замерена только Strix Point (см. [benchmarks.md](benchmarks.md)).

Вся линейка — RDNA 3.5 (gfx1150/gfx1151/gfx1152), в Mesa RADV она поддерживается с версии 24.x. Для iGPU нужно ядро **6.10+**, лучше **6.12+**.

## Тестовая машина

| | |
|---|---|
| Модель | Sapphire EDGE AI 370 (мини-ПК) |
| Процессор | AMD Ryzen AI 9 HX 370 (4× Zen 5 + 8× Zen 5c, 24 потока) |
| iGPU | Radeon 890M (RDNA 3.5, 16 CU, gfx1150), в Vulkan — `AMD Radeon Graphics (RADV GFX1150)` |
| NPU | XDNA 2 (`1022:17f0`), не используется, см. ниже |
| Память | 32 ГБ LPDDR5X, общая с GPU |
| BIOS | UMA Frame Buffer = 512 МБ (минимум; остальное GPU берёт динамически через GTT) |
| Ядро | Debian 13 `6.12.x`, параметр `amdgpu.gttsize=24576` → GTT 24 ГБ |
| Mesa | 25.0.7 (RADV), `mesa-vulkan-drivers` из Debian 13 |
| Диск | NVMe 4 ТБ (модели и результаты) |

## Память: UMA, GTT и куча Vulkan {#память-gtt}

У APU два пула памяти для GPU:

- **UMA carve-out** (в BIOS: UMA Frame Buffer / iGPU Memory) — жёстко отрезанный кусок RAM, «VRAM». На тестовой машине 512 МБ.
- **GTT** — динамически выделяемая системная память, доступная GPU. Именно она нужна для моделей.

Два обязательных шага:

1. **Увеличить GTT.** По умолчанию ядро даёт GPU около половины RAM. Рекомендуем ~¾ RAM (для 32 ГБ — 24 ГБ; для 64 ГБ — ~48 ГБ; для 128 ГБ — ~96 ГБ). Параметр ядра в `/etc/default/grub` → `GRUB_CMDLINE_LINUX_DEFAULT`:
   ```
   amdgpu.gttsize=24576                                  # МиБ; работает на 6.12 (на новых ядрах помечен устаревшим)
   ttm.pages_limit=6291456 ttm.page_pool_size=6291456     # современный способ: страницы по 4 КиБ (24 ГБ = 6291456)
   ```
   Затем `sudo update-grub` и перезагрузка. Проверка: `cat /sys/class/drm/card*/device/mem_info_gtt_total`. `scripts/setup.sh` сам посчитает значения под вашу RAM.
2. **Объединить кучи Vulkan.** RADV на APU по умолчанию показывает маленькую DEVICE_LOCAL-кучу (≈ UMA) и отдельно часть GTT. Опция Mesa `radv_enable_unified_heap_on_apu=true` делает одну DEVICE_LOCAL-кучу размером с GTT. В платформе она включена и через переменную окружения, и через `config/drirc`. Проверка: `./scripts/check-gpu.sh` — на тестовой машине куча `24.50 GiB`, а не 512 МБ.

UMA в BIOS можно оставить минимальным: с объединённой кучей он не нужен, а RAM остаётся системе.

Помните, что GTT и RAM — одна и та же физическая память. Генерация видео на Wan забирает до ~22 ГБ, поэтому на 32-гигабайтной машине одновременно с ней не стоит запускать другие тяжёлые сервисы. Своп или zram (8–16 ГБ) — хорошая страховка от OOM-killer.

## Vulkan вместо ROCm

- Встроенная графика Ryzen AI в ROCm поддерживается ограниченно и нестабильно. Vulkan (Mesa RADV) работает из коробки в любом свежем дистрибутиве.
- PyTorch не умеет Vulkan, поэтому ComfyUI и diffusers на iGPU без ROCm работают только на CPU. Платформа использует [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (ggml): у него зрелый Vulkan-бэкенд и поддержка SD 1.5/SDXL/Flux, AnimateDiff, Wan, LTX и других моделей.
- Контейнеру нужен только `/dev/dri` (render node) и числовые GID групп `render`/`video` хоста. `/dev/kfd` (ROCm) не нужен.

## NPU (XDNA) {#npu-xdna}

NPU XDNA 2 (~50 TOPS) есть во всей линейке, но платформа его пока не использует:

- Драйвер `amdxdna` вошёл в ядро только с 6.14. В Debian 13 (6.12) его нет, нужен DKMS из [xdna-driver](https://github.com/amd/xdna-driver) плюс XRT.
- [Ryzen AI Software для Linux](https://ryzenai.docs.amd.com/en/latest/linux.html) поддерживает только сценарий «NPU-only» для CNN/NLP и LLM, пакеты собраны под Ubuntu 24.04.
- Диффузионные видеомодели на NPU под Linux не запускаются. Для SD есть энтузиастский проект [amd-npu-stable-diffusion-linux](https://github.com/mcolsen/amd-npu-stable-diffusion-linux), только картинки.
- В Windows-приложении AMD Amuse NPU используется для ускорения части моделей и для «XDNA Super Resolution». На Linux этот апскейл дешевле сделать на iGPU (ESRGAN через Vulkan).

Платформа показывает, найден ли NPU (`/api/state` → `system.npu`). Вернуться к нему имеет смысл, когда `amdxdna` появится в стандартном ядре дистрибутива и появятся Linux-рантаймы для диффузионных моделей.
