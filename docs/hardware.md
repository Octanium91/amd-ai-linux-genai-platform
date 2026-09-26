# Hardware: Ryzen AI on Linux

## The Ryzen AI lineup

The platform targets AMD APUs built on **Zen 5 + RDNA 3.5 + XDNA 2**. The integrated graphics has no memory of its own: it gets a share of the system RAM (UMA/GTT). So the amount of RAM and its bandwidth decide which models fit and how fast they run.

| Family | CPUs (examples) | iGPU | CU | Memory | What to expect |
|---|---|---|---|---|---|
| **Strix Halo** | Ryzen AI MAX+ 395, MAX 390/385 | Radeon 8060S / 8050S | 40 / 32 | up to 128 GB, 256-bit LPDDR5X | Wan 2.2 5B is practical, AnimateLCM is fast |
| **Strix Point** | Ryzen AI 9 HX 370, 365 | Radeon 890M / 880M | 16 / 12 | up to 96 GB, 128-bit LPDDR5X/DDR5 | AnimateLCM and images are comfortable, Wan takes hours |
| **Krackan Point** | Ryzen AI 7 350, Ryzen AI 5 340 | Radeon 860M / 840M | 8 / 4 | 128-bit | images and short AnimateLCM clips, slower than Strix Point |

CU counts and memory buses come from AMD and reviews ([TechPowerUp](https://www.techpowerup.com/324874/amd-details-the-radeon-890m-rdna-3-5-igpu-of-strix-point-a-bit-more), [Tom's Hardware](https://www.tomshardware.com/pc-components/cpus/amd-unwraps-ryzen-ai-300-series-strix-point-processors-50-tops-of-ai-performance-zen-5c-density-cores-come-to-ryzen-9-for-the-first-time)). Check exact specs of a particular model on [amd.com](https://www.amd.com/en/products/processors/laptop/ryzen.html). The "what to expect" column is extrapolated from CU count and memory bandwidth; only Strix Point has been measured (see [benchmarks.md](benchmarks.md)).

The whole lineup is RDNA 3.5 (gfx1150/gfx1151/gfx1152), supported by Mesa RADV since 24.x. The iGPU needs kernel **6.10+**, **6.12+** recommended.

## Reference machine

| | |
|---|---|
| Model | Sapphire EDGE AI 370 (mini PC) |
| CPU | AMD Ryzen AI 9 HX 370 (4× Zen 5 + 8× Zen 5c, 24 threads) |
| iGPU | Radeon 890M (RDNA 3.5, 16 CU, gfx1150), reported by Vulkan as `AMD Radeon Graphics (RADV GFX1150)` |
| NPU | XDNA 2 (`1022:17f0`), not used, see below |
| Memory | 32 GB LPDDR5X, shared with the GPU |
| BIOS | UMA Frame Buffer = 512 MB (the minimum; the GPU takes the rest dynamically through GTT) |
| Kernel | Debian 13 `6.12.x`, parameters `amdgpu.gttsize=24576 ttm.pages_limit=6291456 ttm.page_pool_size=6291456` → 24 GB GTT, all of it resident |
| Mesa | 25.0.7 (RADV), `mesa-vulkan-drivers` from Debian 13 |
| Disk | 4 TB NVMe (models and results) |

## Memory: UMA, GTT and the Vulkan heap

An APU has two memory pools for the GPU:

- **UMA carve-out** (BIOS: UMA Frame Buffer / iGPU Memory) — a fixed slice of RAM, the "VRAM". 512 MB on the reference machine.
- **GTT** — system memory the GPU allocates dynamically. This is what models need.

Two steps are required:

1. **Enlarge GTT and the TTM limit — both.** By default the kernel gives the GPU about half of the RAM. We recommend ~¾ of RAM (24 GB for 32 GB; ~48 GB for 64 GB; ~96 GB for 128 GB). Two parameters are needed in `/etc/default/grub` → `GRUB_CMDLINE_LINUX_DEFAULT`: `amdgpu.gttsize` sets the GTT size, and `ttm.pages_limit` lets TTM (the kernel memory manager amdgpu keeps GTT with) hold that much in RAM. With `amdgpu.gttsize` alone the GTT reports 24 GB, but TTM still keeps at most half of the RAM resident and swaps the rest out: measured on the reference machine, an AnimateDiff job with a ~16 GB working set swapped continuously, the GPU was idle two thirds of the time and the job ran about 2.5× slower. The **System** section warns about this (`GPU memory limit (TTM)`).
   ```
   amdgpu.gttsize=24576 ttm.pages_limit=6291456 ttm.page_pool_size=6291456
   # gttsize in MiB (deprecated on newer kernels, which size GTT from the ttm limit); ttm values in 4 KiB pages (24 GB = 6291456)
   ```
   Then `sudo update-grub` and reboot. Check with `cat /sys/class/drm/card*/device/mem_info_gtt_total` and `cat /sys/module/ttm/parameters/pages_limit` (× 4096 must be at least the GTT size). `scripts/setup.sh` computes the values for your RAM.
2. **Unify the Vulkan heaps.** On APUs, RADV exposes a small DEVICE_LOCAL heap (≈ UMA) plus part of GTT separately by default. The Mesa option `radv_enable_unified_heap_on_apu=true` makes a single DEVICE_LOCAL heap the size of GTT. The platform enables it both through an environment variable and through `config/drirc`. Check with `./scripts/check-gpu.sh`: the reference machine shows a `24.50 GiB` heap, not 512 MB.

The UMA size in the BIOS can stay at the minimum: with the unified heap it is not needed, and the RAM stays available to the system.

Keep in mind that GTT and RAM are the same physical memory. Wan video generation takes up to ~22 GB, so on a 32 GB machine do not run other heavy services at the same time. Swap or zram (8–16 GB) is good insurance against the OOM killer.

## Vulkan instead of ROCm

- ROCm support for Ryzen AI integrated graphics is limited and unstable. Vulkan (Mesa RADV) works out of the box on any recent distribution.
- PyTorch has no Vulkan backend, so without ROCm ComfyUI and diffusers only run on the CPU. The platform uses [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (ggml): it has a mature Vulkan backend and supports SD 1.5/SDXL/Flux, AnimateDiff, Wan, LTX and other models.
- The container only needs `/dev/dri` (the render node) and the numeric GIDs of the host `render`/`video` groups. `/dev/kfd` (ROCm) is not needed.

## NPU (XDNA)

The whole lineup has an XDNA 2 NPU (~50 TOPS), but the platform does not use it yet:

- The `amdxdna` driver landed in the kernel only in 6.14. Debian 13 (6.12) does not have it; it needs DKMS from [xdna-driver](https://github.com/amd/xdna-driver) plus XRT.
- [Ryzen AI Software for Linux](https://ryzenai.docs.amd.com/en/latest/linux.html) supports only the "NPU-only" flow for CNN/NLP models and LLMs, with packages built for Ubuntu 24.04.
- Diffusion video models do not run on the NPU under Linux. For SD there is the community project [amd-npu-stable-diffusion-linux](https://github.com/mcolsen/amd-npu-stable-diffusion-linux), images only.
- The AMD Amuse app on Windows uses the NPU to accelerate some models and for "XDNA Super Resolution". On Linux that upscale is cheaper on the iGPU (ESRGAN via Vulkan).

The platform reports whether an NPU is present (`/api/state` → `system.npu`). It makes sense to revisit it once `amdxdna` ships in the stock distribution kernel and Linux runtimes for diffusion models appear.
