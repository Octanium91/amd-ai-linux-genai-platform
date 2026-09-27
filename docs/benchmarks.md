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
| AnimateLCM, **10.6 s from 6 parts with a storyboard** | 512×512, 6 × 15 frames, 6 steps (Standard), CFG 1, a scene per part from the prompt assistant, seed + part, colour-matched seams | — | — | **532 s** (8 min 52 s, through the queue, 8→24 fps); the same cat and window throughout, colours steady across the seams, slightly less contrast by the end; the motion within each part stays small |
| Wan 2.2 TI2V 5B Q8_0 | 832×480, 17 frames, 10 steps | 676 s (~63 s/step) | 2027 s (tiled VAE) | 45 min |
| Wan 2.2 TI2V 5B Q8_0 | 832×480, 49 frames, 25 steps | ~172 s/step | — | ≈ 2.5–3 h (estimate) |
| Wan 2.2 TI2V 5B Q8_0, **High** | 832×480, 49 frames (2 s), 40 steps, CFG 5 | 10 400–10 500 s (~265 s/step) | 5 100–5 170 s (tiled VAE) | **4 h 20 min** (two clips, through the UI) |
| Wan 2.2 TI2V 5B Q8_0 | 832×480, 65 frames, 40 steps | ~207 s/step | — | > 3 h (estimate) |
| Wan 2.1 VACE 1.3B fp16, **put a person in** | 832×480, 33 frames (2 s at 16 fps), 20 steps, CFG 6, reference photo | ~121 s/step, plus two VAE encodes of ~160 s | — | **49 min** (through the UI) |
| Wan 2.1 VACE 1.3B fp16, **change a video** | 832×480, 29 frames from a 2 s upload, 20 steps, CFG 6, contour control frames | — | — | **30 min** (through the UI); pose, framing and motion followed the upload, the look followed the prompt |

### Wan 2.1 VACE speedups

The same "change a video" job (832×480, 29 frames from a 2 s upload, 20 steps, CFG 6, contour control, seed 777) with different engine flags, queued straight on the worker:

| Flags | Preparing (control frames, encodes) | Sampling | Decoding | Total |
|---|---|---|---|---|
| `--offload-to-cpu` (the preset until now) | 262 s | 1354 s (67.5 s/step) | 173 s | **1789 s** |
| no offload | 257 s | 1254 s (62.2 s/step) | 162 s | **1674 s** (−6%); peak RAM 27.1 of 30.5 GB |
| no offload + `--cache-mode easycache --cache-option threshold=0.2` | 257 s | 545 s | 165 s | **968 s** (−46%) |
| `--offload-to-cpu` + easycache, threshold 0.2 (**the preset now**) | 263 s | 583 s | 163 s | **1009 s** (−44%) |

EasyCache skips the model on steps where its output barely changes, so sampling took 40% of the time. Frames from the three clips were nearly identical (same face, pose and framing); the EasyCache clip is slightly softer and lower in contrast. Dropping the offload saves only 6% and brings RAM close to the limit, so the preset keeps `--offload-to-cpu` and adds EasyCache: a VACE clip now takes about 17 minutes instead of 30.

Peak GTT usage: AnimateDiff and AnimateLCM ~8 GB; Wan 2.2 5B ~16 GB during sampling and up to 22.3 GB during VAE decoding.

With continuation strength 0.55 the second segment of an extra-length clip keeps the composition of the first one; with 0.75 it drifted into a different scene.

## Audio

audio.cpp `v0.8.2-audio8-perf-hotfix`, Vulkan (RADV GFX1150), Q8_0 or F16 GGUF packages. Times are the whole job through the queue unless marked as a direct CLI run.

| Mode | Request | Total |
|---|---|---|
| **ACE-Step 1.5 turbo**, music | 30 s, lyrics written by the model, 8 steps | **35 s** (48 kHz stereo) |
| ACE-Step 1.5 turbo | 30 s, own lyrics (verse and chorus) | 36 s (direct CLI run) |
| ACE-Step 1.5 turbo | 20 s instrumental | 26 s (CLI: planner LM 13.1 s, diffusion 2.0 s, VAE decoding 9.3 s) |
| **Stable Audio 3 Small SFX** | 8 s, a campfire with crickets | **5 s** (44.1 kHz stereo) |
| Stable Audio 3 Small SFX | 10 s, rain on a tin roof with thunder | 3.9 s (direct CLI run) |
| **Supertonic 3**, speech | a Russian sentence of 10 s | **4 s** (44.1 kHz mono) |
| Supertonic 3 | Russian 6 s, Ukrainian 5.6 s, English 3.2 s | 2–3 s each (direct CLI run, including the container start) |

Music takes about as long to make as to listen to; the planner LM and the VAE take most of it, the 8 diffusion steps only 2 s.

## Images

| Mode | Parameters | Total |
|---|---|---|
| Realistic Vision 6 | 512×768, 25 steps, dpm++2m karras, CFG 5.5, **2 variants** | **85 s** (sampling 43 s, decoding 8 s) — ~40 s per image |
| **RealVisXL V5** (SDXL) | 1024×1024, 30 steps, dpm++2m karras, CFG 5, 1 image | **162 s** (sampling 143 s at 4.8 s/step, decoding 17 s); 7.3 GB of GTT, 1.6 Wh |
| **RealVisXL V5 Lightning** | 1024×1024, 6 steps, dpm++2m karras, CFG 1.5 | **48 s** (sampling 29 s at 4.9 s/step, decoding 17 s); 7.3 GB of GTT, 0.4 Wh |
| **Z-Image Turbo** Q8_0 | 1024×1024, 8 steps, euler, CFG 1, Qwen3 4B Q8_0 encoder | **168 s** (sampling 149 s at 18.6 s/step, decoding 17 s); 11.5 GB of GTT, 1.6 Wh |
| Realistic Vision 6, **Extra** | 768×1024 or 1024×768, 80 steps, dpm++2m karras, CFG 5.5, 1 image | **5–6 min** (sampling 290–350 s at ~4.3 s/step, decoding 9–12 s); the first of eight took 3 min 53 s at 2.9 s/step |

The three 1024×1024 runs used one prompt and seed (an old fisherman on a harbor pier), no thermal throttling, GPU up to 78 °C. RealVisXL and its Lightning variant both gave convincing skin and knit texture; Lightning is 3.4× faster with slightly less detail. Z-Image followed the long natural-language prompt most closely (the navy sweater, the wooden pier, the peeling paint of the boats). A Z-Image step costs ~4× an SDXL step, so its 8 steps take as long as 30 SDXL steps.

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
