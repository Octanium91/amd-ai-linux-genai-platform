// The Ryzen AI NPU (XDNA): whether the machine has one, which generation, whether its driver and
// firmware are up, what it could run and how busy it is. The worker itself does not use the NPU: the
// web container's prompt assistant can, through a FastFlowLM server (web/prompt.js). Shown on the
// System page and in the system bar, returned in /api/state. Everything is read from sysfs, which a container sees
// without the device being passed to it:
//   /sys/bus/pci/devices/<addr>/{vendor,device,revision}   the chip
//   …/driver → amdxdna                                     the kernel driver (in the kernel since 6.14)
//   …/{vbnv,fw_version}                                    the driver's name for it, the running firmware
//   …/accel/accel<N>                                       the device node the driver created
//   …/power/{runtime_status,runtime_active_time}           whether it is powered, and for how long
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// AMD NPUs by PCI device id. XDNA 2 (Strix Point, Strix Halo, Krackan Point) is the one the Linux
// language-model runtimes support; the first XDNA (Phoenix, Hawk Point) is not.
const KNOWN = {
  '0x1502': { generation: 1, family: 'XDNA' },
  '0x17f0': { generation: 2, family: 'XDNA 2' },
};
const AMD = '0x1022';
const DRIVER = 'amdxdna';
// What FastFlowLM and Lemonade ask for (November 2026)
const LLM_KERNEL = [7, 0];
const LLM_FIRMWARE = [1, 1, 0, 0];

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

// Compares dotted versions number by number: 1.1.2.64 against 1.1.0.0, 7.2.12+deb13 against 7.0
const atLeast = (version, min) => {
  const v = String(version || '').split(/[.+-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < min.length; i++) {
    const n = Number.isFinite(v[i]) ? v[i] : 0;
    if (n !== min[i]) return n > min[i];
  }
  return true;
};

const driverOf = (dev) => {
  try {
    return path.basename(fs.readlinkSync(`${dev}/driver`));
  } catch {
    return null;
  }
};

// The NPU's sysfs directory, remembered for the load samples
let devicePath = null;

// Load. The driver has no utilisation counter, but the kernel's runtime power management keeps the
// time the NPU was powered: it wakes for work and powers down a few seconds after the last of it.
// The share of that time between two samples is the load (0–100); short bursts read a little
// high because of the power-down delay. `active` is whether it is powered right now.
let lastLoad = null;
export function npuLoad(dev = devicePath, now = Date.now()) {
  if (!dev) return null;
  const status = read(`${dev}/power/runtime_status`);
  const activeMs = Number(read(`${dev}/power/runtime_active_time`));
  if (!status || !Number.isFinite(activeMs)) return null;
  let busy = null;
  if (lastLoad && lastLoad.dev === dev && now > lastLoad.at) {
    busy = Math.max(0, Math.min(100, Math.round(((activeMs - lastLoad.activeMs) / (now - lastLoad.at)) * 100)));
  }
  lastLoad = { dev, at: now, activeMs };
  return { active: status === 'active', busy };
}

// state: 'absent'     no NPU on the PCI bus
//        'no-driver'  the chip is there, the driver is not bound (kernel older than 6.14, module missing)
//        'no-device'  the driver is bound but the NPU did not start (usually its firmware is missing)
//        'ready'      driver, firmware and device node are all there
// llm: whether the language-model runtimes can use it; llmBlock says what is missing otherwise
//      ('state', 'generation', 'kernel' or 'firmware')
export function npuInfo(sys = '/sys', kernel = os.release()) {
  const none = { present: false, state: 'absent', driver: null, llm: false, llmBlock: 'state' };
  let found = null;
  try {
    for (const d of fs.readdirSync(`${sys}/bus/pci/devices`)) {
      const dev = `${sys}/bus/pci/devices/${d}`;
      const device = read(`${dev}/device`);
      const driver = driverOf(dev);
      // A chip the table does not know yet still counts when the NPU driver took it
      if ((read(`${dev}/vendor`) === AMD && KNOWN[device]) || driver === DRIVER) {
        found = { dev, device, driver };
        break;
      }
    }
  } catch {}
  if (!found) return none;

  const { dev, device, driver } = found;
  devicePath = dev;
  const known = KNOWN[device] || { generation: null, family: 'XDNA' };
  const firmware = driver ? read(`${dev}/fw_version`) : null;
  let node = null;
  try {
    node = fs.readdirSync(`${dev}/accel`).find((n) => /^accel\d+$/.test(n)) || null;
  } catch {}
  const state = driver !== DRIVER ? 'no-driver' : node && firmware ? 'ready' : 'no-device';
  const llmBlock = state !== 'ready' ? 'state'
    : known.generation !== 2 ? 'generation'
      : !atLeast(kernel, LLM_KERNEL) ? 'kernel'
        : !atLeast(firmware, LLM_FIRMWARE) ? 'firmware' : null;
  return {
    present: true,
    state,
    id: `${(read(`${dev}/vendor`) || AMD).replace('0x', '')}:${(device || '').replace('0x', '')}`,
    revision: read(`${dev}/revision`),
    family: known.family,
    generation: known.generation,
    // The driver's own name for the chip, e.g. "NPU Strix"
    name: driver ? read(`${dev}/vbnv`) : null,
    driver: driver === DRIVER ? DRIVER : null,
    firmware,
    node,
    kernel,
    llm: !llmBlock,
    llmBlock,
  };
}
