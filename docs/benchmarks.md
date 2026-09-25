# Benchmarks

Machine: Sapphire EDGE AI 370 — Ryzen AI 9 HX 370, **Radeon 890M (16 CU)**, 32 GB LPDDR5X, 24 GB GTT, Debian 13, kernel 6.12, Mesa 25.0.7 (RADV), stable-diffusion.cpp `88411ef` (Vulkan). Video test prompt: "A cute raccoon playing guitar in the beach".

All numbers are measured, not estimated, unless marked as an estimate.

## Video

| Mode | Parameters | Sampling | Decoding | Total |
|---|---|---|---|---|
| **AnimateLCM**, CFG 1 | 512×512, 16 frames, 6 steps, lcm | 101 s (~14–17 s/step) | 46 s | **150 s** (through the UI, with 8→24 fps interpolation) |
| AnimateLCM, CFG 1.5 | same | ~49 s/step | 53 s | 296 s |
| AnimateDiff v3 | 512×512, 16 frames, 20 steps, CFG 8 | 899 s (~45 s/step) | 57 s | 957 s |
| AnimateLCM, **extra 5 s** | 2 segments × 20 frames, 4 steps (Draft), continuation strength 0.55 | — | — | 402 s (through the UI, with 8→24 fps interpolation) |
| AnimateLCM, extra 5 s | same, continuation strength 0.75 | 208 s + ~214 s | — | 531 s |
| Wan 2.2 TI2V 5B Q8_0 | 832×480, 17 frames, 10 steps | 676 s (~63 s/step) | 2027 s (tiled VAE) | 45 min |
| Wan 2.2 TI2V 5B Q8_0 | 832×480, 49 frames, 25 steps | ~172 s/step | — | ≈ 2.5–3 h (estimate) |
| Wan 2.2 TI2V 5B Q8_0, **High** | 832×480, 49 frames (2 s), 40 steps, CFG 5 | 10 400–10 500 s (~265 s/step) | 5 100–5 170 s (tiled VAE) | **4 h 20 min** (two clips, through the UI) |
| Wan 2.2 TI2V 5B Q8_0 | 832×480, 65 frames, 40 steps | ~207 s/step | — | > 3 h (estimate) |

Peak GTT usage: AnimateDiff and AnimateLCM ~8 GB; Wan 2.2 5B ~16 GB during sampling and up to 22.3 GB during VAE decoding.

With continuation strength 0.55 the second segment of an extra-length clip keeps the composition of the first one; with 0.75 it drifted into a different scene.

## Images

| Mode | Parameters | Total |
|---|---|---|
| Realistic Vision 6 | 512×768, 25 steps, dpm++2m karras, CFG 5.5, **2 variants** | **85 s** (sampling 43 s, decoding 8 s) — ~40 s per image |
| Realistic Vision 6, **Extra** | 768×1024 or 1024×768, 80 steps, dpm++2m karras, CFG 5.5, 1 image | **5–6 min** (sampling 290–350 s at ~4.3 s/step, decoding 9–12 s); the first of eight took 3 min 53 s at 2.9 s/step |

## What affects speed

Measured on AnimateDiff v3, 2 steps each, 16 frames at 512×512:

| Variant | s/step | Takeaway |
|---|---|---|
| baseline (`--diffusion-fa --offload-to-cpu`, CFG 8) | 41.5 | |
| without `--offload-to-cpu` | 45.4 | offloading weights to RAM costs nothing on an APU: the memory is shared |
| without `--diffusion-fa` | 93.5 | **flash attention is essential** |
| CFG 1 | 23.7 | CFG > 1 doubles the work (a second, negative pass) |
| 384×384 | 22.2 | time is roughly proportional to the pixel count |

The main levers are the number of steps and CFG. That is why AnimateLCM (6 steps, CFG 1) is 6× faster than AnimateDiff v3 (20 steps, CFG 8) with a comparable picture. For Wan on this hardware the bottleneck is tiled VAE decoding.

## Other machines

On a Ryzen AI MAX+ 395 (Radeon 8060S, 40 CU, 256-bit memory) expect a multiple speed-up: 2.5× the CUs and roughly twice the memory bandwidth. If you run another machine from the lineup, please contribute measurements to this table.

The generation form scales the measurements above to the local GPU by compute units × clock until the machine has its own history, see [models.md](models.md). Memory bandwidth is not part of that formula, so on Strix Halo the real speed-up may be larger than the estimate.
