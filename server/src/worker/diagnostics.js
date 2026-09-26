// Platform self-check: GPU/Vulkan, CPU family, kernel, GTT, the unified Vulkan heap, engine, disk.
// Each check returns { id, status: ok|warn|fail|info, params }; the UI owns the texts and advice
// (so they can be translated), the server only reports facts.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { config } from '../common/config.js';

const GB = 1024 ** 3;
const run = (cmd, args, timeout = 20000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout = '', stderr = '') => {
    resolve({ ok: !err, out: String(stdout), err: err ? String(stderr || err.message) : '' });
  });
});

const readNum = (f) => {
  try {
    return Number(fs.readFileSync(f, 'utf8').trim());
  } catch {
    return null;
  }
};

function gpuSysfs() {
  try {
    const card = fs.readdirSync('/sys/class/drm').find(
      (d) => /^card\d+$/.test(d) && fs.existsSync(`/sys/class/drm/${d}/device/mem_info_gtt_total`),
    );
    if (!card) return null;
    const dir = `/sys/class/drm/${card}/device`;
    return { gtt: readNum(`${dir}/mem_info_gtt_total`), vram: readNum(`${dir}/mem_info_vram_total`) };
  } catch {
    return null;
  }
}

function cpuInfo() {
  try {
    const s = fs.readFileSync('/proc/cpuinfo', 'utf8');
    return {
      model: s.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() || null,
      vendor: s.match(/^vendor_id\s*:\s*(.+)$/m)?.[1]?.trim() || null,
    };
  } catch {
    return {};
  }
}

function meminfo() {
  try {
    const s = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number(s.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
    return { total: kb('MemTotal'), swap: kb('SwapTotal') };
  } catch {
    return {};
  }
}

// Largest DEVICE_LOCAL heap reported by Vulkan (with the unified heap it equals GTT)
function deviceLocalHeap(vulkaninfo) {
  let max = 0;
  for (const chunk of vulkaninfo.split(/memoryHeaps\[\d+\]:/).slice(1)) {
    const block = chunk.split(/memoryHeaps\[\d+\]:|memoryTypes/)[0];
    const size = Number(block.match(/size\s*=\s*(\d+)/)?.[1] || 0);
    if (/DEVICE_LOCAL/.test(block)) max = Math.max(max, size);
  }
  return max;
}

function family(text) {
  if (/8060S|8050S|8040S|Ryzen AI MAX/i.test(text)) return 'Strix Halo';
  if (/890M|880M|Ryzen AI 9/i.test(text)) return 'Strix Point';
  if (/860M|840M|Ryzen AI [57] 3[34]0/i.test(text)) return 'Krackan Point';
  return null;
}

async function collect() {
  const checks = [];
  const add = (id, status, params = {}) => checks.push({ id, status, params });

  // --- GPU through Vulkan: the exact device sd.cpp will use ---
  const summary = await run('vulkaninfo', ['--summary']);
  const devices = [...summary.out.matchAll(/deviceName\s*=\s*(.+)/g)].map((m) => m[1].trim());
  const drivers = [...summary.out.matchAll(/driverName\s*=\s*(.+)/g)].map((m) => m[1].trim());
  const gi = devices.findIndex((n) => !/llvmpipe/i.test(n));
  const gpu = gi >= 0 ? devices[gi] : null;
  const driver = gi >= 0 ? drivers[gi] : null;
  if (!summary.ok && !devices.length) add('gpu', 'fail', { reason: 'no-vulkan' });
  else if (!gpu) add('gpu', 'fail', { reason: 'llvmpipe' });
  else if (!/radv/i.test(driver || '')) add('gpu', 'warn', { gpu, driver });
  else add('gpu', 'ok', { gpu, driver });

  // --- render node access (device passthrough + group permissions) ---
  const node = '/dev/dri/renderD128';
  if (!fs.existsSync(node)) add('render-node', 'fail', { node, reason: 'missing' });
  else {
    try {
      fs.accessSync(node, fs.constants.R_OK | fs.constants.W_OK);
      add('render-node', 'ok', { node });
    } catch {
      add('render-node', 'fail', { node, reason: 'permission' });
    }
  }

  // --- CPU family and GPU architecture ---
  const cpu = cpuInfo();
  const fam = family(`${gpu || ''} ${cpu.model || ''}`);
  if (fam) add('cpu', 'ok', { cpu: cpu.model, family: fam });
  else if (cpu.vendor === 'AuthenticAMD') add('cpu', 'warn', { cpu: cpu.model, reason: 'amd-other' });
  else add('cpu', 'warn', { cpu: cpu.model, reason: 'not-amd' });

  if (gpu) {
    const arch = gpu.match(/GFX\d+/i)?.[0]?.toUpperCase() || null;
    if (arch && /^GFX115/.test(arch)) add('gpu-arch', 'ok', { arch });
    else add('gpu-arch', 'warn', { arch: arch || gpu });
  }

  // --- kernel (the container sees the host kernel) ---
  const kv = os.release();
  const [kmaj, kmin] = kv.split('.').map(Number);
  add('kernel', kmaj > 6 || (kmaj === 6 && kmin >= 10) ? 'ok' : 'warn', { kernel: kv });

  // --- GTT: how much system RAM the GPU may use ---
  const mem = meminfo();
  const sys = gpuSysfs();
  const recGb = Math.floor(((mem.total || 0) * 0.75) / GB);
  if (!sys?.gtt) add('gtt', 'warn', { reason: 'unknown' });
  else {
    const gttGb = sys.gtt / GB;
    add('gtt', gttGb >= recGb - 2 ? 'ok' : 'warn', {
      gtt: sys.gtt, ram: mem.total, uma: sys.vram, recommendedGb: recGb,
      gttsizeMiB: recGb * 1024, ttmPages: recGb * 262144,
    });
  }

  // --- TTM limit: amdgpu keeps GTT buffers through TTM, which by default holds at most half of the
  // RAM resident. amdgpu.gttsize alone makes GTT larger, but everything above the TTM limit is
  // swapped out: constant swapping, an idle GPU and jobs several times slower
  const ttmPages = readNum('/sys/module/ttm/parameters/pages_limit');
  if (sys?.gtt && ttmPages) {
    const ttm = ttmPages * 4096;
    add('ttm', ttm >= sys.gtt * 0.95 ? 'ok' : 'warn', { ttm, gtt: sys.gtt, pages: Math.ceil(sys.gtt / 4096) });
  }

  // --- unified Vulkan heap: without it Vulkan only offers the small UMA carve-out ---
  if (gpu) {
    const full = await run('vulkaninfo', []);
    const heap = deviceLocalHeap(full.out);
    if (!heap) add('vulkan-heap', 'warn', { reason: 'unknown' });
    else if (sys?.gtt && heap < sys.gtt * 0.8) add('vulkan-heap', 'warn', { heap, gtt: sys.gtt });
    else add('vulkan-heap', 'ok', { heap, gtt: sys?.gtt || null });
  }

  // --- memory needed by the heaviest mode (Wan 2.2 5B peaks at ~22 GB) ---
  if (sys?.gtt) add('video-memory', sys.gtt >= 22 * GB ? 'ok' : 'warn', { gtt: sys.gtt, needGb: 22 });

  // --- swap: GTT and RAM are the same memory, swap protects against the OOM killer ---
  add('swap', mem.swap > 0 ? 'ok' : 'info', { swap: mem.swap || 0 });

  // --- disk space for models ---
  try {
    const s = fs.statfsSync(config.dirs.models);
    const free = s.bavail * s.bsize;
    add('disk', free >= 30 * GB ? 'ok' : free >= 10 * GB ? 'warn' : 'fail', { free, total: s.blocks * s.bsize });
  } catch {
    add('disk', 'warn', { reason: 'unknown' });
  }

  // --- engine and ffmpeg inside the image ---
  const sd = await run(config.sdCli, ['--version'], 10000);
  const sdVersion = sd.out.split('\n')[0].trim();
  add('engine', sd.ok && sdVersion ? 'ok' : 'fail', { version: sdVersion || null });
  const ff = await run('ffmpeg', ['-version'], 10000);
  add('ffmpeg', ff.ok ? 'ok' : 'fail', { version: ff.out.split('\n')[0].replace(/ Copyright.*/, '').trim() || null });

  // --- NPU (informational: not used by the platform yet) ---
  let npu = false;
  try {
    for (const d of fs.readdirSync('/sys/bus/pci/devices')) {
      const b = `/sys/bus/pci/devices/${d}`;
      if (fs.readFileSync(`${b}/vendor`, 'utf8').trim() === '0x1022'
        && ['0x1502', '0x17f0'].includes(fs.readFileSync(`${b}/device`, 'utf8').trim())) npu = true;
    }
  } catch {}
  add('npu', 'info', { present: npu, driver: fs.existsSync('/dev/accel') });

  const worst = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { checks, status: worst, at: Date.now() };
}

let cache = null;
let pending = null;
export async function diagnostics(refresh = false) {
  if (!refresh && cache && Date.now() - cache.at < 60000) return cache;
  pending ??= collect().then((r) => {
    cache = r;
    pending = null;
    return r;
  });
  return pending;
}

// Log problems at startup so they are visible in `docker compose logs`
export async function logDiagnostics() {
  const r = await diagnostics(true);
  for (const c of r.checks.filter((x) => x.status === 'fail' || x.status === 'warn')) {
    console.warn(`[diagnostics] ${c.status.toUpperCase()} ${c.id} ${JSON.stringify(c.params)}`);
  }
  if (r.status === 'ok') console.log('[diagnostics] all checks passed');
}
