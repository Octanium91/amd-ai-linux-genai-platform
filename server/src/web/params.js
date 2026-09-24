// Turns a form submission into validated job parameters plus a snapshot of the mode (`spec`)
// for the worker. The worker never reads the catalog: everything it needs travels with the job.
import crypto from 'node:crypto';
import { loadCatalog } from './models.js';
import { presetModels } from './presets.js';

const OUT_FPS = [24, 30, 50, 60, 120];

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

// Wan needs 4n+1 frames; AnimateDiff takes exactly duration × fps (16 works best)
function planFrames(d, duration) {
  const nativeFps = d.nativeFps ?? 24;
  const raw = duration * nativeFps;
  const frames = d.frameRule === 'exact' ? Math.round(raw) : Math.round(raw / 4) * 4 + 1;
  return Math.min(d.maxFrames ?? 121, Math.max(d.minFrames ?? 5, frames));
}

// "Extra" is twice the steps of "High" unless the preset defines its own value
export function qualitySteps(d, quality) {
  const q = d.quality || {};
  if (quality === 'extra') return q.extra ?? (q.high ? q.high * 2 : null);
  return q[quality] ?? null;
}

// Single-pass model limit and the extra limit (two segments chained via image-to-video)
export function durationLimits(preset) {
  const d = preset.defaults || {};
  const nativeFps = d.nativeFps ?? 24;
  const maxFrames = d.maxFrames ?? 121;
  const base = (d.frameRule === 'exact' ? maxFrames : maxFrames - 1) / nativeFps;
  const extendable = preset.kind === 'video' && preset.image !== 'none';
  return { base, max: extendable ? base * 2 : base, extendable };
}

export function jobParams(preset, body, image) {
  const d = preset.defaults || {};
  const round16 = (v) => Math.round(v / 16) * 16;
  const quality = qualitySteps(d, body.quality) != null ? body.quality : 'normal';
  let seed = Math.trunc(Number(body.seed));
  if (!Number.isFinite(seed) || seed < 0) seed = crypto.randomInt(0, 2 ** 31 - 1);

  const params = {
    kind: preset.kind,
    presetId: preset.id,
    presetName: preset.name,
    prompt: String(body.prompt || '').trim(),
    negative: String(body.negative ?? '').trim(),
    width: round16(clamp(body.width, 128, 2048, d.width ?? 512)),
    height: round16(clamp(body.height, 128, 2048, d.height ?? 512)),
    quality,
    steps: qualitySteps(d, quality) ?? d.steps ?? 20,
    cfg: clamp(body.cfg, 0, 30, d.cfg ?? 7),
    flowShift: d.flowShift == null ? null : clamp(body.flowShift, 0, 30, d.flowShift),
    sampler: /^[a-z0-9_+]+$/.test(body.sampler || '') ? body.sampler : d.sampler || 'euler',
    seed,
    image,
  };
  if (preset.kind === 'image') {
    params.count = Math.round(clamp(body.count, 1, 8, 1));
  } else {
    const nativeFps = d.nativeFps ?? 24;
    const exact = d.frameRule === 'exact';
    const lim = durationLimits(preset);
    const duration = clamp(body.duration, 0.5, lim.max, d.duration ?? 2);
    // Longer than the model limit: two segments, the second continues from the last frame of the first
    const segments = duration > lim.base + 1e-6 ? 2 : 1;
    const frames = planFrames(d, duration / segments);
    const segSeconds = (exact ? frames : frames - 1) / nativeFps;
    Object.assign(params, {
      frames,
      segments,
      fps: nativeFps,
      duration: segSeconds * segments,
      outFps: OUT_FPS.includes(Number(body.outFps)) ? Number(body.outFps) : d.outFps ?? nativeFps,
    });
  }
  return params;
}

// What the worker needs to build the sd-cli command: model files by role and the mode's flags
export function jobSpec(preset) {
  const catalog = loadCatalog();
  return {
    kind: preset.kind,
    models: presetModels(preset, catalog).map(({ role, id, entry }) => ({ role, id, name: entry?.name || id, file: entry?.file })),
    loraDir: preset.loraDir || null,
    promptSuffix: preset.promptSuffix || '',
    imageArgs: preset.imageArgs || [],
    continueArgs: preset.continueArgs || null,
    preview: preset.preview || null,
    extraArgs: preset.extraArgs || [],
  };
}
