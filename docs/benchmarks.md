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
| AnimateLCM, **13.1 s from 7 shots**, RealVisXL Lightning keyframes | 512×512, 7 × 15 frames, 6 steps, CFG 1; each keyframe 1024×1024, 5 steps, animated at strength 0.75 | — | — | **982 s** (16 min 22 s); Mars, the action changes in every shot, but the two costumes mix |
| AnimateLCM, 13.1 s from 7 shots, **Z-Image Turbo keyframes** | the same scenes; each keyframe 1024×1024, 8 steps | — | — | **1833 s** (30 min 33 s); Batman and Superman distinct in every shot |
| **Wan 2.2 5B Turbo**, one shot from a Z-Image keyframe | 832×480, 49 frames (2 s at 24 fps), 4 steps, CFG 1, flow shift 5, TAEHV decoder with `--vae-conv-direct` | 77 s (19 s/step) | **1.4 s** | **84 s**; real motion: a lunge, a punch, the other recoils, dust |
| FastWan 2.2 5B, the same shot | 3 steps, CFG 1, flow shift 5, TAEHV without `--vae-conv-direct` | 57 s (18 s/step) | 162 s | 226 s; `--vae-conv-direct` takes the decode down to seconds |
| **Wan 2.2 5B Turbo, 12.25 s from 6 shots** with a storyboard | 832×480, 6 × 49 frames; Z-Image Turbo keyframes at 960×512 (8 steps), each after the first redrawn from the previous shot's last frame at strength 0.65 | — | — | **836 s** (13 min 56 s); the same Batman and Superman on Mars throughout, each shot continues the previous one, real action in every shot |
| Z-Image Turbo keyframe | 832×480, 8 steps | — | — | about 60 s |
| Wan 2.2 5B Turbo, **12.25 s from 6 shots at 1280×704** (the trained size) | 6 × 49 frames, Z-Image keyframes at 1280×704, chained at 0.65 | — | — | **2104 s** (35 min); much sharper faces, armour and capes, a wide Mars plain; but the chained keyframes drifted darker and redder shot by shot, and Superman ended in a bat cowl |
| the same, keyframes colour-anchored to the first one, chained at 0.7 | the same scenes and seed | — | — | 2091 s; the colour stays even across all shots; the characters still swap features in the last two shots |
| the same, chained at 0.75, looks saying what tells the characters apart ("a cowl … covering his upper face" / "bare head … his whole face visible") | new scenes, the same seed | — | — | **2125 s**; Batman masked and Superman bare-headed in every shot; left: a small extra flying Superman in one shot, a building on Mars in another |
| Wan 2.2 TI2V 5B Q8_0 | 832×480, 17 frames, 10 steps | 676 s (~63 s/step) | 2027 s (tiled VAE) | 45 min; the distilled Turbo/FastWan with TAEHV below do 49 frames in 1.5 min |
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

## Full benchmark, all modes and parameters (September 2026)

Every installed mode at every size it offers, its quality levels and the parameters that change time or result, one at a time, run by `scripts/benchmark.mjs` on the reference machine through the queue. The same prompt and seed (42) per kind: images "portrait photo of an old fisherman in a knitted sweater on a harbor pier, overcast light, detailed skin, 85mm"; video "an old fisherman in a knitted sweater turns his head and smiles on a windy harbor pier, waves and boats behind him, overcast light, cinematic" (image-to-video modes start from a picture of the image prompt fitted to the size); music "warm acoustic folk, fingerpicked guitar, soft piano, light percussion, nostalgic, 90 BPM"; sound effects "waves crashing on a rocky shore with seagulls and wind"; speech "The old fisherman looked at the sea and smiled. The wind was calm, and the boats were ready for the morning.". Times include loading the models. Peak GTT is the GPU memory the job used; thermal is the share of the job the GPU spent throttled by temperature. Audio jobs are too short for the thermal share to mean much.


### Realistic Vision 6 · photo

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| size 512×768 | 512×768, 25 steps, CFG 5.5 | **30 s** | 27 s | 3 s | 1.074 | 6.1 GB | 74 °C | 0% |
| size 768×1024 | 768×1024, 25 steps, CFG 5.5 | **1 min 17 s** | 1 min 11 s | 5 s | 2.824 | 10 GB | 76 °C | 0% |
| size 896×896 | 896×896, 25 steps, CFG 5.5 | **1 min 19 s** | 1 min 13 s | 5 s | 2.93 | 10.2 GB | 78 °C | 0% |
| size 1024×768 | 1024×768, 25 steps, CFG 5.5 | **1 min 18 s** | 1 min 12 s | 6 s | 2.859 | 10 GB | 78 °C | 0% |
| size 640×1152 | 640×1152, 25 steps, CFG 5.5 | **1 min 09 s** | 1 min 04 s | 4 s | 2.568 | 9.5 GB | 79 °C | 0% |
| size 1152×640 | 1152×640, 25 steps, CFG 5.5 | **1 min 09 s** | 1 min 04 s | 4 s | 2.554 | 9.5 GB | 80 °C | 0% |
| quality draft | 512×768, 12 steps, CFG 5.5 | **16 s** | 13 s | 3 s | 1.078 | 6.1 GB | 77 °C | 0% |
| quality high | 512×768, 40 steps, CFG 5.5 | **45 s** | 42 s | 3 s | 1.051 | 6.1 GB | 78 °C | 0% |
| strictness 2.75 | 512×768, 25 steps, CFG 2.75 | **30 s** | 27 s | 3 s | 1.058 | 6.1 GB | 78 °C | 0% |
| strictness 8.25 | 512×768, 25 steps, CFG 8.25 | **30 s** | 27 s | 3 s | 1.059 | 6.1 GB | 78 °C | 0% |

### RealVisXL V5 · SDXL photo

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| size 1024×1024 | 1024×1024, 30 steps, CFG 5 | **3 min 02 s** | 2 min 39 s | 20 s | 5.311 | 7.3 GB | 78 °C | 0% |
| size 896×1152 | 896×1152, 30 steps, CFG 5 | **2 min 36 s** | 2 min 18 s | 16 s | 4.602 | 7.3 GB | 79 °C | 0% |
| size 1152×896 | 1152×896, 30 steps, CFG 5 | **2 min 36 s** | 2 min 18 s | 17 s | 4.588 | 7.3 GB | 80 °C | 0% |
| size 832×1216 | 832×1216, 30 steps, CFG 5 | **2 min 38 s** | 2 min 23 s | 14 s | 4.759 | 7.3 GB | 78 °C | 0% |
| size 1216×832 | 1216×832, 30 steps, CFG 5 | **2 min 38 s** | 2 min 22 s | 14 s | 4.741 | 7.3 GB | 78 °C | 0% |
| size 768×1344 | 768×1344, 30 steps, CFG 5 | **2 min 35 s** | 2 min 17 s | 15 s | 4.579 | 7.3 GB | 80 °C | 0% |
| size 1344×768 | 1344×768, 30 steps, CFG 5 | **2 min 35 s** | 2 min 18 s | 15 s | 4.587 | 7.3 GB | 81 °C | 0% |
| quality draft | 1024×1024, 20 steps, CFG 5 | **1 min 53 s** | 1 min 34 s | 17 s | 4.711 | 7.3 GB | 80 °C | 0% |
| quality high | 1024×1024, 45 steps, CFG 5 | **3 min 50 s** | 3 min 31 s | 17 s | 4.69 | 7.3 GB | 81 °C | 0% |
| strictness 2.5 | 1024×1024, 30 steps, CFG 2.5 | **2 min 38 s** | 2 min 20 s | 17 s | 4.654 | 7.3 GB | 80 °C | 0% |
| strictness 7.5 | 1024×1024, 30 steps, CFG 7.5 | **2 min 36 s** | 2 min 18 s | 17 s | 4.597 | 7.3 GB | 80 °C | 0% |

### RealVisXL V5 Lightning · fast SDXL

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| size 1024×1024 | 1024×1024, 5 steps, CFG 1.5 | **47 s** | 27 s | 18 s | 5.484 | 7.3 GB | 79 °C | 0% |
| size 896×1152 | 896×1152, 5 steps, CFG 1.5 | **42 s** | 24 s | 17 s | 4.794 | 7.3 GB | 78 °C | 0% |
| size 1152×896 | 1152×896, 5 steps, CFG 1.5 | **42 s** | 24 s | 17 s | 4.838 | 7.3 GB | 76 °C | 0% |
| size 832×1216 | 832×1216, 5 steps, CFG 1.5 | **40 s** | 25 s | 14 s | 4.924 | 7.3 GB | 77 °C | 0% |
| size 1216×832 | 1216×832, 5 steps, CFG 1.5 | **40 s** | 25 s | 14 s | 4.958 | 7.3 GB | 78 °C | 0% |
| size 768×1344 | 768×1344, 5 steps, CFG 1.5 | **41 s** | 24 s | 16 s | 4.828 | 7.3 GB | 77 °C | 0% |
| size 1344×768 | 1344×768, 5 steps, CFG 1.5 | **41 s** | 24 s | 15 s | 4.838 | 7.3 GB | 78 °C | 0% |
| quality draft | 1024×1024, 4 steps, CFG 1.5 | **38 s** | 20 s | 17 s | 4.958 | 7.3 GB | 77 °C | 0% |
| quality high | 1024×1024, 6 steps, CFG 1.5 | **47 s** | 29 s | 17 s | 4.79 | 7.3 GB | 76 °C | 0% |
| quality extra | 1024×1024, 8 steps, CFG 1.5 | **57 s** | 38 s | 17 s | 4.804 | 7.3 GB | 78 °C | 0% |
| strictness 0.75 | 1024×1024, 5 steps, CFG 0.75 | **43 s** | 24 s | 17 s | 4.83 | 7.3 GB | 78 °C | 0% |
| strictness 2.25 | 1024×1024, 5 steps, CFG 2.25 | **43 s** | 24 s | 17 s | 4.848 | 7.3 GB | 80 °C | 0% |

### Z-Image Turbo · photo

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| size 1024×1024 | 1024×1024, 8 steps, CFG 1 | **2 min 16 s** | 1 min 57 s | 17 s | 14.606 | 11.5 GB | 82 °C | 3% |
| size 832×1216 | 832×1216, 8 steps, CFG 1 | **2 min 14 s** | 1 min 57 s | 14 s | 14.666 | 11.5 GB | 81 °C | 0% |
| size 1216×832 | 1216×832, 8 steps, CFG 1 | **2 min 13 s** | 1 min 58 s | 14 s | 14.689 | 11.5 GB | 82 °C | 0% |
| size 768×1344 | 768×1344, 8 steps, CFG 1 | **2 min 17 s** | 1 min 59 s | 16 s | 14.885 | 11.5 GB | 82 °C | 0% |
| size 1344×768 | 1344×768, 8 steps, CFG 1 | **2 min 18 s** | 2 min 00 s | 16 s | 15.005 | 11.5 GB | 82 °C | 0% |
| size 1024×512 | 1024×512, 8 steps, CFG 1 | **1 min 06 s** | 57 s | 7 s | 7.114 | 11.3 GB | 81 °C | 0% |
| size 512×1024 | 512×1024, 8 steps, CFG 1 | **1 min 06 s** | 57 s | 7 s | 7.071 | 11.3 GB | 81 °C | 0% |
| quality draft | 1024×1024, 6 steps, CFG 1 | **1 min 52 s** | 1 min 34 s | 17 s | 15.58 | 11.5 GB | 81 °C | 0% |
| quality high | 1024×1024, 10 steps, CFG 1 | **2 min 51 s** | 2 min 33 s | 17 s | 15.25 | 11.5 GB | 82 °C | 0% |
| quality extra | 1024×1024, 14 steps, CFG 1 | **3 min 52 s** | 3 min 33 s | 17 s | 15.234 | 11.5 GB | 82 °C | 0% |

### Real-ESRGAN · upscale ×4

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| upscale 256×256 | 1024×1024, CFG 1 | **4 s** | 0 s | 0 s | — | 0 GB | 59 °C | 0% |
| upscale 512×512 | 2048×2048, CFG 1 | **29 s** | 0 s | 0 s | — | 2.9 GB | 74 °C | 0% |

### AnimateLCM · Realistic Vision (fast)

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| size 512×512 | 512×512, 16 frames, 6 steps, CFG 1, 8→24 fps | **1 min 49 s** | 1 min 16 s | 28 s | 15.26 | 9.2 GB | 77 °C | 0% |
| size 768×512 | 768×512, 16 frames, 6 steps, CFG 1, 8→24 fps | **2 min 31 s** | 1 min 44 s | 41 s | 20.826 | 11.8 GB | 79 °C | 3% |
| size 512×768 | 512×768, 16 frames, 6 steps, CFG 1, 8→24 fps | **2 min 27 s** | 1 min 42 s | 40 s | 20.43 | 11.8 GB | 81 °C | 3% |
| quality draft | 512×512, 16 frames, 4 steps, CFG 1, 8→24 fps | **1 min 29 s** | 56 s | 28 s | 14.048 | 9.2 GB | 74 °C | 4% |
| quality high | 512×512, 16 frames, 8 steps, CFG 1, 8→24 fps | **2 min 10 s** | 1 min 37 s | 28 s | 13.887 | 9.2 GB | 74 °C | 3% |
| text to video | 512×512, 16 frames, 6 steps, CFG 1, 8→24 fps | **1 min 55 s** | 1 min 24 s | 29 s | 13.915 | 9.2 GB | 74 °C | 3% |
| strictness 1.5 | 512×512, 16 frames, 6 steps, CFG 1.5, 8→24 fps | **2 min 51 s** | 2 min 19 s | 28 s | 27.752 | 9.2 GB | 77 °C | 3% |
| strictness 2 | 512×512, 16 frames, 6 steps, CFG 2, 8→24 fps | **2 min 51 s** | 2 min 18 s | 28 s | 27.684 | 9.2 GB | 76 °C | 3% |
| 8 frames | 512×512, 8 frames, 6 steps, CFG 1, 8→24 fps | **59 s** | 42 s | 14 s | 8.358 | 7 GB | 74 °C | 6% |
| 8 fps output | 512×512, 16 frames, 6 steps, CFG 1 | **1 min 40 s** | 1 min 10 s | 28 s | 13.906 | 9.2 GB | 74 °C | 4% |
| 16 fps output | 512×512, 16 frames, 6 steps, CFG 1, 8→16 fps | **1 min 41 s** | 1 min 10 s | 28 s | 13.894 | 9.2 GB | 74 °C | 0% |

### AnimateDiff v3 · Realistic Vision (detailed)

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| size 512×512 | 512×512, 16 frames, 25 steps, CFG 8, 8→24 fps | **8 min 06 s** | 7 min 34 s | 28 s | 23.896 | 8.7 GB | 79 °C | 1% |
| size 768×512 | 768×512, 16 frames, 25 steps, CFG 8, 8→24 fps | **11 min 42 s** | 10 min 55 s | 41 s | 34.469 | 11.5 GB | 82 °C | 1% |
| size 512×768 | 512×768, 16 frames, 25 steps, CFG 8, 8→24 fps | **11 min 38 s** | 10 min 53 s | 40 s | 34.358 | 11.5 GB | 81 °C | 1% |
| quality draft | 512×512, 16 frames, 16 steps, CFG 8, 8→24 fps | **5 min 43 s** | 5 min 11 s | 28 s | 23.941 | 8.7 GB | 78 °C | 1% |
| quality high | 512×512, 16 frames, 30 steps, CFG 8, 8→24 fps | **9 min 42 s** | 9 min 09 s | 28 s | 23.883 | 8.7 GB | 79 °C | 1% |

### Wan 2.2 TI2V 5B (full, slow)

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| 17 frames | 832×480, 17 frames, 12 steps, CFG 5 | **2 min 35 s** | 2 min 26 s | 1 s | 12.145 | 16.9 GB | 80 °C | 3% |
| 49 frames | 832×480, 49 frames, 12 steps, CFG 5 | **7 min 39 s** | 7 min 29 s | 1 s | 37.441 | 17.2 GB | 80 °C | 1% |

### Wan 2.1 T2V 1.3B (experimental)

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| size 832×480 | 832×480, 81 frames, 20 steps, CFG 6 | **1 h 50 min** | 1 h 41 min | 8 min 09 s | 304.371 | 14.3 GB | 78 °C | 0% |
| size 480×832 | 480×832, 81 frames, 20 steps, CFG 6 | **1 h 44 min** | 1 h 36 min | 7 min 35 s | 287.458 | 14.3 GB | 78 °C | 0% |
| quality draft | 832×480, 81 frames, 12 steps, CFG 6 | **1 h 05 min** | 57 min 44 s | 7 min 37 s | 288.627 | 14.3 GB | 79 °C | 0% |
| 17 frames | 832×480, 17 frames, 20 steps, CFG 6 | **10 min 26 s** | 8 min 43 s | 1 min 36 s | 26.128 | 13.7 GB | 76 °C | 1% |

### ACE-Step 1.5 · music

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| 10 s | 8 steps, 10 s of audio | **28 s** | 10 s | 6 s | — | 11.6 GB | 64 °C | 20% |
| 30 s | 8 steps, 30 s of audio | **35 s** | 14 s | 14 s | — | 11.1 GB | 69 °C | 15% |
| 60 s | 8 steps, 60 s of audio | **55 s** | 22 s | 26 s | — | 11.6 GB | 73 °C | 18% |
| 120 s | 8 steps, 120 s of audio | **1 min 42 s** | 40 s | 54 s | — | 12.2 GB | 73 °C | 12% |
| 30 s with vocals | 8 steps, 30 s of audio | **36 s** | 15 s | 13 s | — | 11.3 GB | 68 °C | 15% |

### Stable Audio 3 Small · sound effects

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| 2 s | 8 steps, 2 s of audio | **4 s** | 1 s | 0 s | — | 1.5 GB | 69 °C | 33% |
| 8 s | 8 steps, 8 s of audio | **4 s** | 1 s | 0 s | — | 1.6 GB | 67 °C | 100% |
| 30 s | 8 steps, 30 s of audio | **5 s** | 2 s | 0 s | — | 1.6 GB | 70 °C | 17% |

### Supertonic 3 · speech

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| 108 characters, en | 8 steps, 7.8 s of audio | **4 s** | 0 s | 0 s | — | 0.3 GB | 64 °C | 67% |
| 432 characters, en | 8 steps, 29.9 s of audio | **5 s** | 1 s | 1 s | — | 0.3 GB | 65 °C | 40% |
| Ukrainian | 8 steps, 7.2 s of audio | **4 s** | 0 s | 0 s | — | 0.3 GB | 64 °C | 67% |

### Wan 2.2 5B Turbo (real motion, fast)

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| size 832×480 | 832×480, 49 frames, 4 steps, CFG 1 | **1 min 25 s** | 1 min 16 s | 1 s | 18.973 | 17.2 GB | 75 °C | 0% |
| size 480×832 | 480×832, 49 frames, 4 steps, CFG 1 | **1 min 25 s** | 1 min 16 s | 1 s | 18.923 | 17.2 GB | 78 °C | 4% |
| size 1280×704 | 1280×704, 49 frames, 4 steps, CFG 1 | **4 min 03 s** | 3 min 51 s | 3 s | 57.79 | 21 GB | 77 °C | 4% |
| size 704×1280 | 704×1280, 49 frames, 4 steps, CFG 1 | **4 min 11 s** | 3 min 59 s | 3 s | 59.802 | 18.3 GB | 76 °C | 2% |
| text to video | 832×480, 49 frames, 4 steps, CFG 1 | **1 min 24 s** | 1 min 16 s | 1 s | 18.895 | 17.2 GB | 76 °C | 0% |
| 17 frames | 832×480, 17 frames, 4 steps, CFG 1 | **31 s** | 26 s | 1 s | 6.493 | 16.9 GB | 75 °C | 8% |
| 81 frames | 832×480, 81 frames, 4 steps, CFG 1 | **2 min 30 s** | 2 min 21 s | 2 s | 35.32 | 17.5 GB | 77 °C | 3% |
| 121 frames | 832×480, 121 frames, 4 steps, CFG 1 | **4 min 29 s** | 4 min 18 s | 3 s | 64.555 | 21.5 GB | 77 °C | 2% |
| 48 fps output | 832×480, 49 frames, 4 steps, CFG 1, 24→48 fps | **1 min 28 s** | 1 min 16 s | 1 s | 18.93 | 17.2 GB | 77 °C | 4% |

### FastWan 2.2 5B (real motion, fast)

| Setting | Parameters | Total | Sampling | Decoding | s/step | Peak GTT | GPU | Thermal |
|---|---|---|---|---|---|---|---|---|
| size 832×480 | 832×480, 49 frames, 3 steps, CFG 1 | **1 min 05 s** | 57 s | 1 s | 19 | 17.3 GB | 77 °C | 6% |
| size 480×832 | 480×832, 49 frames, 3 steps, CFG 1 | **1 min 01 s** | 54 s | 1 s | 17.897 | 17.3 GB | 78 °C | 6% |
| size 1280×704 | 1280×704, 49 frames, 3 steps, CFG 1 | **3 min 05 s** | 2 min 55 s | 3 s | 58.36 | 18.3 GB | 78 °C | 5% |
| size 704×1280 | 704×1280, 49 frames, 3 steps, CFG 1 | **3 min 07 s** | 2 min 57 s | 3 s | 59.067 | 21 GB | 77 °C | 2% |
| text to video | 832×480, 49 frames, 3 steps, CFG 1 | **1 min 05 s** | 57 s | 1 s | 19.003 | 17.2 GB | 77 °C | 5% |
| 17 frames | 832×480, 17 frames, 3 steps, CFG 1 | **24 s** | 20 s | 1 s | 6.473 | 17 GB | 74 °C | 13% |
| 81 frames | 832×480, 81 frames, 3 steps, CFG 1 | **1 min 56 s** | 1 min 47 s | 2 s | 35.647 | 17.6 GB | 78 °C | 3% |
| 121 frames | 832×480, 121 frames, 3 steps, CFG 1 | **3 min 27 s** | 3 min 16 s | 3 s | 65.43 | 18.4 GB | 76 °C | 2% |

What the full run shows (95 jobs, no failure, no hard throttling: the GPU stayed at or below 82 °C, thermal limits at most 8% of a job):

- **Prompt strictness (CFG) costs nothing extra above or below 1,** but exactly 1 skips the negative pass: AnimateLCM at CFG 1.5 or 2 took 171 s against 109 s at 1; RealVisXL at CFG 2.5, 5 and 7.5 all took 156–158 s.
- **Time does not grow linearly with pixels and frames:** Realistic Vision at 896×896 (2× the pixels of 512×768) took 2.7× the time; Wan 2.2 Turbo at 121 frames (2.5× of 49) took 3.2×. The estimates therefore scale from the measurement closest in work (`reference.samples` in `catalog/presets.json`): checked by leaving each measurement out, the median error is 2 %, the 90th percentile 12 %.
- **SDXL sizes:** all seven ~1 MP sizes take about the same (2 min 35 s – 3 min 02 s); 1024×1024 is the slowest. Lightning spends as long decoding as sampling (17 s each).
- **Video, 2 s at 832×480 with real motion:** FastWan 65 s, Wan 2.2 Turbo 85 s, the full Wan 2.2 5B about 8 min at Draft (TAEHV decodes in about a second). 1280×704 costs about 3× (3–4 min). **Wan 2.1 1.3B is the slowest video mode by far:** 81 frames took 1 h 50 min (5 min per step) and its full VAE 8 min.
- **Output frame rate** (interpolation) adds only seconds: AnimateLCM 8, 16 and 24 fps took 100, 101 and 109 s.
- **Audio:** music ≈ 17 s + 0.7 s per second of audio (2 min of music in 102 s), sound effects 4–5 s for up to 30 s, speech about 4 s regardless of length.


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
