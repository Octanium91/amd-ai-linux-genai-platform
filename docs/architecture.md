# Architecture

```
Browser ──HTTP──▶ genai-platform (a single container)
                   ├─ Node.js server (server/src)
                   │   ├─ auth.js         users, sessions, CSRF, brute-force protection
                   │   ├─ jobs.js         queue: one job on the GPU, sd-cli progress parsing, segments
                   │   ├─ models.js       catalog, resumable downloads, deletion
                   │   ├─ safetensors.js  streaming model conversion
                   │   ├─ presets.js      generation modes and start templates
                   │   └─ system.js       APU, iGPU (Vulkan), GTT, NPU, CPU and disk usage
                   ├─ React UI (web/, built into the image)
                   └─ sd-cli — stable-diffusion.cpp built with -DSD_VULKAN=ON
                           │
                           ▼  /dev/dri/renderD128 (Mesa RADV)
                     Radeon iGPU  ◀── GTT (shared RAM)
```

There is one container: the generation engine runs as an `sd-cli` process next to the server, so no Docker socket access is needed. The image is based on Debian 13 like the host, so Mesa/RADV versions match between the container and the host.

A new content type (upscaling, audio, LLM…) is added by:
- a mode with a new `kind` in `catalog/presets.json`;
- a command-building and finalization branch in `jobs.js` (`buildArgs`, `finalize*`);
- a section in the UI.

The queue, models, users and gallery are shared.

## Data on the host

| Path (in the container) | On the host | Contents |
|---|---|---|
| `/data/models` | `MODELS_PATH` (`./models`) | downloaded models, a separate volume |
| `/data/output` | `OUTPUT_PATH` (`./output`) | generated videos and images, a separate volume |
| `/data/input/uploads` | `DATA_PATH/input/uploads` | uploaded init images |
| `/data/state/jobs.json` | `DATA_PATH/state` | history and queue |
| `/data/state/users.json`, `sessions.json` | | users (scrypt) and sessions (token hashes only), mode 600 |
| `/data/state/models.local.json`, `presets.local.json` | | your own models and modes |
| `/data/state/{logs,thumbs,previews}` | | sd-cli logs, thumbnails, previews |

The image can be rebuilt and updated at will: none of this is stored in it.

## Generation

1. `POST /api/jobs` validates the mode and its models, normalizes the parameters and queues the job. Wan frame counts are rounded to 4n+1; AnimateDiff uses exactly `duration × nativeFps`; sizes are multiples of 16; seed −1 is replaced with a random one. A duration above the model limit becomes two segments.
2. The queue runs `sd-cli` strictly one process at a time: the GPU and GTT are shared.
3. `sd-cli` output is parsed line by line:
   - stages: `generate_video` / `generating image` → sampling, `sampling completed` / `latent images completed` → decoding, `decode_first_stage completed` → saving;
   - progress lines `i/N - X s/it`;
   - weight loading;
   - saved files.
4. For extra-length videos, ffmpeg extracts the last frame of a segment, and the next segment is generated from it as image-to-video with the mode's `continueArgs`.
5. Video: the MJPEG AVI(s) from `sd-cli` → an H.264 mp4 via ffmpeg (segments are concatenated without the duplicated seam frame). If the output FPS is above the native one, `minterpolate` synthesizes the frames. Images: the PNGs are renamed. A thumbnail is made for the gallery.
6. If the container restarts during a generation, the current job is marked as failed and the rest of the queue continues.

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
| POST | `/api/jobs` | user | a new job (multipart, optional `image`) |
| POST/DELETE | `/api/jobs/:id/cancel` · `/api/jobs/:id` | owner or admin | cancel / delete together with files |
| GET | `/api/jobs/:id/log` · `/api/jobs/:id/download/:n` | user | sd-cli log, download a result |
| GET | `/api/models` | user | catalog, statuses, download progress, disk space |
| POST | `/api/models/download` `{ids}` · `/api/models/:id/cancel` | admin | download / cancel |
| DELETE | `/api/models/:id` | admin | delete (refused while the model is in use) |
| GET | `/files/{output,thumbs,previews,uploads}/…` | user | files (with Range support for video) |

## System check

`server/src/diagnostics.js` checks the environment from inside the container and returns only ids, statuses (`ok`, `warn`, `fail`, `info`) and values; the UI (`web/src/System.jsx`) owns the texts and advice so they can be translated.

| Check | Fails / warns when |
|---|---|
| `gpu` | Vulkan does not work or only sees llvmpipe (fail); the driver is not RADV (warn) |
| `render-node` | `/dev/dri/renderD128` is missing or not accessible (fail) |
| `cpu`, `gpu-arch` | not a Ryzen AI APU / not RDNA 3.5 (warn) |
| `kernel` | older than 6.10 (warn) |
| `gtt` | GTT is well below ¾ of RAM (warn, with the computed kernel parameters) |
| `vulkan-heap` | the largest DEVICE_LOCAL heap is below 80 % of GTT, i.e. the unified heap is off (warn) |
| `video-memory` | GTT below the ~22 GB Wan 2.2 needs (warn) |
| `swap` | no swap (info) |
| `disk` | < 30 GB (warn) or < 10 GB (fail) free for models |
| `engine`, `ffmpeg` | `sd-cli` or ffmpeg does not run (fail) |
| `npu` | informational only |

Results are cached for a minute (`GET /api/diagnostics?refresh=1` forces a re-run). `/api/state` carries a short `health` summary for the header badge and the admin banner; modes with `minGtt` show a warning in the form when GTT is smaller.

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
- **Brute force:** after 10 failed sign-ins from one IP, sign-in is blocked for 15 minutes. Behind a proxy, set `TRUST_PROXY=true` so the real IP is used.
- **First administrator:** while there are no users, the UI shows registration and `POST /api/auth/setup` creates the administrator and opens a session. Once any user exists the route answers 409 and only sign-in remains. Until then anyone on the network can see the form, so create the administrator right after the first start.
- **Permissions:** administrators download and delete models and manage users and other users' jobs. Users generate content and manage their own jobs. Results are visible to every signed-in user.
- **Files:** results, thumbnails and uploads are served to signed-in users only. Upload names are generated by the server; only images up to 25 MB are accepted.
- **Perimeter:** the platform is meant for a local network. Internet access needs an HTTPS proxy. The port can be bound to a specific interface with `BIND_ADDR`.
