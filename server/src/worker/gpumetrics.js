// The amdgpu gpu_metrics table: what the SMU firmware itself reports on Ryzen AI APUs, including
// the clock limits it enforces and its throttle residency counters. Only format 3.0 (struct
// gpu_metrics_v3_0 in the kernel's kgd_pp_interface.h, used by Strix Point, Krackan Point and Strix
// Halo) is decoded; other formats return null. Fields the firmware does not fill are all ones.
import fs from 'node:fs';

const fsp = fs.promises;

// Throttle residency counters: what limited the chip. Thermal reasons mean overheating; power
// reasons (sustained/fast/slow power limits) are the normal ceiling of a small machine.
export const THERMAL_REASONS = ['prochot', 'thm_core', 'thm_gfx', 'thm_soc'];
export const POWER_REASONS = ['spl', 'fppt', 'sppt'];
const REASONS = ['prochot', 'spl', 'fppt', 'sppt', 'thm_core', 'thm_gfx', 'thm_soc'];

export function parseGpuMetrics(buf) {
  if (!buf || buf.length < 4) return null;
  const size = buf.readUInt16LE(0);
  const format = buf[2];
  const content = buf[3];
  if (format !== 3 || content !== 0 || size < 260 || buf.length < 260) return null;
  const u16 = (o) => { const v = buf.readUInt16LE(o); return v === 0xffff ? null : v; };
  const u32 = (o) => { const v = buf.readUInt32LE(o); return v === 0xffffffff ? null : v; };
  const centi = (o) => { const v = u16(o); return v == null || v === 0 ? null : v / 100; };
  const cores = [];
  for (let i = 0; i < 16; i++) {
    const t = centi(8 + i * 2);
    if (t != null) cores.push(t);
  }
  const throttle = {};
  REASONS.forEach((r, i) => { throttle[r] = u32(228 + i * 4); });
  return {
    tempGfx: centi(4),
    tempSoc: centi(6),
    tempCoreMax: cores.length ? Math.max(...cores) : null,
    gfxBusy: u16(42),
    socketPowerMw: u32(112),
    gfxPowerMw: u32(124),
    corePowerMw: u32(132),
    stapmLimitMw: u16(170),
    stapmCurrentLimitMw: u16(172),
    gfxclkMhz: u16(174),
    socclkMhz: u16(176),
    fclkMhz: u16(182),
    uclkMhz: u16(186),
    coreMaxMhz: u16(222),
    gfxMaxMhz: u16(224),
    throttle,
  };
}

export async function readGpuMetrics(gpuDir) {
  if (!gpuDir) return null;
  try {
    return parseGpuMetrics(await fsp.readFile(`${gpuDir}/gpu_metrics`));
  } catch {
    return null;
  }
}

// How much every throttle counter grew between two readings (null for a counter the chip lacks)
export function throttleDelta(prev, cur) {
  if (!prev?.throttle || !cur?.throttle) return null;
  const d = {};
  for (const r of REASONS) {
    const a = prev.throttle[r];
    const b = cur.throttle[r];
    d[r] = a == null || b == null ? null : Math.max(0, b - a);
  }
  return d;
}

export const activeReasons = (delta, list) => (delta ? list.filter((r) => delta[r] > 0) : []);
