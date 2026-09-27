# Architecture

```
Browser ──HTTP──▶ web container (port 7860)             worker container (internal network only)
                   ├─ React UI                           ├─ job queue (source of truth, jobs.json)
                   ├─ API, auth, users                   ├─ sd-cli: stable-diffusion.cpp, -DSD_VULKAN=ON
                   ├─ catalog, modes, model downloads    ├─ progress parsing, segments, ffmpeg
                   ├─ serves results                     ├─ hardware info, system check
                   └─ ── HTTP /v1 + token ─────────────▶ └─ /dev/dri/renderD128 (Mesa RADV)
                                                                  │
                                                                  ▼
                                                            Radeon iGPU  ◀── GTT (shared RAM)
```

Code: `server/src/web` (the web container), `server/src/worker` (the worker), `server/src/common` (configuration and state files, used by both).

| Module | What |
|---|---|
| `web/index.js` | HTTP API, result files, the SPA |
| `web/auth.js` | users, sessions, CSRF, brute-force protection |
| `web/params.js` | validates a submission into job parameters and the mode snapshot (`spec`) |
| `web/models.js`, `web/safetensors.js` | catalog, resumable downloads, deletion, streaming model conversion |
| `web/presets.js` | generation modes and start templates |
| `web/worker.js` | worker API client with the last known state cached |
| `worker/queue.js` | the queue: one job on the GPU, sd-cli progress parsing, segments, finalization, drain |
| `worker/system.js`, `worker/diagnostics.js` | APU, iGPU (Vulkan), GTT, NPU, CPU and disk usage; the system check |
| `worker/index.js`, `worker/ctl.js` | the internal API and its command-line client for `update.sh` |

Both images are based on Debian 13 like the host, so Mesa/RADV versions match between the worker and the host. The engine runs as an `sd-cli` process inside the worker, so no Docker socket access is needed.

A new content type (upscaling, audio, LLM…) is added by:
- a mode with a new `kind` in `catalog/presets.json`;
- a command-building and finalization branch in `worker/queue.js` (`buildArgs`, `finalize*`);
- a section in the UI.

The queue, models, users and library are shared.

## Containers and updates

The split follows how often things change: the UI and API change often, the engine rarely.

- **web** has no GPU and holds no queue state. Restarting it only makes the browser reconnect; a running generation continues, and its progress picks up again. The web image does not contain sd.cpp, so it rebuilds in seconds.
- **worker** owns the GPU and the queue. Its image contains only `server/src/common` and `server/src/worker` and has no npm dependencies. After a change to the UI, the API or the catalog it therefore builds byte-identical, and Docker does not recreate it.
- **Jobs carry their mode:** when a job is created, the web container resolves the mode into a `spec` (model files by role, flags, `imageArgs`/`continueArgs`, preview) and sends it along with the parameters. The worker never reads the catalog, so catalog changes take effect with the next job without restarting the worker.
- **The internal API** (`/v1/state`, `/v1/jobs`, `/v1/jobs/:id[/cancel|/retry]`, `/v1/diagnostics`, `/v1/drain`, `/v1/health`) is only reachable on the compose network. Every route except `/v1/health` needs the token from `data/state/worker.token`, which whichever container starts first creates (mode 600). The API is versioned (`WORKER_API`); a mismatch shows up in the system check.
- **When the worker is unavailable** (restarting), the web container keeps serving the last known jobs and hardware info. New jobs get a clear 503 and the UI shows a banner. Logs are read directly from `data/state/logs`, so they stay viewable.
- **Drain:** `POST /v1/drain {seconds}` makes the worker finish the current job and start nothing new; new jobs still queue up. The drain is a lease: `update.sh` renews it every 15 s, so if the script dies the worker resumes by itself within two minutes.

`scripts/update.sh`:
1. builds both images;
2. restarts `web` immediately;
3. asks compose (`up --dry-run`) whether the worker would be recreated, i.e. its image or settings changed; if not, the worker is left alone;
4. otherwise it drains the worker, waits for the current job and restarts the worker. The new worker takes the queue from `jobs.json`.

The first run after the single-container version waits until that container has no running or queued job, then replaces it with the two containers.

## Data on the host

| Path (in the containers) | On the host | Contents | Written by |
|---|---|---|---|
| `/data/models` | `MODELS_PATH` (`./models`) | downloaded models, a separate volume | web (read-only in the worker) |
| `/data/output` | `OUTPUT_PATH` (`./output`) | generated videos and images, a separate volume | worker (read-only in web) |
| `/data/input/uploads` | `DATA_PATH/input/uploads` | uploaded init images | web; the worker removes unused ones |
| `/data/state/jobs.json` | `DATA_PATH/state` | history and queue | worker |
| `/data/state/users.json`, `sessions.json` | | users (scrypt) and sessions (token hashes only), mode 600 | web |
| `/data/state/models.local.json`, `presets.local.json` | | your own models and modes | you |
| `/data/state/{logs,thumbs,previews}` | | sd-cli logs, thumbnails, previews | worker |
| `/data/state/worker.token` | | web ↔ worker API token, mode 600 | the first container to start |
| `/data/state/cache` | | Mesa shader cache (`XDG_CACHE_HOME`) | worker |
| `/data/telemetry` | `DATA_PATH/telemetry` | optional generation telemetry, one JSON document per job ([telemetry.md](telemetry.md)) | worker |
| `/data/state/settings.json` | | settings changed in the UI (telemetry on/off, size limit) | web |

The images can be rebuilt and updated at will: none of this is stored in them. Both containers run as the host user (`PUID`/`PGID`), so the files belong to that user and the directories can be copied to another disk or server, see [moving.md](moving.md).

## Generation

1. `POST /api/jobs` (web) validates the mode and its models, normalizes the parameters and sends the job with its `spec` to the worker. Wan frame counts are rounded to 4n+1; AnimateDiff uses exactly `duration × nativeFps`; sizes are multiples of 16; seed −1 is replaced with a random one. A duration above one model pass becomes several parts (up to 2 minutes), with an optional prompt per part (`prompts`).
2. The queue runs `sd-cli` (images, video) or `audiocpp_cli` (audio) strictly one process at a time: the GPU and GTT are shared.
3. `sd-cli` output is parsed line by line:
   - stages: `generate_video` / `generating image` → sampling, `sampling completed` / `latent images completed` → decoding, `decode_first_stage completed` → saving;
   - progress lines `i/N - X s/it`;
   - weight loading;
   - saved files.
4. For long videos, ffmpeg extracts the last frame of a part, and the next part is generated from it as image-to-video with the mode's `continueArgs`, its own prompt and seed + part. Each new part is colour-matched to the previous one (`server/src/worker/color.js`: per-channel mean and spread → `lutrgb`), and the corrected last frame starts the next part.
5. Video: the MJPEG AVI(s) from `sd-cli` → an H.264 mp4 via ffmpeg (segments are concatenated without the duplicated seam frame). If the output FPS is above the native one (2× or 3×, at most 48), `minterpolate` synthesizes the frames. Images: the PNGs are renamed. A thumbnail is made for the library.
6. Audio: [audio.cpp](https://github.com/0xShug0/audio.cpp) (Apache-2.0, ggml, built with Vulkan in the worker image, backends loaded from `/opt/audiocpp`) runs once per job with the mode's `engine` (family, task, route): `--log` prints one line per phase, which sets the stage (planner and diffusion → sampling, VAE → decoding). The WAV becomes a 256 kbit/s MP3, `showwavespic` draws the waveform thumbnail and ffprobe measures the length (`audioSec`).
7. A soundtrack (`audio`, `audioStart`, `audioFade` on a video job) is muxed into the finished mp4 as AAC, cut or padded with silence to the clip's length.
8. If the worker is stopped during a generation (a power loss, a plain `docker compose up` over it), the current job is marked as failed and the rest of the queue continues. `update.sh` avoids this by draining first.

## API

Every route except sign-in requires a session. Mutating requests require the `X-Requested-With: genai-platform` header.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/auth/status` | anyone | `{setup: true}` while there are no users |
| POST | `/api/auth/setup` | anyone, while there are no users | create the first administrator |
| POST | `/api/auth/login` · `/logout` | anyone | sign in/out (cookie `gp_session`) |
| GET | `/api/auth/me` | anyone | the current user |
| POST | `/api/auth/password` | user | change your own password |
| GET/POST/DELETE | `/api/users[/:name[/password]]` | admin | user management |
| GET | `/api/state` | user | jobs, hardware info |
| GET | `/api/presets` | user | modes with availability and the list of missing models |
| GET | `/api/templates` | user | hidden start templates |
| GET | `/api/packs` | user | model packs for first-run setup |
| GET | `/api/diagnostics` | user | system check results (`?refresh=1` re-runs) |
| POST | `/api/jobs` | user | a new job (multipart: `image`, `mask`, `video` by the task, or `imageRef`/`videoRef` for earlier uploads; a video job may add a soundtrack: `audio` or `audioRef` with `audioStart` and `audioFade`, or `audioSource=video` for the sound of the uploaded video) |
| POST/DELETE | `/api/jobs/:id/cancel` · `/api/jobs/:id` | owner or admin | cancel / delete together with files |
| POST | `/api/jobs/:id/retry` | owner or admin | restart a failed or cancelled job with the same parameters and seed; it joins the end of the queue |
| GET | `/api/jobs/:id/log` · `/api/jobs/:id/download/:n` | user | sd-cli log, download a result |
| GET | `/api/models` | user | catalog, statuses, download progress, disk space |
| POST | `/api/models/download` `{ids}` · `/api/models/:id/cancel` | admin | download / cancel |
| DELETE | `/api/models/:id` | admin | delete (refused while the model is in use) |
| POST | `/api/cutout` | user | multipart `image`, or `imageRef`, or `jobId` + `index`: the subject mask as a grayscale PNG (BiRefNet lite via ONNX Runtime on the CPU; one at a time) |
| POST | `/api/jobs/:id/as-input` | user | `{index}`: copies one image of a finished job into the uploads and returns its name, for a follow-up task |
| POST | `/api/jobs/:id/upscale` | user | `{index}`: upscales one image of a finished job ×4 as a new job (at most 2048 px on the long side) |
| GET/PUT | `/api/settings` | admin | platform settings (telemetry on/off and size limit; the prompt assistant's Ollama address, model, on/off) |
| GET | `/api/settings/ollama?url=` | admin | the Ollama server's version and installed models, for choosing one in Settings |
| GET | `/api/prompt/status` | user | whether the "Improve with AI" button can work (enabled, server reachable, model installed; checked at most every 30 s) |
| POST | `/api/prompt/enhance` | user | `{presetId, prompt, width, height, duration, hasImage}` → `{prompt}`: the idea rewritten by the Ollama model for the mode |
| POST | `/api/prompt/storyboard` | user | `{presetId, prompt, parts, partSeconds, hasImage}` → `{prompts, subject, style, actions}`: a scene per part of a long video, with the subject and style the same in every part |
| GET/DELETE | `/api/telemetry` · `/api/telemetry/export` · `/api/telemetry/:name` | admin | list, download all as one JSON array, download one, delete all |
| GET | `/files/{output,thumbs,previews,uploads}/…` | user | files (with Range support for video) |

## System check

`server/src/worker/diagnostics.js` checks the environment from inside the worker and returns only ids, statuses (`ok`, `warn`, `fail`, `info`) and values; the UI (`web/src/System.jsx`) owns the texts and advice so they can be translated.

| Check | Fails / warns when |
|---|---|
| `worker` | the web container cannot reach the worker (fail) or their API versions differ (warn); added by the web container |
| `gpu` | Vulkan does not work or only sees llvmpipe (fail); the driver is not RADV (warn) |
| `render-node` | `/dev/dri/renderD128` is missing or not accessible (fail) |
| `cpu`, `gpu-arch` | not a Ryzen AI APU / not RDNA 3.5 (warn) |
| `kernel` | older than 6.10 (warn) |
| `gtt` | GTT is well below ¾ of RAM (warn, with the computed kernel parameters) |
| `ttm` | the TTM limit (`ttm.pages_limit`) is below the GTT size: buffers above it are swapped out (warn, with the kernel parameters) |
| `vulkan-heap` | the largest DEVICE_LOCAL heap is below 80 % of GTT, i.e. the unified heap is off (warn) |
| `video-memory` | GTT below the ~22 GB Wan 2.2 needs (warn) |
| `swap` | no swap (info) |
| `disk` | < 30 GB (warn) or < 10 GB (fail) free for models |
| `engine`, `ffmpeg` | `sd-cli` or ffmpeg does not run (fail) |
| `npu` | informational only |

Results are cached for a minute (`GET /api/diagnostics?refresh=1` forces a re-run). `/api/state` carries a short `health` summary for the dot on the Admin menu and the admin notice; modes with `minGtt` show a warning in the form when GTT is smaller.

## Web UI

React (Vite) without a component library; plain CSS in `web/src/styles.css`.

- **Structure:** two sections, **Create** (images and video, switched inside the workspace) and **Library**; administration (Models, Users, System, Settings) under one Admin menu. The header carries a GPU status pill (idle, or the running job's progress and time left, the queue length, overheating) that opens the queue as a side panel. One notice slot shows the most important message (no connection, engine unavailable, a failed system check, an engine update pending).
- **Create:** the form (task, inputs, prompt, model cards, format, More settings, a sticky footer with the time estimate and the Generate button) next to the running job or the latest result with follow-up actions, a one-line queue summary and recent results. Follow-ups copy the result into the uploads (`POST /api/jobs/:id/as-input`) and open the form with it.
- **Themes:** design tokens as CSS custom properties; dark on `:root`, light under `[data-theme="light"]`. `web/src/theme.js` keeps the choice (dark, light, system) in `localStorage`; an inline script in `index.html` applies it before the first paint. Red is used only for failures, amber for optional extras.
- **Sizes:** tuned for 13" laptops (1280–1440 × 800–900: a 380 px form column that scrolls on its own, denser cards) and phones (one column, a fixed Generate bar at the bottom, two results per row, the viewer full screen).

## Internationalization

- The UI defaults to English; Ukrainian and Russian are additional. The choice is stored in the browser (`localStorage`, key `gp_lang`).
- `web/src/i18n.js` implements a gettext-style `t()`: the English text is the key, `web/src/locales/uk.js` and `ru.js` hold the translations, a missing translation falls back to English, `{name}` placeholders are substituted.
- Server error messages are plain English. The UI translates them through the same dictionaries (`tError()`), including messages with a variable tail matched by their `Prefix:`.
- Catalog entries carry optional translations in an `i18n` field; the UI reads them with `loc(entry, field)`.
- `node scripts/i18n-keys.mjs` lists every key used in the UI and on the server and fails if the `uk` or `ru` dictionary misses one.

## Security

- **Passwords:** scrypt (N=16384, r=8, p=1) with a salt, constant-time comparison, at least 8 characters.
- **Sessions:** a random 256-bit token in an `HttpOnly; SameSite=Lax` cookie (`Secure` with `COOKIE_SECURE=true`). Only the SHA-256 of the token is stored on disk. Sessions last `SESSION_DAYS` days (30 by default). Changing a password signs out the user's other sessions.
- **CSRF:** the SameSite cookie plus a mandatory non-standard header on mutating requests (a browser will not send it cross-site without a CORS grant).
- **Brute force:** after 10 failed sign-ins from one IP, or 30 for one account from any addresses, sign-in is blocked for 15 minutes. Password checks run asynchronously and cost the same for unknown users. Behind a proxy, set `TRUST_PROXY=true`: exactly one proxy hop is trusted for the client IP; bind the port to the proxy only (`BIND_ADDR=127.0.0.1`) so nobody can reach the platform past it.
- **First administrator:** while there are no users, the UI shows registration and `POST /api/auth/setup` creates the administrator and opens a session. Once any user exists the route answers 409 and only sign-in remains. Until then anyone on the network can see the form, so create the administrator right after the first start.
- **Permissions:** administrators download and delete models and manage users and other users' jobs. Users generate content and manage their own jobs. Results are visible to every signed-in user.
- **Files:** results, thumbnails and uploads are served to signed-in users only, with `Content-Security-Policy: default-src 'none'; sandbox`, so a file opened directly cannot run scripts. Upload names are generated by the server and the extension comes from the file's content: only PNG, JPEG and WebP up to 25 MB are kept.
- **Limits:** prompts up to 4000 characters, at most 20 queued jobs per user, bounded multipart fields.
- **Perimeter:** the platform is meant for a local network. Internet access needs an HTTPS proxy. The port can be bound to a specific interface with `BIND_ADDR`.
