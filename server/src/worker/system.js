// Hardware info: APU, iGPU (via Vulkan), unified memory, GTT and NPU.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../common/config.js';

let gpuDir = null;
try {
  const card = fs.readdirSync('/sys/class/drm').find(
    (d) => /^card\d+$/.test(d) && fs.existsSync(`/sys/class/drm/${d}/device/mem_info_gtt_total`),
  );
  if (card) gpuDir = `/sys/class/drm/${card}/device`;
} catch {}

function cpuModel() {
  try {
    return fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

// The XDNA NPU (Ryzen AI) shows up on PCI as 1022:1502 / 1022:17f0; the amdxdna driver provides /dev/accel
function npuInfo() {
  let present = false;
  try {
    for (const d of fs.readdirSync('/sys/bus/pci/devices')) {
      const base = `/sys/bus/pci/devices/${d}`;
      const vendor = fs.readFileSync(`${base}/vendor`, 'utf8').trim();
      const device = fs.readFileSync(`${base}/device`, 'utf8').trim();
      if (vendor === '0x1022' && ['0x1502', '0x17f0'].includes(device)) present = true;
    }
  } catch {}
  return { present, driver: fs.existsSync('/dev/accel') };
}

// Ryzen AI family derived from the iGPU name, used for UI hints and recommendations
function platformFamily(gpu = '', cpu = '') {
  const s = `${gpu} ${cpu}`;
  if (/8060S|8050S|8040S|Ryzen AI MAX/i.test(s)) return 'Strix Halo';
  if (/890M|880M|Ryzen AI 9/i.test(s)) return 'Strix Point';
  if (/860M|840M|Ryzen AI [57] 3[34]0/i.test(s)) return 'Krackan Point';
  return null;
}

// Relative GPU power for time estimates: compute units × maximum shader clock, compared with the
// reference machine the `reference` timings in catalog/presets.json were measured on (Radeon 890M).
// Neither Vulkan nor sysfs reports the CU count, but on Ryzen AI the CPU model names the iGPU
// ("… w/ Radeon 890M"), so the count comes from the lineup table.
const IGPU_CU = { '890M': 16, '880M': 12, '860M': 8, '840M': 4, '8060S': 40, '8050S': 32, '8040S': 16 };
const REFERENCE_GPU = { name: 'Radeon 890M', cu: 16, clockMhz: 2900 };

function maxShaderClock() {
  try {
    const mhz = [...fs.readFileSync(`${gpuDir}/pp_dpm_sclk`, 'utf8').matchAll(/(\d+)\s*Mhz/gi)].map((m) => Number(m[1]));
    return mhz.length ? Math.max(...mhz) : null;
  } catch {
    return null;
  }
}

function gpuPower(gpu = '', cpu = '') {
  const name = `${gpu} ${cpu}`.match(/Radeon\s+(\d{3,4}[MS])\b/i)?.[1]?.toUpperCase();
  const cu = name ? IGPU_CU[name] : null;
  if (!cu) return null;
  const clockMhz = maxShaderClock() || REFERENCE_GPU.clockMhz;
  return {
    name: `Radeon ${name}`,
    cu,
    clockMhz,
    score: (cu * clockMhz) / (REFERENCE_GPU.cu * REFERENCE_GPU.clockMhz),
    reference: REFERENCE_GPU.name,
  };
}

const info = { cpu: cpuModel(), gpu: null, driver: null, npu: npuInfo(), family: null, gpuPower: null };

// Take the GPU name from Vulkan itself: it is exactly the device sd.cpp will run on
execFile('vulkaninfo', ['--summary'], { timeout: 20000 }, (err, stdout = '') => {
  const devs = [...stdout.matchAll(/deviceName\s*=\s*(.+)/g)].map((m) => m[1].trim());
  const drivers = [...stdout.matchAll(/driverInfo\s*=\s*(.+)/g)].map((m) => m[1].trim());
  const i = devs.findIndex((n) => !/llvmpipe/i.test(n));
  info.gpu = i >= 0 ? devs[i] : devs[0] || null;
  info.driver = i >= 0 ? drivers[i] : null;
  info.family = platformFamily(info.gpu, info.cpu);
  if (info.gpu && !/llvmpipe/i.test(info.gpu)) info.gpuPower = gpuPower(info.gpu, info.cpu);
  if (!info.gpu || /llvmpipe/i.test(info.gpu)) {
    console.warn('[system] Vulkan sees no GPU (llvmpipe only): check the /dev/dri passthrough and the render/video groups');
  } else {
    console.log(`[system] ${info.cpu} · ${info.gpu} · ${info.driver}`);
  }
});

// Live metrics are sampled in the background with asynchronous I/O and served from a snapshot.
// Requests never touch sysfs or /proc themselves: under memory pressure (a large Wan job pushing
// pages to swap) or a busy GPU those reads can stall, and a stalled read on the only Node thread
// would make the worker look dead to the web container and to the Docker healthcheck.
const fsp = fs.promises;
const readNumAsync = async (f) => {
  try {
    return Number((await fsp.readFile(f, 'utf8')).trim());
  } catch {
    return null;
  }
};

// CPU load from the difference of /proc/stat counters between two samples
let prevCpu = null;
async function cpuUsage() {
  try {
    const line = (await fsp.readFile('/proc/stat', 'utf8')).split('\n')[0];
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.reduce((a, b) => a + b, 0);
    const prev = prevCpu;
    prevCpu = { idle, total };
    if (!prev || total === prev.total) return null;
    return Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 100);
  } catch {
    return null;
  }
}

async function dirSize(dir) {
  let size = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) size += (await fsp.stat(p)).size;
    }
  };
  try {
    await walk(dir);
  } catch {}
  return size;
}

async function disk(dir) {
  try {
    const [s, st] = await Promise.all([fsp.statfs(dir), fsp.stat(dir)]);
    return { dev: st.dev, free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

const threads = (() => {
  try {
    return (fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^processor\s*:/gm) || []).length || null;
  } catch {
    return null;
  }
})();

// hwmon sensors, found once: amdgpu (GPU temperature, shader clock, power), k10temp (CPU),
// spd5118/jc42 (memory modules), nvme/drivetemp (disks)
let sensors = null;
export async function findSensors() {
  if (sensors) return sensors;
  const found = { gpu: null, cpu: null, memory: [], storage: [] };
  try {
    for (const h of await fsp.readdir('/sys/class/hwmon')) {
      const dir = `/sys/class/hwmon/${h}`;
      const name = (await fsp.readFile(`${dir}/name`, 'utf8').catch(() => '')).trim();
      if (name === 'amdgpu') found.gpu = dir;
      else if (name === 'k10temp') found.cpu = dir;
      else if (name === 'spd5118' || name === 'jc42') found.memory.push(dir);
      else if (name === 'nvme' || name === 'drivetemp') {
        found.storage.push({ dir, device: await fsp.realpath(`${dir}/device`).catch(() => null) });
      }
    }
  } catch {}
  sensors = found;
  return sensors;
}

// The temperature sensor of the disk holding a directory: the block device (a partition, or the
// disks under an LVM/RAID volume) lives below the sysfs path of the NVMe controller or SATA device
const diskSensors = new Map();
async function diskSensor(dev) {
  if (diskSensors.has(dev)) return diskSensors.get(dev);
  const { storage } = await findSensors();
  const major = Math.floor(dev / 256) & 0xfff;
  const minor = (dev & 0xff) | ((dev >>> 12) & 0xfff00);
  const paths = [];
  const collect = async (p, depth = 0) => {
    const real = await fsp.realpath(p).catch(() => null);
    if (!real) return;
    const slaves = await fsp.readdir(`${real}/slaves`).catch(() => []);
    if (slaves.length && depth < 4) for (const sl of slaves) await collect(`/sys/class/block/${sl}`, depth + 1);
    else paths.push(real);
  };
  await collect(`/sys/dev/block/${major}:${minor}`);
  const dirs = storage.filter((x) => x.device && paths.some((p) => p.startsWith(x.device + '/'))).map((x) => x.dir);
  diskSensors.set(dev, dirs);
  return dirs;
}

const cpuCount = (() => {
  try {
    return fs.readdirSync('/sys/devices/system/cpu').filter((d) => /^cpu\d+$/.test(d)).length;
  } catch {
    return 0;
  }
})();

const celsius = (v) => (v == null ? null : Math.round(v / 100) / 10);
const currentMhz = async (f) => {
  try {
    return Number((await fsp.readFile(f, 'utf8')).match(/(\d+)Mhz\s*\*/i)?.[1]) || null;
  } catch {
    return null;
  }
};
const maxTemp = async (dirs) => {
  let max = null;
  for (const d of dirs) {
    const t = await readNumAsync(`${d}/temp1_input`);
    if (t != null) max = Math.max(max ?? -Infinity, t);
  }
  return celsius(max);
};

// Temperatures and clocks. A value the hardware does not report stays null and the UI hides it.
async function sensorSample(s) {
  const hw = await findSensors();
  // CPU: the average current frequency of all cores and the highest one they can reach
  let sum = 0;
  let n = 0;
  let top = 0;
  for (let i = 0; i < cpuCount; i++) {
    const f = await readNumAsync(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
    if (f) {
      sum += f;
      n++;
    }
    if (!cpuMaxMhz) top = Math.max(top, (await readNumAsync(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`)) || 0);
  }
  if (!cpuMaxMhz && top) cpuMaxMhz = Math.round(top / 1000);
  s.cpuMhz = n ? Math.round(sum / n / 1000) : null;
  s.cpuMaxMhz = cpuMaxMhz;
  s.cpuTemp = hw.cpu ? celsius(await readNumAsync(`${hw.cpu}/temp1_input`)) : null;
  // GPU: temperature, the current shader clock and the power of the whole APU package
  if (hw.gpu) {
    s.gpuTemp = celsius(await readNumAsync(`${hw.gpu}/temp1_input`));
    const sclk = await readNumAsync(`${hw.gpu}/freq1_input`);
    s.gpuMhz = sclk ? Math.round(sclk / 1e6) : null;
    const p = (await readNumAsync(`${hw.gpu}/power1_average`)) ?? (await readNumAsync(`${hw.gpu}/power1_input`));
    s.powerW = p == null ? null : Math.round(p / 1e5) / 10;
  }
  if (gpuDir) {
    if (!s.gpuMhz) s.gpuMhz = await currentMhz(`${gpuDir}/pp_dpm_sclk`);
    s.gpuMaxMhz = maxShaderClock();
    // Memory clock and fabric clock as the GPU driver sees them (the APU shares the memory controller)
    s.memMhz = await currentMhz(`${gpuDir}/pp_dpm_mclk`);
    s.fabricMhz = await currentMhz(`${gpuDir}/pp_dpm_fclk`);
  }
  s.memTemp = await maxTemp(hw.memory);
}
let cpuMaxMhz = null;

let snapshot = {};
let sizes = { models: 0, output: 0, at: 0 };

async function sample() {
  const s = { cpuBusy: await cpuUsage() };
  if (gpuDir) {
    // One file at a time: a stalled amdgpu read then occupies one libuv worker thread, not the whole
    // pool that log and jobs.json writes share
    const files = { gttUsed: 'mem_info_gtt_used', gttTotal: 'mem_info_gtt_total', vramUsed: 'mem_info_vram_used',
      vramTotal: 'mem_info_vram_total', gpuBusy: 'gpu_busy_percent' };
    for (const [key, f] of Object.entries(files)) s[key] = await readNumAsync(`${gpuDir}/${f}`);
  }
  try {
    const mi = await fsp.readFile('/proc/meminfo', 'utf8');
    const kb = (k) => Number(mi.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1]) * 1024;
    s.memTotal = kb('MemTotal');
    s.memAvailable = kb('MemAvailable');
  } catch {}
  // Directory sizes change slowly and walking them is the most expensive part: once a minute
  if (Date.now() - sizes.at > 60000) {
    sizes = { models: await dirSize(config.dirs.models), output: await dirSize(config.dirs.output), at: Date.now() };
  }
  const [models, data] = await Promise.all([disk(config.dirs.models), disk(config.dirs.output)]);
  const temp = async (d) => (d ? maxTemp(await diskSensor(d.dev)) : null);
  s.storage = {
    models: models && { free: models.free, total: models.total, used: sizes.models, temp: await temp(models) },
    data: data && { free: data.free, total: data.total, used: sizes.output, sameDisk: models?.dev === data.dev, temp: await temp(data) },
  };
  await sensorSample(s).catch(() => {});
  s.sampledAt = Date.now();
  snapshot = s;
}

// A new sample starts only after the previous one finished, so a stalled read cannot pile up
(async function loop() {
  await sample().catch(() => {});
  setTimeout(loop, 2000).unref();
})();

// The amdgpu sysfs directory of the GPU (null without one), for the telemetry collector
export const gpuDevDir = () => gpuDir;

export function systemInfo() {
  return { ...info, threads, ...snapshot };
}
