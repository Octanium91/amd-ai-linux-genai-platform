// The Ryzen AI NPU (XDNA): whether the machine has one, which generation, whether its driver and
// firmware are up, and what it could run. The platform does not use the NPU; it only knows about it
// (System page, /api/state, telemetry). Everything is read from sysfs, which a container sees
// without the device being passed to it:
//   /sys/bus/pci/devices/<addr>/{vendor,device,revision}   the chip
//   …/driver → amdxdna                                     the kernel driver (in the kernel since 6.14)
//   …/{vbnv,fw_version}                                    the driver's name for it, the running firmware
//   /sys/class/accel/accel<N>                              the device node the driver created
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
