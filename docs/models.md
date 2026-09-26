# Models and modes

The platform does not keep models in the image. They are listed with their sources in [catalog/models.json](../catalog/models.json) and downloaded into `MODELS_PATH` on the host (`./models` by default). On a cold start the directory is empty: the Models section or the Download button in a mode's form fetches what is missing. Downloads resume after interruptions, sizes are verified, and files are converted into the stable-diffusion.cpp format when needed. A model can be deleted from the same page unless the current generation uses it.

Only administrators can download and delete models. On first start, while no mode is usable, the administrator sees the model pack picker ([catalog/packs.json](../catalog/packs.json)): the required base, packs recommended for this hardware, sizes and free disk space.

## Default catalog

| id | Model | Used for | Size | License |
|---|---|---|---|---|
| `realistic-vision-v6` | [Realistic Vision 6.0 B1](https://huggingface.co/SG161222/Realistic_Vision_V6.0_B1_noVAE) (SD 1.5, fp16) | images, AnimateLCM, AnimateDiff | 2.0 GB | CreativeML OpenRAIL-M |
| `sd-vae-ft-mse` | [SD VAE ft-MSE 840000](https://huggingface.co/stabilityai/sd-vae-ft-mse-original) | VAE for SD 1.5 | 0.3 GB | MIT |
| `animatelcm-mm` | [AnimateLCM](https://huggingface.co/wangfuyun/AnimateLCM) — motion module | fast video | 0.9 GB | not stated on the model card |
| `animatelcm-lora` | AnimateLCM — LoRA | fast video | 0.1 GB | not stated on the model card |
| `animatediff-v3-mm` | [AnimateDiff v3](https://huggingface.co/guoyww/animatediff) — motion module (repack by [conrevo](https://huggingface.co/conrevo/AnimateDiff-A1111)) | detailed video | 0.8 GB | Apache-2.0 |
| `animatediff-v3-adapter` | AnimateDiff v3 Domain Adapter LoRA | detailed video | 0.1 GB | Apache-2.0 |
| `wan22-ti2v-5b-q8` | [Wan 2.2 TI2V 5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B), GGUF Q8_0 ([QuantStack](https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF)) | video with coherent motion | 5.0 GB | Apache-2.0 |
| `wan22-vae` | Wan 2.2 VAE | Wan 2.2 | 1.3 GB | Apache-2.0 |
| `umt5-xxl-q8` | [UMT5-XXL encoder](https://huggingface.co/city96/umt5-xxl-encoder-gguf), GGUF Q8_0 | Wan text encoder | 5.6 GB | Apache-2.0 |
| `wan21-t2v-1.3b` | [Wan 2.1 T2V 1.3B](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B) | lightweight Wan (experimental) | 2.6 GB | Apache-2.0 |
| `wan21-vae` | Wan 2.1 VAE | Wan 2.1 | 0.2 GB | Apache-2.0 |

Licenses are taken from the Hugging Face model cards. Check them yourself before using results commercially.

## Modes (presets)

A mode is a ready-made combination of models and parameters, described in [catalog/presets.json](../catalog/presets.json).

| Mode | Kind | Models | Defaults | Time on a Radeon 890M |
|---|---|---|---|---|
| Realistic Vision 6 · photo | image | RV6 + VAE | 512×768, 25 steps, dpm++2m karras, CFG 5.5 | ~40 s per image |
| AnimateLCM · Realistic Vision | video | RV6 + VAE + AnimateLCM + LoRA | 512×512, 16 frames (2 s at 8 fps → 24 fps), 6 steps, lcm, CFG 1 | **~2.5 min** |
| AnimateDiff v3 · Realistic Vision | video | RV6 + VAE + AnimateDiff v3 + adapter | 512×512, 16 frames, 20 steps, euler, CFG 8 | ~16 min |
| Wan 2.2 TI2V 5B | video | Wan 2.2 5B + VAE + UMT5 | 832×480, 49 frames at 24 fps, 25 steps | hours (meant for Strix Halo) |
| Wan 2.1 T2V 1.3B | video | Wan 2.1 1.3B + VAE + UMT5 | 832×480, 16 fps | not measured (experimental) |

The Draft / Standard / High quality levels set the number of steps, which each mode defines itself (see `defaults.quality`).

### Extra

Both extra settings are red in the UI: they work, with caveats.

- **Extra quality:** twice the steps of High (or `defaults.quality.extra` if the mode defines it). Time doubles while the quality gain is already small.
- **Long videos (red part of the duration slider):** a model pass is only as long as the model was trained on — AnimateDiff/AnimateLCM 16 frames (2 s at 8 fps), Wan 2.2 5B 121 frames (5 s at 24 fps), Wan 2.1 1.3B 81 frames (5 s at 16 fps). A longer video is built from up to `maxSegments` passes of that length (AnimateDiff/AnimateLCM 4 → 8 s, Wan 2.2 2 → 10 s):
  1. the first pass is generated;
  2. its last frame becomes the init image of the next one (as in image-to-video), with a lower strength (`continueArgs`) so the next pass stays close to it;
  3. ffmpeg joins the passes, dropping the duplicated frame at each seam, and interpolates the FPS; the clip lasts exactly its frames.

  Time grows with the number of passes, and details may drift at the seams. Only modes with image-to-video support it (Wan 2.1 1.3B does not).

### Staying within what the models were trained on

The defaults follow the models' training so that the result matches the prompt; going beyond is allowed, with a warning in the form:

- **Frames per model pass** (Advanced): empty means the trained length. Up to `maxFrames` is possible, but beyond the training length the motion module loses the subject. Measured on the reference machine: AnimateDiff v3 with 32-frame passes at 768×512 produced only a sand-and-water texture for "a young woman on a windy beach", while 16 frames at 512×512 gave exactly that scene.
- **Resolution:** sizes the mode was tested at are marked ✓ (`recommendedResolutions`); other sizes show a warning that the result may not follow the prompt. AnimateDiff v3 was verified at 512×512 and 768×512 with 16-frame passes; an 8 s clip from four 2 s passes kept the same person and scene, with the contrast growing slightly from pass to pass.

## Start templates

[catalog/templates.json](../catalog/templates.json) holds 10 image and 10 video templates. When a section opens, the form is filled with a random template, preferring modes whose models are already downloaded. Templates cannot be picked in the UI: they are start examples that show how to write prompts and which settings give the best result.

- **Images** follow the Realistic Vision 6 author's recommendations:
  - prompts like "RAW photo, …, 8k uhd, dslr, soft lighting, film grain";
  - the author's negative prompt;
  - `dpm++2m` + `karras`, CFG 5–6, High (40 steps);
  - larger resolutions: 768×1024, 896×896, 1024×768, 1152×640.
- **Videos** follow the reference AnimateDiff Realistic Vision configs, adapted to AnimateLCM:
  - explicit motion cues in the prompt: wind, waves, flowing, camera tracking;
  - 16 frames (2 s), High (8 steps);
  - CFG 1.5 for more contrast and motion than CFG 1.

Templates can be extended: `negative` refers to a named negative prompt from `negatives`, and missing parameters come from `defaults`.

## AnimateLCM conversion

stable-diffusion.cpp expects the motion module in the original AnimateDiff layout, while AnimateLCM is available on Hugging Face in two forms:

- `AnimateLCM_sd15_t2v.ckpt` (1.8 GB, pickle): reading it requires PyTorch, and it lacks the `pos_encoder.pe` buffers sd.cpp looks for in the file.
- `diffusion_pytorch_model.fp16.safetensors` (0.9 GB, diffusers format): different tensor names and a single `pos_embed.pe` table per block.

The platform downloads the second file and repacks it in a streaming fashion without loading it into memory (`animatediff-from-diffusers` in [server/src/safetensors.js](../server/src/safetensors.js)):

- `attn1`/`attn2` → `attention_blocks.0`/`attention_blocks.1`;
- `norm1`/`norm2`/`norm3` → `norms.0`/`norms.1`/`ff_norm`;
- everything else gets the `temporal_transformer.` prefix;
- `pos_embed.pe` is copied into `pos_encoder.pe` of both attention blocks.

The result is 588 fp16 tensors, the same as the reference PyTorch conversion. On the reference machine all 556 weight tensors were bit-identical; the 32 positional tables differ by at most 0.0005 (fp16 rounding).

## Your own models and modes

You can add your own entries without touching the image. They are merged with the catalog by `id`; an entry with an existing `id` overrides the built-in one.

`data/state/models.local.json`:
```json
[
  {
    "id": "dreamshaper-8",
    "name": "DreamShaper 8 (SD 1.5)",
    "category": "checkpoint",
    "file": "checkpoints/dreamshaper_8.safetensors",
    "url": "https://huggingface.co/<repo>/resolve/main/dreamshaper_8.safetensors",
    "size": 2132625894,
    "license": "CreativeML OpenRAIL-M",
    "homepage": "https://huggingface.co/<repo>"
  }
]
```
`size` is in bytes and is used to verify the download (see the `Content-Length` header). If the model already exists in `MODELS_PATH` at `file`, it counts as installed right away and `url` can be omitted.

`data/state/presets.local.json` — a mode is built from models by role:
```json
[
  {
    "id": "img-dreamshaper",
    "kind": "image",
    "name": "DreamShaper 8",
    "models": { "model": "dreamshaper-8", "vae": "sd-vae-ft-mse" },
    "defaults": { "width": 512, "height": 768, "cfg": 6, "sampler": "dpm++2m", "quality": { "draft": 12, "normal": 25, "high": 40 } },
    "extraArgs": ["--scheduler", "karras", "--diffusion-fa"]
  }
]
```

Roles that become `sd-cli` flags: `model` (`--model`), `diffusion` (`--diffusion-model`), `high_noise`, `vae`, `t5xxl`, `clip_vision`, `motion_module`. Other role names (for example `lora`) are only used to check that files are present; the LoRA itself is applied through a `promptSuffix` like `<lora:name:weight>` together with `loraDir`. Video mode fields: `nativeFps`, `frameRule` (`exact` or the Wan 4n+1 rule), `minFrames`/`maxFrames` (the technical range of one pass), `segmentFrames` (the length the model was trained on: the default pass), `maxSegments` (how many passes a long video may use), `outFps`, `flowShift`, `continueArgs`, and `recommendedResolutions` next to `resolutions`.

`reference` is a real measurement of the mode on the reference machine (Radeon 890M, 16 CU, 2900 MHz; see [benchmarks.md](benchmarks.md)): `width`, `height`, `frames` (the image count for images), `steps`, `cfg`, and the `samplingSec`, `decodeSec`, `otherSec` stage times. Descriptions never state times, because they depend on the GPU. Before the first generation of a mode, the form estimates its time from `reference`. Sampling scales with steps × pixels × frames × CFG passes, and decoding with pixels × frames. Both are divided by the relative power of the local GPU, which is compute units × the maximum shader clock (`pp_dpm_sclk`) compared with the reference; the CU count comes from the iGPU name in the CPU model. After the first generation, the estimate uses this machine's own measurement instead. A mode without `reference` gets an estimate only after its first run.

Catalog entries (`models.json`, `presets.json`, `packs.json`) keep `name`/`description` in English and may carry UI translations in an `i18n` field:
```json
"i18n": { "uk": { "name": "…", "description": "…" }, "ru": { "name": "…", "description": "…" } }
```

Gated Hugging Face models are downloaded with the `HF_TOKEN` from `.env`.
