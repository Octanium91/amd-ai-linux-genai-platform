# Troubleshooting

Start with the **System** section of the web UI (administrators): it runs the checks below inside the container and shows advice with copyable commands for each problem. The same checks are logged at startup (`docker compose logs worker | grep diagnostics`). On the host, `./scripts/setup.sh` checks packages, groups and GTT before the first start.

## Vulkan only sees `llvmpipe`

`vulkaninfo --summary` on the host shows `llvmpipe` instead of `RADV`:

- The user is not in the `render` group: `sudo usermod -aG render,video $USER` and log in again. The container is not affected, it gets the groups through `group_add`.
- `mesa-vulkan-drivers` or `firmware-amd-graphics` is missing (on Debian the latter is in `non-free-firmware`): `./scripts/setup.sh --install`.
- The kernel is too old: RDNA 3.5 needs 6.10+.

Inside the container, run `./scripts/check-gpu.sh`: it must report `RADV GFX115x`.

## The Vulkan heap is 512 MB instead of GTT

If `check-gpu.sh` shows a heap the size of the UMA carve-out, the `radv_enable_unified_heap_on_apu` option was not applied. Check that it is in `environment` in `docker-compose.yml` and that `config/drirc` is mounted. The Mesa warning `option value ... ignored` is expected here: the environment variable takes precedence over drirc.

## Heavy jobs are slow, the GPU is often idle and the host swaps

If the telemetry (or `vmstat 5`) shows constant swap-in/swap-out during a job while plenty of RAM is free, and `hw.gpu.utilization` stays well below 100 %, the TTM limit is smaller than the GTT: `cat /sys/module/ttm/parameters/pages_limit` × 4096 bytes must be at least `mem_info_gtt_total`. With only `amdgpu.gttsize` set, TTM keeps at most half of the RAM resident and swaps the rest. Add `ttm.pages_limit` and `ttm.page_pool_size` next to `amdgpu.gttsize` (the System section shows the values), update GRUB and reboot. On the reference machine this made an AnimateDiff job with a ~16 GB working set run about 2.5× slower.

## GTT is small

Check `cat /sys/class/drm/card*/device/mem_info_gtt_total`. If it is about half of the RAM, enlarge GTT with a kernel parameter, see [hardware.md](hardware.md#memory-uma-gtt-and-the-vulkan-heap).

## Out of memory (OOM) and crashes

- One generation at a time — the queue guarantees it. Do not run other heavy GPU services next to it (for example an LLM in Ollama).
- For Wan use GGUF Q8_0/Q5 and the Q8_0 text encoder; start with 832×480 and 2 seconds.
- The modes already include `--offload-to-cpu`, `--diffusion-fa` (without flash attention it is 2× slower and hungrier) and, for Wan, `--vae-tiling`.
- Enable swap or zram on the host: GTT and RAM are the same physical memory.

## Wan video decoding takes very long

On a Radeon 890M, tiled Wan VAE decoding takes tens of minutes, sometimes longer than sampling itself. That is expected on this hardware. Use AnimateLCM for quick results.

## `tensor ... pos_encoder.pe not in model metadata`

The AnimateDiff motion module is in a layout sd.cpp does not understand (for example the original AnimateLCM `.ckpt`). Download the module through the Models section: the platform fetches the right file and converts it.

## A model download was interrupted

Click Download again: the download resumes where it stopped (a `.part` file in `MODELS_PATH`). If the size does not match, the file has to be downloaded again: delete the model and start the download over.

## Forgot the administrator password

If there is another administrator, they can change the password in the Users section. Otherwise reset the users: the platform will offer to create the administrator again. Jobs, results and models are kept.

```bash
rm data/state/users.json data/state/sessions.json
docker compose restart web
```

Only the web container restarts, so a running generation is not affected.

## "The generation engine is restarting or unavailable"

The web container cannot reach the worker. For a few seconds during `./scripts/update.sh` this is expected. If it stays, check the worker: `docker compose ps` and `docker compose logs --tail 50 worker`. Queued jobs are kept in `data/state/jobs.json`, and the worker continues them once it is up.

## `EACCES: permission denied` in the logs

The container runs as `PUID`/`PGID` from `.env` and cannot write files owned by another user (left by an older root-running version or copied with `sudo`). Run `./scripts/setup.sh --install`: it fixes the ownership. See [moving.md](moving.md).

## stable-diffusion.cpp regressions

The engine version is pinned in `SD_CPP_REF` (`.env`, the tested commit `88411ef` by default). After changing it, rebuild the worker image (`docker compose build --no-cache worker`, then `./scripts/update.sh`) and run short jobs in every mode: Vulkan video regressions have happened between builds (for example [#1976](https://github.com/leejet/stable-diffusion.cpp/issues/1976)).

## A UI string is not translated

Run `node scripts/i18n-keys.mjs`: it lists keys missing from `web/src/locales/uk.js` or `ru.js`. Add the translation and rebuild the image.

## Testing changes to the worker

`./tests/worker/run.sh` runs the job queue against a fake `sd-cli` in a throwaway container of the worker image, without a GPU and without touching a running deployment. It covers a two-segment video, cancelling at a segment boundary, restarting a job, deleting during finalization, leftover temporary files and a damaged `jobs.json`. Build the image first (`docker compose build worker`).
