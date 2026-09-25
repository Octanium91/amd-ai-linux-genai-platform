# Generation telemetry

Optional and off by default: **Settings → Generation telemetry** (administrators). When it is on, the worker writes one JSON document per job to `DATA_PATH/telemetry/`. The documents never leave the machine; an administrator downloads them from the Settings page, one at a time or all at once as a single JSON array (`GET /api/telemetry/export`).

The size limit (250 MB by default) applies to the whole directory: after each write the oldest documents are deleted until the total fits. One document is small and does not grow with the job's length: an image job takes about 15 KB, an 8-hour video a few hundred KB, because the time series is downsampled (see below).

Names follow the [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/) where one exists (`os.*`, `host.*`, `process.runtime.*`, `system.*`, `hw.*`). Units are UCUM: fractions `0..1` for utilization and pressure, bytes, hertz, watts, degrees Celsius, seconds.

## Document layout

File name: `<job created, local time>_<job id>[_r<retry>].json`. Top-level fields:

| Field | Contents |
|---|---|
| `schema` | `genai-platform.telemetry/1` |
| `complete` | `false` while the job runs (a checkpoint is written every 5 minutes), `true` at the end; a job interrupted by a restart is closed with `interrupted: true` |
| `resource` | the system at the job start, see below |
| `job` | the job as the worker knows it: id, user, status, error/warning, timestamps, `params` (mode, prompt, negative, size, steps, CFG, sampler, seed, frames, fps, segments…), `spec` (model files by role with sizes, flags), stage timestamps, result files with sizes |
| `phases` | one entry per stage and command: `name` (`prepare`, `sampling`, `decoding`, `saving`, `ffmpeg.last_frame`, `ffmpeg.encode`, `ffmpeg.encode+interpolate`, `ffmpeg.thumbnail`), `segment`, `startedAt`, `endedAt`, `durationSec`, and `metrics`: for every metric `{min, avg, max, n}` over the phase |
| `series` | `{startedAt, bucketSec, fields, points}`: bucket averages as rows, `t` in seconds from the start |
| `steps` | `{fields, rows}`: every sampling step as `[segment, stage, step, total, secondsPerStep, t]` |
| `commands` | every `sd-cli` and `ffmpeg` run: program, phase, full arguments, exit code, signal, start/end, error tail |
| `events` | reserved for notable events |

### `resource`

| Key | Source |
|---|---|
| `service.name`, `service.component`, `service.version` | the platform; `service.version` is a hash of the worker's sources |
| `worker.api` | the web ↔ worker API version |
| `process.runtime.name`, `.version`, `.description` | `node`, its version, V8 and libuv versions (another runtime reports its own) |
| `deployment.mode`, `container.image.os` | `docker` or `native`; the image's OS |
| `os.type`, `os.name`, `os.version`, `os.description`, `os.source` | the host's `/etc/os-release` (mounted into the worker as `/host/os-release`) |
| `os.kernel.release`, `os.kernel.build`, `os.kernel.cmdline`, `os.vm.swappiness` | `uname -r`, `/proc/version`, kernel parameters (e.g. `amdgpu.gttsize`), swappiness |
| `host.arch`, `host.board` | architecture; DMI: vendor, product, board, BIOS vendor/version/date |
| `host.cpu` | vendor, model name, family/model/stepping, microcode, cache, cores, threads, min/max frequency, scaling driver and governor, energy preference, boost |
| `host.memory` | total RAM, swap, huge pages |
| `hw.gpu` | name, Ryzen AI family, compute units, relative power, PCI ids and link, VBIOS version, driver and Mesa version, power profile and cap, VRAM and GTT sizes, all DPM clock levels (sclk, mclk, fclk, socclk), the Vulkan device (API and driver versions, conformance) |
| `hw.npu` | whether an XDNA NPU and its driver are present |
| `engine` | `sd-cli --version`, `ffmpeg -version` |
| `storage` | free/total space of the models and results disks |

### Metrics (sampled every 5 s and at every phase change)

| Metric | Unit | Source |
|---|---|---|
| `system.cpu.utilization` | 1 | `/proc/stat` |
| `system.cpu.frequency` | Hz | average `scaling_cur_freq` over all cores |
| `system.memory.usage`, `system.memory.available` | By | `/proc/meminfo` |
| `system.paging.usage`, `system.paging.in`, `system.paging.out` | By, By/s | swap used; swap-in/out rate from `/proc/vmstat` |
| `system.pressure.{cpu,memory,io}.some`, `.full` | 1 | pressure stall information, 10 s average |
| `hw.gpu.utilization` | 1 | `gpu_busy_percent` |
| `hw.gpu.memory.gtt.usage`, `hw.gpu.memory.vram.usage` | By | amdgpu `mem_info_*` |
| `hw.gpu.frequency.{sclk,mclk,fclk,socclk}` | Hz | amdgpu hwmon and DPM levels |
| `hw.power.package` | W | amdgpu hwmon PPT (the whole APU package) |
| `hw.temperature.{gpu,cpu,memory,storage}` | Cel | amdgpu edge, k10temp Tctl, the hottest SPD5118 module, the hottest NVMe drive |
| `process.engine.memory.usage`, `.swap`, `process.engine.cpu.utilization` | By, 1 | the running `sd-cli`/`ffmpeg` process |
| `process.worker.memory.usage`, `process.worker.event_loop.delay.max` | By, s | the worker itself |

A metric that the hardware does not report is simply absent.

### Downsampling

Samples are averaged into buckets that start at 10 s. When the series grows past 720 points, neighbouring buckets are merged and the bucket width doubles, so any job ends up with at most 720 points (an 8-hour clip: one point per 40 s). Per-phase `min/avg/max` are computed from all samples, not from the downsampled series.
