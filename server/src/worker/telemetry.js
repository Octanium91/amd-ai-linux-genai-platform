// Generation telemetry (optional, off by default; Settings in the UI).
// For every job one JSON document in /data/telemetry/<created>_<job id>.json:
//   resource  — a snapshot of the host and the software at the job start (OS, kernel, runtime,
//               deployment, CPU, GPU, memory, board, drivers, clocks, engine versions)
//   job       — the job itself: mode, parameters, models, result, errors
//   phases    — one entry per command and stage (prepare, sampling, decoding, saving per
//               segment, ffmpeg steps) with min/avg/max of every metric over that phase
//   series    — a time series of averages, downsampled so it never exceeds MAX_POINTS points
//   steps     — the time of every sampling step; commands — every command with exit status
// Names follow the OpenTelemetry semantic conventions (system.*, hw.*, process.*, os.*, host.*),
// units are UCUM: fractions 0..1, bytes (By), hertz (Hz), watts (W), degrees Celsius (Cel).
// Nothing leaves the machine: the files are only written locally and downloaded by an admin.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { config, WORKER_API } from '../common/config.js';
import { readSettings } from '../common/settings.js';
import { activeReasons, POWER_REASONS, readGpuMetrics, THERMAL_REASONS, throttleDelta } from './gpumetrics.js';
import { findSensors, gpuDevDir, systemInfo } from './system.js';

const fsp = fs.promises;
const { dirs } = config;
const SCHEMA = 'genai-platform.telemetry/2';
const SAMPLE_MS = 5000;
const MAX_POINTS = 720;
const MAX_STEPS = 20000;
const MAX_COMMANDS = 200;
const CHECKPOINT_MS = 5 * 60 * 1000;
const LOOP_RESOLUTION_MS = 20;

// The worker's own version: a hash of its sources (server/src/worker and common). A git revision
// baked into the image would change the image on every commit and restart the worker needlessly.
const codeVersion = (() => {
  try {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const h = crypto.createHash('sha256');
    for (const d of ['common', 'worker']) {
      for (const f of fs.readdirSync(path.join(src, d)).filter((x) => x.endsWith('.js')).sort()) {
        h.update(`${d}/${f}\0`).update(fs.readFileSync(path.join(src, d, f)));
      }
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return null;
  }
})();

const read = async (f) => {
  try {
    return (await fsp.readFile(f, 'utf8')).trim();
  } catch {
    return null;
  }
};
const readNum = async (f) => {
  const v = await read(f);
  return v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
};
const run = (cmd, args, timeout = 20000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout = '') => resolve(err && !stdout ? '' : String(stdout)));
});
const kv = (text, sep = '=') => Object.fromEntries(String(text || '').split('\n')
  .map((l) => l.split(sep))
  .filter((p) => p.length > 1)
  .map(([k, ...v]) => [k.trim(), v.join(sep).trim().replace(/^"|"$/g, '')]));
const mhzLevels = (text) => (text ? [...text.matchAll(/(\d+):\s*(\d+)Mhz\s*(\*)?/gi)].map((m) => ({ hz: Number(m[2]) * 1e6, current: !!m[3] })) : null);

// ---------- the resource snapshot ----------

let staticResource = null;
async function staticPart() {
  if (staticResource) return staticResource;
  const [vk, sd, ff] = await Promise.all([run('vulkaninfo', ['--summary']), run(config.sdCli, ['--version'], 10000), run('ffmpeg', ['-version'], 10000)]);
  const dev = vk.split(/GPU\d+:/).slice(1).map((b) => kv(b)).find((d) => d.deviceName && !/llvmpipe/i.test(d.deviceName)) || {};
  staticResource = {
    vulkan: {
      instanceVersion: vk.match(/Vulkan Instance Version:\s*(\S+)/)?.[1] || null,
      deviceName: dev.deviceName || null,
      deviceType: dev.deviceType || null,
      vendorID: dev.vendorID || null,
      deviceID: dev.deviceID || null,
      apiVersion: dev.apiVersion || null,
      driverVersion: dev.driverVersion || null,
      driverName: dev.driverName || null,
      driverInfo: dev.driverInfo || null,
      conformanceVersion: dev.conformanceVersion || null,
    },
    engine: {
      'sd.version': sd.split('\n')[0].trim() || null,
      'ffmpeg.version': ff.split('\n')[0].replace(/ Copyright.*/, '').trim() || null,
    },
  };
  return staticResource;
}

async function resourceSnapshot() {
  const g = gpuDevDir();
  const s = await findSensors();
  const sys = systemInfo();
  const [cpuinfo, meminfo, osRelease, containerOs, kernelBuild, cmdline, swappiness, part] = await Promise.all([
    read('/proc/cpuinfo'), read('/proc/meminfo'), read('/host/os-release'), read('/etc/os-release'),
    read('/proc/version'), read('/proc/cmdline'), readNum('/proc/sys/vm/swappiness'), staticPart(),
  ]);
  const cpu = kv(cpuinfo?.split('\n\n')[0], ':');
  const mem = kv(meminfo, ':');
  const hostOs = kv(osRelease || containerOs);
  const dmi = async (f) => read(`/sys/class/dmi/id/${f}`);
  const cpufreq = '/sys/devices/system/cpu/cpu0/cpufreq';
  const docker = fs.existsSync('/.dockerenv') || /docker|containerd/.test((await read('/proc/1/cgroup')) || '');
  const bytesKb = (v) => (v ? Number(v.split(' ')[0]) * 1024 : null);
  return {
    'service.name': 'amd-ai-linux-genai-platform',
    'service.component': 'worker',
    'service.version': codeVersion,
    'worker.api': WORKER_API,
    'process.runtime.name': 'node',
    'process.runtime.version': process.versions.node,
    'process.runtime.description': `Node.js ${process.version}, V8 ${process.versions.v8}, libuv ${process.versions.uv}`,
    'deployment.mode': docker ? 'docker' : 'native',
    'container.image.os': docker ? kv(containerOs).PRETTY_NAME || null : null,
    'os.type': os.platform(),
    'os.name': hostOs.NAME || null,
    'os.version': hostOs.VERSION_ID || null,
    'os.description': hostOs.PRETTY_NAME || null,
    'os.source': osRelease ? 'host' : 'container',
    'os.kernel.release': os.release(),
    'os.kernel.build': kernelBuild,
    'os.kernel.cmdline': cmdline,
    'os.vm.swappiness': swappiness,
    'host.arch': os.arch() === 'x64' ? 'amd64' : os.arch(),
    'host.board': {
      vendor: await dmi('sys_vendor'), product: await dmi('product_name'), version: await dmi('product_version'),
      board: await dmi('board_name'), 'bios.vendor': await dmi('bios_vendor'), 'bios.version': await dmi('bios_version'), 'bios.date': await dmi('bios_date'),
    },
    'host.cpu': {
      'vendor.id': cpu.vendor_id || null,
      'model.name': cpu['model name'] || null,
      family: cpu['cpu family'] || null,
      'model.id': cpu.model || null,
      stepping: cpu.stepping || null,
      microcode: cpu.microcode || null,
      'cache.size': cpu['cache size'] || null,
      cores: Number(cpu['cpu cores']) || null,
      threads: os.cpus().length,
      'frequency.min': (await readNum(`${cpufreq}/cpuinfo_min_freq`)) * 1000 || null,
      'frequency.max': (await readNum(`${cpufreq}/cpuinfo_max_freq`)) * 1000 || null,
      'scaling.driver': await read(`${cpufreq}/scaling_driver`),
      'scaling.governor': await read(`${cpufreq}/scaling_governor`),
      'energy_performance_preference': await read(`${cpufreq}/energy_performance_preference`),
      boost: await read('/sys/devices/system/cpu/cpufreq/boost'),
    },
    'host.memory': {
      total: bytesKb(mem.MemTotal),
      'swap.total': bytesKb(mem.SwapTotal),
      'hugepages.total': Number(mem.HugePages_Total) || 0,
    },
    'hw.gpu': {
      // From the driver stack: libdrm's amdgpu.ids (or Vulkan), KFD topology for the CU count and architecture
      name: sys.gpuName || sys.gpu,
      'vulkan.name': sys.gpu,
      arch: sys.gpuArch,
      family: sys.family,
      'compute_units': sys.gpuCu,
      'relative_power': sys.gpuPower?.score ?? null,
      'pci.vendor': g && await read(`${g}/vendor`),
      'pci.device': g && await read(`${g}/device`),
      'pci.revision': g && await read(`${g}/revision`),
      'pci.subsystem': g && `${await read(`${g}/subsystem_vendor`)}:${await read(`${g}/subsystem_device`)}`,
      'pci.link': g && await read(`${g}/current_link_speed`),
      'firmware_version': g && await read(`${g}/vbios_version`),
      'driver': 'amdgpu',
      'driver_version': part.vulkan.driverInfo,
      'power.profile': g && await read(`${g}/power_dpm_force_performance_level`),
      'power.cap': s.gpu ? (await readNum(`${s.gpu}/power1_cap`)) / 1e6 || null : null,
      'memory.vram.total': g && await readNum(`${g}/mem_info_vram_total`),
      'memory.gtt.total': g && await readNum(`${g}/mem_info_gtt_total`),
      'clock.levels': g && {
        sclk: mhzLevels(await read(`${g}/pp_dpm_sclk`)),
        mclk: mhzLevels(await read(`${g}/pp_dpm_mclk`)),
        fclk: mhzLevels(await read(`${g}/pp_dpm_fclk`)),
        socclk: mhzLevels(await read(`${g}/pp_dpm_socclk`)),
      },
      vulkan: part.vulkan,
    },
    'hw.npu': sys.npu,
    engine: part.engine,
    storage: sys.storage,
  };
}

// ---------- metrics sampled during a job ----------

async function sampleMetrics(state, pid) {
  const g = gpuDevDir();
  const s = await findSensors();
  const m = {};
  const now = Date.now();
  // CPU utilization from /proc/stat deltas
  const stat = await read('/proc/stat');
  if (stat) {
    const v = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.reduce((a, b) => a + b, 0);
    if (state.cpu && total > state.cpu.total) m['system.cpu.utilization'] = 1 - (idle - state.cpu.idle) / (total - state.cpu.total);
    state.cpu = { idle, total };
  }
  // Average current frequency over all cores
  let fsum = 0;
  let fn = 0;
  for (let i = 0; i < os.cpus().length; i++) {
    const f = await readNum(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
    if (f) {
      fsum += f * 1000;
      fn++;
    }
  }
  if (fn) m['system.cpu.frequency'] = fsum / fn;
  // Memory, swap and paging
  const mem = kv(await read('/proc/meminfo'), ':');
  const kb = (k) => (mem[k] ? Number(mem[k].split(' ')[0]) * 1024 : null);
  if (mem.MemTotal) {
    m['system.memory.usage'] = kb('MemTotal') - kb('MemAvailable');
    m['system.memory.available'] = kb('MemAvailable');
    m['system.paging.usage'] = kb('SwapTotal') - kb('SwapFree');
  }
  const vmstat = kv(await read('/proc/vmstat'), ' ');
  if (vmstat.pswpin) {
    const pin = Number(vmstat.pswpin);
    const pout = Number(vmstat.pswpout);
    if (state.paging) {
      const dt = (now - state.paging.at) / 1000;
      m['system.paging.in'] = ((pin - state.paging.pin) * 4096) / dt;
      m['system.paging.out'] = ((pout - state.paging.pout) * 4096) / dt;
    }
    state.paging = { pin, pout, at: now };
  }
  // Pressure stall information (fraction of time some task waited, 10 s average)
  for (const r of ['cpu', 'memory', 'io']) {
    const psi = await read(`/proc/pressure/${r}`);
    const some = psi?.match(/some avg10=([\d.]+)/)?.[1];
    const full = psi?.match(/full avg10=([\d.]+)/)?.[1];
    if (some != null) m[`system.pressure.${r}.some`] = Number(some) / 100;
    if (full != null && r !== 'cpu') m[`system.pressure.${r}.full`] = Number(full) / 100;
  }
  // GPU
  if (g) {
    const busy = await readNum(`${g}/gpu_busy_percent`);
    if (busy != null) m['hw.gpu.utilization'] = busy / 100;
    m['hw.gpu.memory.gtt.usage'] = await readNum(`${g}/mem_info_gtt_used`);
    m['hw.gpu.memory.vram.usage'] = await readNum(`${g}/mem_info_vram_used`);
    for (const c of ['mclk', 'fclk', 'socclk']) {
      const cur = mhzLevels(await read(`${g}/pp_dpm_${c}`))?.find((x) => x.current);
      if (cur) m[`hw.gpu.frequency.${c}`] = cur.hz;
    }
  }
  if (s.gpu) {
    m['hw.gpu.frequency.sclk'] = await readNum(`${s.gpu}/freq1_input`);
    const p = (await readNum(`${s.gpu}/power1_average`)) ?? (await readNum(`${s.gpu}/power1_input`));
    if (p != null) m['hw.power.package'] = p / 1e6;
    const t = await readNum(`${s.gpu}/temp1_input`);
    if (t != null) m['hw.temperature.gpu'] = t / 1000;
  }
  if (s.cpu) {
    const t = await readNum(`${s.cpu}/temp1_input`);
    if (t != null) m['hw.temperature.cpu'] = t / 1000;
  }
  const maxTemp = async (list) => {
    let max = null;
    for (const d of list) {
      const t = await readNum(`${d}/temp1_input`);
      if (t != null) max = Math.max(max ?? -Infinity, t / 1000);
    }
    return max;
  };
  const memT = await maxTemp(s.memory);
  if (memT != null) m['hw.temperature.memory'] = memT;
  // The SMU firmware's metrics table: clock limits it enforces and throttle residency counters
  const gm = await readGpuMetrics(g);
  if (gm) {
    const mhz = (v) => (v == null ? null : v * 1e6);
    const watts = (v) => (v == null ? null : v / 1000);
    m['hw.temperature.soc'] = gm.tempSoc;
    m['hw.temperature.cpu.core.max'] = gm.tempCoreMax;
    m['hw.gpu.frequency.sclk.limit'] = mhz(gm.gfxMaxMhz);
    m['system.cpu.frequency.limit'] = mhz(gm.coreMaxMhz);
    m['hw.memory.frequency.uclk'] = mhz(gm.uclkMhz);
    if (m['hw.gpu.frequency.fclk'] == null) m['hw.gpu.frequency.fclk'] = mhz(gm.fclkMhz);
    m['hw.power.socket'] = watts(gm.socketPowerMw);
    m['hw.power.gfx'] = watts(gm.gfxPowerMw);
    m['hw.power.cpu'] = watts(gm.corePowerMw);
    // Totals for the summary: per-reason counter growth, when each reason first appeared, the lowest
    // clock limits. The baseline sample before the job only sets the previous reading.
    const delta = throttleDelta(state.gpuMetrics, gm);
    state.gpuMetrics = gm;
    const t = (state.throttle ||= { totals: {}, firstAt: {}, limits: {}, samples: 0, thermalSamples: 0, powerSamples: 0 });
    if (delta) {
      t.samples++;
      for (const [r, v] of Object.entries(delta)) {
        if (v == null) continue;
        m[`hw.throttle.${r}`] = v;
        t.totals[r] = (t.totals[r] || 0) + v;
        if (v > 0 && t.firstAt[r] == null) t.firstAt[r] = now;
      }
      if (activeReasons(delta, THERMAL_REASONS).length) t.thermalSamples++;
      if (activeReasons(delta, POWER_REASONS).length) t.powerSamples++;
      for (const [k, v] of [['sclk', gm.gfxMaxMhz], ['cpu', gm.coreMaxMhz]]) {
        if (v != null) t.limits[k] = { min: Math.min(t.limits[k]?.min ?? Infinity, v), max: Math.max(t.limits[k]?.max ?? 0, v) };
      }
    }
  }
  const stT = await maxTemp(s.storage.map((x) => x.dir));
  if (stT != null) m['hw.temperature.storage'] = stT;
  // The engine process (sd-cli or ffmpeg) and the worker itself
  if (pid) {
    const st = kv(await read(`/proc/${pid}/status`), ':');
    if (st.VmRSS) m['process.engine.memory.usage'] = Number(st.VmRSS.split(' ')[0]) * 1024;
    if (st.VmSwap) m['process.engine.memory.swap'] = Number(st.VmSwap.split(' ')[0]) * 1024;
    const ps = (await read(`/proc/${pid}/stat`))?.split(') ')[1]?.split(' ');
    if (ps) {
      const ticks = Number(ps[11]) + Number(ps[12]);
      if (state.proc?.pid === pid) m['process.engine.cpu.utilization'] = (ticks - state.proc.ticks) / 100 / ((now - state.proc.at) / 1000) / os.cpus().length;
      state.proc = { pid, ticks, at: now };
    }
  }
  m['process.worker.memory.usage'] = process.memoryUsage().rss;
  for (const k of Object.keys(m)) if (m[k] == null || !Number.isFinite(m[k])) delete m[k];
  return m;
}

// ---------- aggregation ----------

class Stats {
  constructor() {
    this.s = {};
  }

  add(sample) {
    for (const [k, v] of Object.entries(sample)) {
      const a = (this.s[k] ??= { n: 0, sum: 0, min: v, max: v });
      a.n++;
      a.sum += v;
      if (v < a.min) a.min = v;
      if (v > a.max) a.max = v;
    }
  }

  out() {
    return Object.fromEntries(Object.entries(this.s).map(([k, a]) => [k, { min: a.min, avg: a.sum / a.n, max: a.max, n: a.n }]));
  }
}

// A time series of bucket averages; when it grows past MAX_POINTS, neighbouring buckets are
// merged and the bucket width doubles, so an 8-hour job stays as small as a 10-minute one
class Series {
  constructor(startedAt) {
    this.t0 = startedAt;
    this.bucket = 10;
    this.fields = [];
    this.points = [];
    this.acc = null;
  }

  add(at, sample) {
    const idx = Math.floor((at - this.t0) / 1000 / this.bucket);
    if (this.acc && this.acc.idx !== idx) this.flush();
    this.acc ??= { idx, stats: new Stats() };
    this.acc.stats.add(sample);
  }

  flush() {
    if (!this.acc) return;
    const avg = this.acc.stats.out();
    for (const k of Object.keys(avg)) if (!this.fields.includes(k)) this.fields.push(k);
    this.points.push({ idx: this.acc.idx, v: Object.fromEntries(Object.entries(avg).map(([k, a]) => [k, a.avg])), n: this.acc.stats.out()[Object.keys(avg)[0]]?.n || 1 });
    this.acc = null;
    while (this.points.length > MAX_POINTS) this.halve();
  }

  halve() {
    this.bucket *= 2;
    const merged = [];
    for (const p of this.points) {
      const idx = Math.floor(p.idx / 2);
      const last = merged.at(-1);
      if (last && last.idx === idx) {
        for (const [k, v] of Object.entries(p.v)) last.v[k] = last.v[k] == null ? v : (last.v[k] * last.n + v * p.n) / (last.n + p.n);
        last.n += p.n;
      } else merged.push({ idx, v: { ...p.v }, n: p.n });
    }
    this.points = merged;
    if (this.acc) this.acc.idx = Math.floor(this.acc.idx / 2);
  }

  out() {
    const round = (v) => (v == null ? null : Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 1e4) / 1e4);
    return {
      startedAt: this.t0,
      bucketSec: this.bucket,
      fields: ['t', ...this.fields],
      points: this.points.map((p) => [p.idx * this.bucket, ...this.fields.map((k) => round(p.v[k]))]),
    };
  }
}

// Throttling as the SMU firmware counted it. thermal: a thermal limit or PROCHOT cut the clocks, the
// machine overheats. power: a power limit capped the clocks, the normal ceiling of a small machine.
// Shares are the fraction of samples in which the counter grew.
function throttleSummary(t, startedAt, round) {
  if (!t?.samples) return null;
  const firstOf = (list) => {
    const at = list.map((r) => t.firstAt[r]).filter((v) => v != null);
    return at.length ? round((Math.min(...at) - startedAt) / 1000, 1) : null;
  };
  const counters = Object.fromEntries(Object.entries(t.totals).filter(([, v]) => v > 0));
  return {
    thermal: t.thermalSamples > 0,
    power: t.powerSamples > 0,
    thermalShare: round(t.thermalSamples / t.samples),
    powerShare: round(t.powerSamples / t.samples),
    firstThermalSec: firstOf(THERMAL_REASONS),
    firstPowerSec: firstOf(POWER_REASONS),
    reasons: Object.keys(counters),
    counters,
    'hw.gpu.frequency.sclk.limit.min': t.limits.sclk ? t.limits.sclk.min * 1e6 : null,
    'hw.gpu.frequency.sclk.limit.max': t.limits.sclk ? t.limits.sclk.max * 1e6 : null,
    'system.cpu.frequency.limit.min': t.limits.cpu ? t.limits.cpu.min * 1e6 : null,
    'system.cpu.frequency.limit.max': t.limits.cpu ? t.limits.cpu.max * 1e6 : null,
  };
}

// ---------- the summary: the numbers one wants first, computed from phases and steps ----------

export function summarize(job, phases, steps, startedAt, series, throttle = null) {
  const sum = (name) => phases.filter((p) => p.name === name).reduce((s, p) => s + (p.durationSec || 0), 0);
  const peak = (k) => phases.reduce((m, p) => (p.metrics[k] ? Math.max(m ?? -Infinity, p.metrics[k].max) : m), null);
  // Energy: the average package power of every phase times its length
  const energyJ = phases.reduce((s, p) => s + (p.metrics['hw.power.package']?.avg || 0) * (p.durationSec || 0), 0);
  const sampling = steps.filter((r) => r[2] === 'sampling');
  const avg = (rows) => (rows.length ? rows.reduce((s, r) => s + r[5], 0) / rows.length : null);
  // The first step of every image and segment includes warm-up: it is left out of the trend
  const steady = sampling.filter((r) => r[3] > 1);
  const tenth = Math.max(1, Math.floor(steady.length / 10));
  const firstSteps = avg(steady.slice(0, tenth));
  const lastSteps = avg(steady.slice(-tenth));
  // Clock trend under full load: the time series points with the GPU busy (the first one, where the
  // clock ramps up, is left out), first quarter against last quarter
  const col = (k) => series.fields.indexOf(k);
  const iu = col('hw.gpu.utilization');
  const ic = col('hw.gpu.frequency.sclk');
  const loaded = iu > 0 && ic > 0 ? series.points.filter((pt) => pt[iu] >= 0.9 && pt[ic]).map((pt) => pt[ic]).slice(1) : [];
  const quarter = Math.max(1, Math.floor(loaded.length / 4));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const sclkFirst = loaded.length >= 2 ? mean(loaded.slice(0, quarter)) : null;
  const sclkLast = loaded.length >= 2 ? mean(loaded.slice(-quarter)) : null;
  const durationSec = job.finishedAt && job.startedAt ? (job.finishedAt - job.startedAt) / 1000 : (Date.now() - startedAt) / 1000;
  const images = job.params?.kind === 'image' ? job.params.count || 1 : null;
  const round = (v, n = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** n) / 10 ** n);
  return {
    durationSec: round(durationSec, 1),
    // Model loading and preparation until the first sampling step
    firstStepSec: sampling.length ? round(Math.max(0, (sampling[0][6] - sampling[0][5] * 1000) / 1000), 1) : null,
    samplingSec: round(sum('sampling'), 1),
    decodingSec: round(sum('decoding'), 1),
    ffmpegSec: round(phases.filter((p) => p.name.startsWith('ffmpeg')).reduce((s, p) => s + (p.durationSec || 0), 0), 1),
    steps: sampling.length,
    secondsPerStep: round(avg(sampling)),
    secondsPerStepFirst: round(firstSteps),
    secondsPerStepLast: round(lastSteps),
    // Positive: the last tenth of the steps (without warm-up steps) was slower than the first one
    stepSlowdown: firstSteps && lastSteps ? round(lastSteps / firstSteps - 1) : null,
    'hw.gpu.frequency.sclk.first': round(sclkFirst, 0),
    'hw.gpu.frequency.sclk.last': round(sclkLast, 0),
    // Positive: the GPU clock under full load dropped from the first to the last quarter
    gpuClockDrop: sclkFirst && sclkLast ? round(1 - sclkLast / sclkFirst) : null,
    energyWh: energyJ ? round(energyJ / 3600) : null,
    secondsPerImage: images ? round(durationSec / images, 1) : null,
    secondsPerVideoSecond: job.params?.kind === 'video' && job.params.duration ? round(durationSec / job.params.duration, 1) : null,
    'energyWh.perImage': images && energyJ ? round(energyJ / 3600 / images) : null,
    'peak.hw.temperature.gpu': peak('hw.temperature.gpu'),
    'peak.hw.temperature.cpu': peak('hw.temperature.cpu'),
    'peak.hw.temperature.memory': peak('hw.temperature.memory'),
    'peak.hw.temperature.storage': peak('hw.temperature.storage'),
    'peak.hw.temperature.soc': peak('hw.temperature.soc'),
    'peak.hw.temperature.cpu.core.max': peak('hw.temperature.cpu.core.max'),
    throttling: throttleSummary(throttle, startedAt, round),
    'peak.hw.power.package': peak('hw.power.package'),
    'peak.hw.gpu.memory.gtt.usage': peak('hw.gpu.memory.gtt.usage'),
    'peak.system.memory.usage': peak('system.memory.usage'),
    'peak.system.paging.usage': peak('system.paging.usage'),
    'peak.process.engine.memory.usage': peak('process.engine.memory.usage'),
    'peak.system.pressure.memory.some': peak('system.pressure.memory.some'),
  };
}

// ---------- a job's telemetry session ----------

const fileSafe = (s) => String(s).replace(/[^\w.-]/g, '');

class Session {
  constructor(job, maxBytes) {
    this.job = job;
    this.maxBytes = maxBytes;
    const d = new Date(job.createdAt);
    const p = (n) => String(n).padStart(2, '0');
    this.file = path.join(dirs.telemetry, `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${fileSafe(job.id)}${job.retries ? `_r${job.retries}` : ''}.json`);
    this.startedAt = Date.now();
    this.series = new Series(this.startedAt);
    this.phases = [];
    this.steps = [];
    this.commands = [];
    this.events = [];
    this.state = {};
    this.pid = null;
    this.phase('prepare', { segment: 1 });
  }

  async start() {
    try {
      this.resource = await resourceSnapshot();
    } catch (e) {
      this.resource = { error: e.message };
    }
    // A baseline for the counters that are rates (CPU time, paging), so the first sample has them
    await sampleMetrics(this.state, null).catch(() => {});
    this.loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.loop.enable();
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref();
    this.checkpoint = setInterval(() => this.write(false).catch(() => {}), CHECKPOINT_MS);
    this.checkpoint.unref();
    this.sample();
  }

  async sample() {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const at = Date.now();
      const m = await sampleMetrics(this.state, this.pid);
      if (this.loop) {
        // The histogram's floor is its resolution: only the part above it is a real delay
        m['process.worker.event_loop.delay.max'] = Math.max(0, this.loop.max / 1e9 - LOOP_RESOLUTION_MS / 1000);
        this.loop.reset();
      }
      this.current?.stats.add(m);
      this.series.add(at, m);
      // Thermal throttling starting and ending are events, with the temperatures at that moment
      const thermal = THERMAL_REASONS.filter((r) => m[`hw.throttle.${r}`] > 0);
      if (thermal.length && !this.thermal) {
        this.event('throttle.thermal.start', {
          reasons: thermal, 'hw.temperature.gpu': m['hw.temperature.gpu'], 'hw.temperature.cpu': m['hw.temperature.cpu'],
          'hw.gpu.frequency.sclk': m['hw.gpu.frequency.sclk'], 'hw.gpu.frequency.sclk.limit': m['hw.gpu.frequency.sclk.limit'],
        });
      } else if (!thermal.length && this.thermal) {
        this.event('throttle.thermal.end', { 'hw.temperature.gpu': m['hw.temperature.gpu'], 'hw.temperature.cpu': m['hw.temperature.cpu'] });
      }
      this.thermal = thermal.length > 0;
    } catch {} finally {
      this.sampling = false;
    }
  }

  // A new phase: every command and every stage (per segment) gets its own aggregates
  phase(name, extra = {}) {
    const now = Date.now();
    if (this.current) {
      this.current.endedAt = now;
      // A phase that lasted a moment and got no sample carries no information
      const empty = now - this.current.startedAt < 50 && !Object.keys(this.current.stats.s).length;
      if (!empty) this.phases.push(this.current);
    }
    this.current = { name, ...extra, startedAt: now, stats: new Stats() };
    // Every phase gets at least one sample, however short it is
    if (this.timer) setTimeout(() => this.sample(), 300).unref();
  }

  step(segment, image, stage, step, total, secondsPerStep) {
    if (this.steps.length >= MAX_STEPS) return;
    const last = this.steps.at(-1);
    if (last && last[0] === segment && last[1] === image && last[2] === stage && last[3] === step) return;
    this.steps.push([segment, image, stage, step, total, Math.round(secondsPerStep * 1000) / 1000, Date.now() - this.startedAt]);
  }

  command(entry) {
    if (this.commands.length < MAX_COMMANDS) this.commands.push(entry);
  }

  event(type, data) {
    if (this.events.length < 1000) this.events.push({ t: Date.now() - this.startedAt, type, ...data });
  }

  doc(complete) {
    const phases = [...this.phases, ...(this.current ? [{ ...this.current, endedAt: complete ? this.current.endedAt ?? Date.now() : null }] : [])]
      .map(({ stats, ...p }) => ({ ...p, durationSec: p.endedAt ? (p.endedAt - p.startedAt) / 1000 : null, metrics: stats.out() }));
    const { spec, cmd, progress, ...job } = this.job;
    return {
      schema: SCHEMA,
      complete,
      writtenAt: Date.now(),
      summary: summarize(this.job, phases, this.steps, this.startedAt, this.series.out(), this.state.throttle),
      resource: this.resource || null,
      job: {
        ...job,
        spec: spec && { ...spec, models: (spec.models || []).map((m) => ({ ...m, size: m.file ? fs.statSync(path.join(dirs.models, m.file), { throwIfNoEntry: false })?.size ?? null : null })) },
        stages: progress?.stages ? Object.fromEntries(Object.entries(progress.stages).map(([k, v]) => [k, { startedAt: v.startedAt, endedAt: v.endedAt ?? null }])) : null,
        files: (job.files || []).map((f) => ({ name: f, size: fs.statSync(path.join(dirs.output, f), { throwIfNoEntry: false })?.size ?? null })),
      },
      phases,
      series: this.series.out(),
      steps: { fields: ['segment', 'image', 'stage', 'step', 'total', 'secondsPerStep', 't'], rows: this.steps },
      commands: this.commands,
      events: this.events,
    };
  }

  async write(complete) {
    await fsp.mkdir(dirs.telemetry, { recursive: true });
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.doc(complete)));
    await fsp.rename(tmp, this.file);
    await enforceLimit(this.maxBytes, this.file);
  }

  async finish() {
    clearInterval(this.timer);
    clearInterval(this.checkpoint);
    await this.sample();
    this.loop?.disable();
    if (this.current) this.current.endedAt = Date.now();
    this.series.flush();
    try {
      await this.write(true);
    } catch (e) {
      console.error(`[telemetry] could not write ${path.basename(this.file)}: ${e.message}`);
    }
  }
}

// The directory never grows past the limit: the oldest documents go first (never the current one)
async function enforceLimit(maxBytes, keep) {
  const files = [];
  for (const f of await fsp.readdir(dirs.telemetry)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dirs.telemetry, f);
    const st = await fsp.stat(p).catch(() => null);
    if (st) files.push({ p, size: st.size, mtime: st.mtimeMs });
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    if (f.p === keep) continue;
    await fsp.rm(f.p, { force: true });
    total -= f.size;
  }
}

// Starts a session if telemetry is enabled in the settings (read at every job start)
export async function startTelemetry(job) {
  const { telemetry } = readSettings();
  if (!telemetry.enabled) return null;
  const session = new Session(job, Math.max(1, Number(telemetry.maxMb) || 250) * 1024 * 1024);
  await session.start();
  return session;
}

// Documents of jobs interrupted by a restart are closed with the job's final status
export function closeInterrupted(interruptedJobs) {
  if (!interruptedJobs.length) return;
  let files = [];
  try {
    files = fs.readdirSync(dirs.telemetry);
  } catch {
    return;
  }
  for (const job of interruptedJobs) {
    for (const f of files.filter((x) => x.includes(`_${job.id}`) && x.endsWith('.json'))) {
      const p = path.join(dirs.telemetry, f);
      try {
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (doc.complete) continue;
        Object.assign(doc, { complete: true, interrupted: true, writtenAt: Date.now() });
        Object.assign(doc.job, { status: job.status, error: job.error, finishedAt: job.finishedAt });
        fs.writeFileSync(p, JSON.stringify(doc));
      } catch {}
    }
  }
}
