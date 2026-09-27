# Models and modes

The platform does not keep models in the image. They are listed with their sources in [catalog/models.json](../catalog/models.json) and downloaded into `MODELS_PATH` on the host (`./models` by default). On a cold start the directory is empty: the Models section or the Download button in a mode's form fetches what is missing. Downloads resume after interruptions, sizes are verified, and files are converted into the stable-diffusion.cpp format when needed. A model can be deleted from the same page unless the current generation uses it.

Only administrators can download and delete models. On first start, while no mode is usable, the administrator sees the model pack picker ([catalog/packs.json](../catalog/packs.json)): the required base, packs recommended for this hardware, sizes and free disk space.

## Default catalog

| id | Model | Used for | Size | License |
|---|---|---|---|---|
| `realistic-vision-v6` | [Realistic Vision 6.0 B1](https://huggingface.co/SG161222/Realistic_Vision_V6.0_B1_noVAE) (SD 1.5, fp16) | images, AnimateLCM, AnimateDiff | 2.0 GB | CreativeML OpenRAIL-M |
| `sd-vae-ft-mse` | [SD VAE ft-MSE 840000](https://huggingface.co/stabilityai/sd-vae-ft-mse-original) | VAE for SD 1.5 | 0.3 GB | MIT |
| `realvisxl-v5` | [RealVisXL V5.0](https://huggingface.co/SG161222/RealVisXL_V5.0) (SDXL, fp16) | SDXL images | 6.5 GB | CreativeML OpenRAIL++-M |
| `realvisxl-v5-lightning` | [RealVisXL V5.0 Lightning](https://huggingface.co/SG161222/RealVisXL_V5.0_Lightning) (SDXL, fp16) | fast SDXL images (5–8 steps) | 6.5 GB | CreativeML OpenRAIL++-M |
| `sdxl-vae-fp16-fix` | [SDXL VAE fp16 fix](https://huggingface.co/madebyollin/sdxl-vae-fp16-fix) | VAE for SDXL | 0.3 GB | MIT |
| `z-image-turbo-q8` | [Z-Image Turbo](https://huggingface.co/leejet/Z-Image-Turbo-GGUF), GGUF Q8_0 | Z-Image images | 6.1 GB | Apache-2.0 |
| `qwen3-4b-instruct-q8` | [Qwen3 4B Instruct 2507](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF), GGUF Q8_0 | Z-Image text encoder | 4.0 GB | Apache-2.0 |
| `flux-ae` | FLUX autoencoder (from [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo); the FLUX.1-schnell repository requires signing in) | VAE for Z-Image | 0.3 GB | Apache-2.0 |
| `animatelcm-mm` | [AnimateLCM](https://huggingface.co/wangfuyun/AnimateLCM) — motion module | fast video | 0.9 GB | not stated on the model card |
| `animatelcm-lora` | AnimateLCM — LoRA | fast video | 0.1 GB | not stated on the model card |
| `animatediff-v3-mm` | [AnimateDiff v3](https://huggingface.co/guoyww/animatediff) — motion module (repack by [conrevo](https://huggingface.co/conrevo/AnimateDiff-A1111)) | detailed video | 0.8 GB | Apache-2.0 |
| `animatediff-v3-adapter` | AnimateDiff v3 Domain Adapter LoRA | detailed video | 0.1 GB | Apache-2.0 |
| `wan22-ti2v-5b-q8` | [Wan 2.2 TI2V 5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B), GGUF Q8_0 ([QuantStack](https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF)) | video with coherent motion | 5.0 GB | Apache-2.0 |
| `wan22-vae` | Wan 2.2 VAE | Wan 2.2 | 1.3 GB | Apache-2.0 |
| `umt5-xxl-q8` | [UMT5-XXL encoder](https://huggingface.co/city96/umt5-xxl-encoder-gguf), GGUF Q8_0 | Wan text encoder | 5.6 GB | Apache-2.0 |
| `wan21-t2v-1.3b` | [Wan 2.1 T2V 1.3B](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B) | lightweight Wan (experimental) | 2.6 GB | Apache-2.0 |
| `wan21-vae` | Wan 2.1 VAE | Wan 2.1 | 0.2 GB | Apache-2.0 |
| `wan21-vace-1.3b` | [Wan 2.1 VACE 1.3B](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged), fp16 (the GGUF from calcuis/wan-1.3b-gguf does not load in sd-cli: its 5-dimensional patch embedding is rejected by ggml) | putting a person into a video, video → video | 4.0 GB | Apache-2.0 |
| `birefnet-lite` | [BiRefNet lite](https://huggingface.co/ZhengPeng7/BiRefNet_lite), ONNX ([onnx-community](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX)) | background removal | 214 MB | MIT |
| `realesrgan-x4plus` | [Real-ESRGAN x4plus](https://github.com/xinntao/Real-ESRGAN) | upscaling ×4 | 64 MB | BSD-3-Clause |
| `ace-step-15-turbo-q8` | [ACE-Step 1.5](https://huggingface.co/ACE-Step/Ace-Step1.5) turbo, one GGUF Q8_0 with the planner LM, text encoder, DiT and VAE ([audio-cpp/audio.cpp-gguf](https://huggingface.co/audio-cpp/audio.cpp-gguf)) | music | 5.8 GB | MIT |
| `stable-audio-3-small-sfx-q8` | [Stable Audio 3 Small SFX](https://huggingface.co/stabilityai/stable-audio-3-small-sfx), GGUF Q8_0 (audio-cpp) | sound effects | 1.6 GB | Stability AI Community License: free under USD 1M yearly revenue, attribution "Powered by Stability AI"; the Gemma text encoder falls under the Gemma Terms of Use |
| `supertonic-3-f16` | [Supertonic 3](https://huggingface.co/Supertone/supertonic-3), GGUF F16 (audio-cpp) | speech | 298 MB | BigScience OpenRAIL-M (its use restrictions apply) |

Licenses are taken from the Hugging Face model cards. Check them yourself before using results commercially.

## Modes (presets)

A mode is a ready-made combination of models and parameters, described in [catalog/presets.json](../catalog/presets.json).

| Mode | Kind | Models | Defaults | Time on a Radeon 890M |
|---|---|---|---|---|
| Realistic Vision 6 · photo | image | RV6 + VAE | 512×768, 25 steps, dpm++2m karras, CFG 5.5 | ~40 s per image |
| RealVisXL V5 · SDXL photo | image | RealVisXL V5 + SDXL VAE | 1024×1024, 30 steps, dpm++2m karras, CFG 5 | ~2 min 40 s |
| RealVisXL V5 Lightning · fast SDXL | image | RealVisXL V5 Lightning + SDXL VAE | 1024×1024, 6 steps, dpm++2m karras, CFG 1.5 | **~48 s** |
| Z-Image Turbo · photo | image | Z-Image Turbo + FLUX VAE + Qwen3 4B | 1024×1024, 8 steps, euler, CFG 1 | ~2 min 50 s |
| AnimateLCM · Realistic Vision | video | RV6 + VAE + AnimateLCM + LoRA | 512×512, 16 frames (2 s at 8 fps → 24 fps), 6 steps, lcm, CFG 1 | **~2.5 min** |
| AnimateDiff v3 · Realistic Vision | video | RV6 + VAE + AnimateDiff v3 + adapter | 512×512, 16 frames, 20 steps, euler, CFG 8 | ~16 min |
| Wan 2.2 TI2V 5B | video | Wan 2.2 5B + VAE + UMT5 | 832×480, 49 frames at 24 fps, 25 steps | hours (meant for Strix Halo) |
| Wan 2.1 T2V 1.3B | video | Wan 2.1 1.3B + VAE + UMT5 | 832×480, 16 fps | not measured (experimental) |
| Real-ESRGAN · upscale ×4 | image | Real-ESRGAN x4plus | the photo's size ×4 | not measured yet |
| Wan 2.1 VACE 1.3B | video | VACE 1.3B + Wan 2.1 VAE + UMT5 | 832×480, 16 fps, one pass up to 5 s, EasyCache | ~17 min per 2 s clip (experimental) |
| ACE-Step 1.5 · music | audio | ACE-Step 1.5 turbo | 30 s (10 s – 4 min), 8 steps; lyrics by the model, yours or none | **~35 s** per 30 s track |
| Stable Audio 3 Small · sound effects | audio | Stable Audio 3 Small SFX | 8 s (1–30 s), 8 steps | **~5 s** |
| Supertonic 3 · speech | audio | Supertonic 3 | 10 voices, 31 languages, speed 0.7–1.5 | **~4 s** for 10 s of speech |

The Draft / Standard / High quality levels set the number of steps, which each mode defines itself (see `defaults.quality`).

### Tasks

The form starts with the task, and the mode list shows only the modes that fit it:

| Task | Kind | Inputs | How it runs |
|---|---|---|---|
| **Create** | image, video | a description | text → image or video |
| **Rework a photo** | image | a photo, "how much to change" | image → image (`-i`, `--strength`); the size follows the photo's aspect ratio |
| **Change a part** | image | a photo, a part painted over it with the brush, "how much to change" | inpainting: `--mask` (white is repainted, black kept); afterwards ffmpeg pastes the original photo back outside the widened, feathered mask, so the rest keeps its sharpness and no seam of the 8 px latent grid shows |
| **Remove background** | image | a photo | BiRefNet lite (ONNX) on the CPU in the web container, no job and no GPU queue: `POST /api/cutout` returns the subject mask, the browser shows the cut-out over a checkerboard, "keep" and "remove" brushes paint on its transparency, and the PNG is exported in the browser (~3–7 s per photo) |
| **Upscale** | image | a photo up to 2048 px on the long side | Real-ESRGAN x4plus in sd-cli's `upscale` mode: 4× the size, no prompt; also a button in the viewer |
| **Animate a photo** | video | a photo | the photo is the first frame (image → video) |
| **Put a person in** | video | a photo of a person or object, a description | Wan 2.1 VACE: the photo is a reference (`-i`), fitted and centred on a white canvas the way VACE prepares references (sd-cli alone would crop it) |
| **Music** | audio | a style description; lyrics written by the model, your own (`[verse]`, `[chorus]`…) or none; a length | ACE-Step 1.5 through audio.cpp: the planner LM writes the lyrics and the structure, the DiT renders 48 kHz stereo, the VAE decodes it |
| **Sound effect** | audio | an English description, a length | Stable Audio 3 Small SFX through audio.cpp, 44.1 kHz stereo |
| **Speech** | audio | a text, a voice, its language, a speed | Supertonic 3 through audio.cpp; the language must be the text's |
| **Change a video** | video | a video, optionally a reference photo, a description | Wan 2.1 VACE video → video: ffmpeg turns the start of the video into control frames at the job's fps and size (`--control-video`), as contours (VACE's scribble condition: denoised, lightly blurred, edge-detected; keeps the motion and shapes) or grayscale (VACE's colorization: keeps almost everything, the prompt changes the colors); a portrait upload switches the size to portrait |

Every video can also get a **soundtrack**: an uploaded audio file (MP3, WAV, OGG, FLAC, M4A or a video with sound) from a chosen start point, an audio result of the platform ("Use as the sound of a video" in the viewer), or, for Change a video, the sound of the uploaded video. The worker cuts or pads it to the clip's exact length, fades it in and out and muxes it as AAC; if that fails the clip is kept silent with a warning.

Photos are turned upright by their EXIF orientation and scaled to at most 2048 px in the browser before upload; the server refuses photos above 50 megapixels. VACE is slow on the 890M: ~2 min per step at 832×480×33 frames, about 45 minutes per 2 s clip.

A mode lists its tasks in `tasks`; without it they follow from `image`: `none` means Create only, `optional` adds the photo tasks (Rework and Change a part for images, Animate for video), `required` leaves only them. The prompt assistant knows the task: for Change a part it describes only the painted area, for Change a video the new look rather than a new motion.

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

- **Length of one part** (More settings → Expert): empty means the trained length. Up to `maxFrames` is possible, but beyond the training length the motion module loses the subject. Measured on the reference machine: AnimateDiff v3 with 32-frame passes at 768×512 produced only a sand-and-water texture for "a young woman on a windy beach", while 16 frames at 512×512 gave exactly that scene.
- **Resolution:** sizes the mode was tested at are marked ✓ (`recommendedResolutions`); other sizes show a warning that the result may not follow the prompt. AnimateDiff v3 was verified at 512×512 and 768×512 with 16-frame passes; an 8 s clip from four 2 s passes kept the same person and scene, with the contrast growing slightly from pass to pass.

## Prompt assistant

The "✦ Improve with AI" button in the prompt box sends the text to a language model on an [Ollama](https://ollama.com) server and replaces it with a prompt written for the selected mode; "Undo" brings the original back. The web container calls Ollama (`POST /api/chat` with a JSON schema, `keep_alive: 1m` so the model leaves GPU memory soon after), the worker is not involved.

Set it up in **Settings → Prompt assistant**: the server address (`http://host.docker.internal:11434` is the Docker host, where Ollama usually runs; `docker-compose.yml` maps that name for the web container) and the model. Recommended: `dolphin-llama3` (8B), installed with `ollama pull dolphin-llama3`. On the reference machine it answers in 5–8 s and kept the meaning of every Russian test description (a lighthouse on a cliff at sunset, a cat on a windowsill in the rain, a girl in a red dress in an autumn alley). `dolphin-phi` (2.7B) answers in 2–4 s but turned the same descriptions into other scenes (no lighthouse, no rain, snow in autumn); it is usable with English descriptions. A fast alternative is `huihui_ai/qwen2.5-abliterate:3b` (Qwen 2.5 3B without refusals, 1.9 GB): 3–7 s, understood all the Russian descriptions, with simpler wording and an occasional untranslated word. The example exchange is marked as format only, since small models otherwise copy its objects (flags and snow turned up in unrelated prompts). The button is disabled while the assistant is off, the server is unreachable or the model is not installed.

The model acts as a prompt engineer for the mode. It is told the mode, its models, the size, the clip length and whether a start image is used, gets one worked example, and first writes `idea_en`, an exact English translation of the idea, which keeps a small model on topic. The rest depends on how the mode reads prompts:

- **tags** (Stable Diffusion 1.5 with CLIP: Realistic Vision, AnimateLCM, AnimateDiff): the model fills short phrases for `subject`, `action`, `setting`, `lighting`, `camera`. The server assembles them in this order, drops duplicates, quality words and anything not visual (sounds, smells), keeps about 45 words, since CLIP reads only the first 75 tokens, and adds the mode's quality tags;
- **natural** (Wan with a T5 encoder): 2–4 sentences about the subject, the motion over time, the setting, the light and the camera, one continuous shot, followed by the mode's quality sentence.

The quality tags are `promptQuality` in `catalog/presets.json`: `{"prefix": "RAW photo", "suffix": "8k uhd, dslr, soft lighting, high quality, film grain, Fujifilm XT3"}` for Realistic Vision (the model author's recipe), a cinematic suffix for the AnimateDiff modes and a sentence for Wan. Your own modes can set their own.

The style follows from the text encoder (`t5xxl` among the mode's models means natural); a mode can set it explicitly with `"promptStyle": "tags"` or `"natural"` in `catalog/presets.json` or `data/state/presets.local.json`. The mode's `promptSuffix` (LoRA tags) is still appended by the worker.

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

`reference` is a real measurement of the mode on the reference machine (Radeon 890M, 16 CU, 2900 MHz; see [benchmarks.md](benchmarks.md)): `width`, `height`, `frames` (the image count for images), `steps`, `cfg`, and the `samplingSec`, `decodeSec`, `otherSec` stage times. Descriptions never state times, because they depend on the GPU. Before the first generation of a mode, the form estimates its time from `reference`. Sampling scales with steps × pixels × frames × CFG passes, and decoding with pixels × frames. Both are divided by the relative power of the local GPU, which is compute units × the maximum shader clock (`pp_dpm_sclk`) compared with the reference; the CU count and the maximum clock come from the driver (the KFD topology). After the first generation, the estimate uses this machine's own measurement instead. A mode without `reference` gets an estimate only after its first run.

Catalog entries (`models.json`, `presets.json`, `packs.json`) keep `name`/`description` in English and may carry UI translations in an `i18n` field:
```json
"i18n": { "uk": { "name": "…", "description": "…" }, "ru": { "name": "…", "description": "…" } }
```

Gated Hugging Face models are downloaded with the `HF_TOKEN` from `.env`.
