# AMD AI Linux GenAI Platform

A self-hosted platform for local generative content (video, images, and more to come) on **AMD Ryzen AI** mini PCs and laptops running **Linux**. Everything runs on the integrated Radeon GPU through **Vulkan (Mesa RADV)** — no ROCm required. It ships a web UI with sign-in, a job queue, live progress, a gallery, and a model manager that downloads and removes models by itself.

The UI is available in English (default), Ukrainian and Russian.

## Features

- **Video:** text-to-video and image-to-video. AnimateLCM (fast, ~2.5 min per 2 s on a Radeon 890M), AnimateDiff v3 (more detailed), Wan 2.2 5B (coherent motion, for Strix Halo). Output FPS of 24/30/50/60/120 via motion interpolation. **Extra duration** (up to 2× the model limit) is built from two chained segments; **Extra quality** uses twice the steps of High.
- **Images:** photorealistic images with Realistic Vision 6 (SD 1.5), several variants at once, image-to-image.
- **Queue and progress:** jobs run strictly one at a time (there is one GPU). Stages, steps, speed, time left, a latent preview and a live log are shown.
- **Models:** a catalog with sources, sizes and licenses. One-click downloads with resume, conversion into the stable-diffusion.cpp format, deletion. A mode without its models offers to download them.
- **First-run setup:** while nothing is usable yet, the administrator gets a checklist of model packs with sizes and explanations; the required base is locked, recommendations depend on the hardware.
- **System check:** the platform checks itself — GPU via Vulkan, render node access, CPU family and GPU architecture, kernel, GTT size, the unified Vulkan heap, memory for heavy modes, swap, disk, engine, NPU — and shows concrete advice with copyable commands. Critical problems show a banner for administrators and are logged at startup.
- **Users:** the first administrator is created on first start, then it is sign-in only (scrypt passwords). The administrator adds users; admin/user roles, everyone owns their jobs.
- **Start templates:** on open, the form is filled with one of 10 hidden templates (car, animal, person, architecture, nature…) with settings tuned for maximum quality.
- **Extensible:** modes and models are described in JSON (`catalog/`); your own are added without a rebuild via `data/state/*.local.json`.

## Hardware

Built for the **Ryzen AI** lineup (RDNA 3.5 + XDNA 2): Strix Point (Ryzen AI 9 HX 370/365 — Radeon 890M/880M), Krackan Point (Ryzen AI 7/5 — Radeon 860M/840M), Strix Halo (Ryzen AI MAX/MAX+ — Radeon 8040S/8050S/8060S). It works on any GPU with Vulkan, but the settings and measurements target these APUs.

Developed and measured on a **Sapphire EDGE AI 370**: Ryzen AI 9 HX 370, Radeon 890M, 32 GB LPDDR5X, 512 MB UMA, 24 GB GTT, Debian 13, kernel 6.12, Mesa 25.0.7. Details in [docs/hardware.md](docs/hardware.md), measurements in [docs/benchmarks.md](docs/benchmarks.md).

The NPU (XDNA) is not used yet: on Linux it has no support for diffusion video models. See [docs/hardware.md](docs/hardware.md#npu-xdna).

## Quick start

Requirements: Linux (tested on Debian 13; Ubuntu 24.04+ works too), kernel 6.10+, Docker with compose, ~20–40 GB of disk for models.

```bash
git clone https://github.com/Octanium91/amd-ai-linux-genai-platform.git
cd amd-ai-linux-genai-platform
./scripts/setup.sh --install     # host checks, Mesa/Vulkan packages, .env
docker compose up -d --build     # the first build takes ~5–10 minutes (stable-diffusion.cpp is compiled)
./scripts/check-gpu.sh           # the container must see RADV and a Vulkan heap the size of GTT
```

Open `http://<host>:7860`. On first start there are no users, so the platform offers to **create the administrator** (username and password). Do it right after starting: until then, anyone on the network can see that form. After that only sign-in is available; the administrator adds other users in the Users section.

While no models are installed, the administrator sees the **first-run setup screen**: model packs with an explanation of what each enables and its size. The Realistic Vision 6 + VAE base is needed by every mode, so its checkbox is grey and cannot be cleared. Recommended packs are pre-selected for the hardware (Wan 2.2 only on Strix Halo). After "Download selected" the Models section opens with the progress; models can be added or removed there later.

There are three independent host directories, set in `.env`: models — `MODELS_PATH` (`./models`), generated videos and images — `OUTPUT_PATH` (`./output`), users, history and logs — `DATA_PATH` (`./data`). None of them are in the image, so rebuilds and updates never touch them. Each can live on its own disk.

GTT (the memory the GPU can use) is the key parameter for video. If `setup.sh` warns that it is too small, enlarge it with a kernel parameter, see [docs/hardware.md](docs/hardware.md#memory-uma-gtt-and-the-vulkan-heap).

## Documentation

| Document | Contents |
|---|---|
| [docs/hardware.md](docs/hardware.md) | Ryzen AI lineup, reference machine, BIOS, GTT, Vulkan, NPU |
| [docs/models.md](docs/models.md) | Model and mode catalog, licenses, templates, adding your own |
| [docs/benchmarks.md](docs/benchmarks.md) | Speed measurements and what affects them |
| [docs/architecture.md](docs/architecture.md) | How the platform works, data layout, API, security, i18n |
| [docs/moving.md](docs/moving.md) | Moving to another disk or server, backup and restore |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common problems and fixes |

## Security

The UI is password-protected but meant for a home or office network. For internet access, put an HTTPS proxy (Caddy, nginx, Traefik) in front of it and set `COOKIE_SECURE=true`, `TRUST_PROXY=true`. See [docs/architecture.md](docs/architecture.md#security).

## License

The platform code is licensed under [MIT](LICENSE). The models it downloads come under their own licenses (CreativeML OpenRAIL-M, Apache-2.0, MIT and others), see [docs/models.md](docs/models.md). Complying with those licenses when using the results is the user's responsibility.

## Acknowledgements

- [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (ggml, Vulkan backend) — the generation engine.
- The models belong to their authors and are distributed under their licenses. The platform downloads them from Hugging Face using the links in [catalog/models.json](catalog/models.json), see [docs/models.md](docs/models.md).
