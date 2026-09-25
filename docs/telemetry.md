# Generation telemetry

Optional and off by default: **Settings → Generation telemetry** (administrators). When it is on, the worker writes one JSON document per job to `DATA_PATH/telemetry/`. The documents never leave the machine; an administrator downloads them from the Settings page, one at a time or all at once as a single JSON array (`GET /api/telemetry/export`).

The size limit (250 MB by default) applies to the whole directory: after each write the oldest documents are deleted until the total fits. One document is small and does not grow with the job's length: an image job takes about 15 KB, an 8-hour video a few hundred KB, because the time series is downsampled (see below).

Names follow the [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/) where one exists (`os.*`, `host.*`, `process.runtime.*`, `system.*`, `hw.*`). Units are UCUM: fractions `0..1` for utilization and pressure, bytes, hertz, watts, degrees Celsius, seconds.

## Document layout

File name: `<job created, local time>_<job id>[_r<retry>].json`. Top-level fields:

| Field | Contents |
|---|---|
| `schema` | `genai-platform.telemetry/2` (version 2 added `summary` and the image index in `steps`) |
| `complete` | `false` while the job runs (a checkpoint is written every 5 minutes), `true` at the end; a job interrupted by a restart is closed with `interrupted: true` |
| `summary` | the key numbers at a glance, see below |
| `resource` | the system at the job start, see below |
| `job` | the job as the worker knows it: id, user, status, error/warning, timestamps, `params` (mode, prompt, negative, size, steps, CFG, sampler, seed, frames, fps, segments…), `spec` (model files by role with sizes, flags), stage timestamps, result files with sizes |
| `phases` | one entry per stage and command: `name` (`prepare`, `sampling`, `decoding`, `saving`, `ffmpeg.last_frame`, `ffmpeg.encode`, `ffmpeg.encode+interpolate`, `ffmpeg.thumbnail`), `segment`, `image` (the image of a batch: images are sampled one after another and decoded together), `startedAt`, `endedAt`, `durationSec`, and `metrics`: for every metric `{min, avg, max, n}` over the phase. A phase shorter than 50 ms without a single sample is left out |
| `series` | `{startedAt, bucketSec, fields, points}`: bucket averages as rows, `t` in seconds from the start |
| `steps` | `{fields, rows}`: every sampling step as `[segment, image, stage, step, total, secondsPerStep, t]`, `t` in milliseconds from the start |
| `commands` | every `sd-cli` and `ffmpeg` run: program, phase, full arguments, exit code, signal, start/end, error tail |
| `events` | reserved for notable events |

### `summary`

| Key | Meaning |
|---|---|
| `durationSec` | the whole job |
| `firstStepSec` | from the start to the first sampling step: model loading and preparation |
| `samplingSec`, `decodingSec`, `ffmpegSec` | time in the sampling and decoding phases and in ffmpeg |
| `steps`, `secondsPerStep` | the number of sampling steps and their average time |
| `secondsPerStepFirst`, `secondsPerStepLast`, `stepSlowdown` | the average step of the first and the last tenth of the steps, and how much slower the last one is (a sign of heat and throttling); the first step of every image and segment is warm-up and is left out |
| `hw.gpu.frequency.sclk.first`, `.last`, `gpuClockDrop` | the average GPU clock under full load (time series points with the GPU at least 90 % busy, the ramp-up point left out) in the first and the last quarter, and the relative drop |
| `energyWh`, `energyWh.perImage` | the package power integrated over the phases |
| `secondsPerImage`, `secondsPerVideoSecond` | the whole job per image, or per second of the clip |
| `peak.*` | the highest temperatures, package power, GTT, RAM, swap, engine memory and memory pressure of the job |

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

A metric that the hardware does not report is simply absent. `process.worker.event_loop.delay.max` is the delay above the 20 ms measuring resolution, so an idle event loop reports 0.

## Anonymized downloads

The **Anonymize downloads** option on the Settings page (on by default) applies to "Download all" and to single documents (`?anonymize=1` in the API). The stored files stay as they are; the downloaded copy gets `anonymized: true` and:

- prompt and negative prompt replaced with `[removed, N characters]`, also in the `sd-cli` arguments;
- the user name replaced with a pseudonym (`user-1a2b3c4d`) that is the same for all jobs of one download and different between downloads;
- result, thumbnail and upload names replaced (they contain a part of the prompt), paths in command arguments reduced to `/data/output/[file].png` and the like;
- disk UUIDs removed from the kernel command line.

Everything else — hardware, drivers, parameters, timings and metrics — is kept, which is what makes the documents useful for comparing machines.

### Downsampling

Samples are averaged into buckets that start at 10 s. When the series grows past 720 points, neighbouring buckets are merged and the bucket width doubles, so any job ends up with at most 720 points (an 8-hour clip: one point per 40 s). Per-phase `min/avg/max` are computed from all samples, not from the downsampled series.
