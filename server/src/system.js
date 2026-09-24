// Сведения о железе: APU, iGPU (через Vulkan), унифицированная память, GTT и NPU.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const readNum = (f) => {
  try {
    return Number(fs.readFileSync(f, 'utf8').trim());
  } catch {
    return null;
  }
};

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

// NPU XDNA (Ryzen AI) виден на PCI как 1022:1502 / 1022:17f0; драйвер amdxdna даёт /dev/accel
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

// Семейство Ryzen AI по имени iGPU — для подсказок в интерфейсе и документации
function platformFamily(gpu = '', cpu = '') {
  const s = `${gpu} ${cpu}`;
  if (/8060S|8050S|8040S|Ryzen AI MAX/i.test(s)) return 'Strix Halo';
  if (/890M|880M|Ryzen AI 9/i.test(s)) return 'Strix Point';
  if (/860M|840M|Ryzen AI [57] 3[34]0/i.test(s)) return 'Krackan Point';
  return null;
}

const info = { cpu: cpuModel(), gpu: null, driver: null, npu: npuInfo(), family: null };

// Имя GPU берём у самого Vulkan: это ровно то устройство, на котором будет считать sd.cpp
execFile('vulkaninfo', ['--summary'], { timeout: 20000 }, (err, stdout = '') => {
  const devs = [...stdout.matchAll(/deviceName\s*=\s*(.+)/g)].map((m) => m[1].trim());
  const drivers = [...stdout.matchAll(/driverInfo\s*=\s*(.+)/g)].map((m) => m[1].trim());
  const i = devs.findIndex((n) => !/llvmpipe/i.test(n));
  info.gpu = i >= 0 ? devs[i] : devs[0] || null;
  info.driver = i >= 0 ? drivers[i] : null;
  info.family = platformFamily(info.gpu, info.cpu);
  if (!info.gpu || /llvmpipe/i.test(info.gpu)) {
    console.warn('[system] Vulkan не видит GPU (только llvmpipe): проверьте проброс /dev/dri и группы render/video');
  } else {
    console.log(`[system] ${info.cpu} · ${info.gpu} · ${info.driver}`);
  }
});

export function systemInfo() {
  const s = { ...info };
  if (gpuDir) {
    s.gttUsed = readNum(`${gpuDir}/mem_info_gtt_used`);
    s.gttTotal = readNum(`${gpuDir}/mem_info_gtt_total`);
    s.vramTotal = readNum(`${gpuDir}/mem_info_vram_total`);
    s.gpuBusy = readNum(`${gpuDir}/gpu_busy_percent`);
  }
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number(mi.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1]) * 1024;
    s.memTotal = kb('MemTotal');
    s.memAvailable = kb('MemAvailable');
  } catch {}
  return s;
}
