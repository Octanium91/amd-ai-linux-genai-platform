// Turns a form submission into validated job parameters plus a snapshot of the mode (`spec`)
// for the worker. The worker never reads the catalog: everything it needs travels with the job.
import crypto from 'node:crypto';
import { loadCatalog } from './models.js';
import { presetModels } from './presets.js';

// Output frame rates: the model's own and 2× / 3× of it by interpolation, at most 48 (more would be
// mostly invented frames). A mode lists its own in defaults.outFpsOptions.
export function outFpsOptions(preset) {
  const d = preset.defaults || {};
  const fps = d.nativeFps ?? 24;
  return d.outFpsOptions || [fps, fps * 2, fps * 3].filter((f, i) => i === 0 || f <= 48);
}

// A long video is a storyboard: one prompt per part. Parts left empty use the main prompt.
const MAX_PART_PROMPT = 1500;
function partPrompts(body, segments, prompt) {
  let list = body.prompts;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || segments < 2) return null;
  const out = Array.from({ length: segments }, (_, i) => String(list[i] ?? '').trim().slice(0, MAX_PART_PROMPT) || prompt);
  return out.some((x) => x !== prompt) ? out : null;
}

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

// How a video is generated: frames per model pass and the number of passes (segments).
// segmentFrames is the length the model was trained on and the default pass; longer passes, up to
// maxFrames, are possible but the result stops following the prompt. A longer video is built from
// up to maxSegments passes, each continuing from the last frame of the previous one.
// Wan needs 4n+1 frames, AnimateDiff exactly duration × fps. The UI has the same function (GenerateForm.jsx).
export function videoPlan(preset, duration, segmentFrames) {
  const d = preset.defaults || {};
  const fps = d.nativeFps ?? 24;
  const exact = d.frameRule === 'exact';
  const hardMax = d.maxFrames ?? 121;
  const minFrames = d.minFrames ?? 5;
  const trained = Math.min(hardMax, d.segmentFrames ?? hardMax);
  // A clip of f frames lasts f / fps; every seam between passes drops one repeated frame
  const seconds = (f) => f / fps;
  const total = (f, n) => (f * n - (n - 1)) / fps;
  let seg = Number(segmentFrames) > 0 ? Math.round(Number(segmentFrames)) : trained;
  if (!exact) seg = Math.round((seg - 1) / 4) * 4 + 1;
  seg = Math.min(hardMax, Math.max(minFrames, seg));
  const extendable = preset.kind === 'video' && preset.image !== 'none';
  const maxSegments = extendable ? Math.max(1, d.maxSegments ?? 2) : 1;
  const segSeconds = seconds(seg);
  const maxDuration = total(seg, maxSegments);
  const wanted = Math.min(maxDuration, Math.max(0.5, Number(duration) || d.duration || 2));
  let segments = 1;
  while (segments < maxSegments && total(seg, segments) < wanted - 1e-6) segments++;
  // Frames per pass so that the passes joined at their seams give the wanted length
  const perPass = (wanted * fps + segments - 1) / segments;
  const frames = Math.min(seg, Math.max(minFrames, exact ? Math.ceil(perPass - 1e-6) : Math.round((perPass - 1) / 4) * 4 + 1));
  return {
    frames, segments, fps, segmentFrames: seg, trainedFrames: trained, segSeconds, maxDuration, maxSegments, extendable,
    // The real length of the joined clip
    duration: total(frames, segments), beyondTraining: frames > trained,
  };
}

// "Extra" is twice the steps of "High" unless the preset defines its own value
export function qualitySteps(d, quality) {
  const q = d.quality || {};
  if (quality === 'extra') return q.extra ?? (q.high ? q.high * 2 : null);
  return q[quality] ?? null;
}

export function jobParams(preset, body, image, inputs = {}) {
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
    task: inputs.task || null,
  };
  // Upscaling: the size is the result's (the photo ×4), shown on the job card
  if (inputs.task === 'upscale') {
    params.width = Math.round(Number(body.width)) || null;
    params.height = Math.round(Number(body.height)) || null;
    params.count = 1;
  }
  if (inputs.mask) params.mask = inputs.mask;
  if (inputs.video) {
    params.video = inputs.video;
    // What the control video keeps: contours (motion and shapes) or grayscale (more of the original)
    params.control = body.control === 'gray' ? 'gray' : 'edges';
  }
  // The soundtrack: an uploaded audio file from audioStart seconds, or the sound of the uploaded video
  // (from its start, like the control frames)
  const audio = inputs.audio || (inputs.video && body.audioSource === 'video' ? inputs.video : null);
  if (preset.kind === 'video' && audio) {
    params.audio = audio;
    params.audioStart = audio === inputs.video ? 0 : Math.round(clamp(body.audioStart, 0, 3600, 0) * 10) / 10;
    params.audioFade = body.audioFade !== 'false' && body.audioFade !== false;
  }
  // How far the result may move from the photo (rework, inpaint): the mode's own value when unset
  if (image && ['rework', 'inpaint'].includes(inputs.task) && body.strength != null && body.strength !== '') {
    params.strength = clamp(body.strength, 0.05, 1, null);
  }
  if (preset.kind === 'audio') return Object.assign(params, audioParams(preset, body, inputs.task));
  if (preset.kind === 'image') {
    params.count = Math.round(clamp(body.count, 1, 8, 1));
  } else {
    const plan = videoPlan(preset, body.duration, body.segmentFrames);
    Object.assign(params, {
      frames: plan.frames,
      segments: plan.segments,
      segmentFrames: plan.segmentFrames,
      fps: plan.fps,
      duration: plan.duration,
      outFps: outFpsOptions(preset).includes(Number(body.outFps)) ? Number(body.outFps)
        : outFpsOptions(preset).includes(d.outFps) ? d.outFps : plan.fps,
    });
    const prompts = partPrompts(body, plan.segments, params.prompt);
    if (prompts) params.prompts = prompts;
    // Made of shots: every part starts from its own keyframe; the parts are joined whole
    if (plan.segments > 1 && (body.shots === true || body.shots === 'true')) {
      params.shots = true;
      params.duration = (plan.frames * plan.segments) / plan.fps;
    }
  }
  return params;
}

// Music and sound effects have a length (the mode's range); music may carry lyrics: empty lets the
// model write them, "[Instrumental]" asks for no vocals. Speech has a voice, a language and a speed.
const VOICE = /^[A-Za-z0-9_-]{1,32}$/;
const LANGUAGE = /^[a-z]{2}(-[a-z]{2})?$/;
function audioParams(preset, body, task) {
  const d = preset.defaults || {};
  const out = { count: 1, width: null, height: null, cfg: null, sampler: null, flowShift: null, negative: '' };
  if (task === 'speech') {
    out.voice = VOICE.test(body.voice || '') ? body.voice : d.voice || null;
    out.language = LANGUAGE.test(body.language || '') ? body.language : d.language || 'en';
    out.speed = Math.round(clamp(body.speed, 0.5, 2, d.speed ?? 1) * 100) / 100;
  } else {
    out.duration = Math.round(clamp(body.duration, d.minDuration ?? 1, d.maxDuration ?? 30, d.duration ?? 10));
  }
  if (task === 'music') {
    const lyrics = String(body.lyrics ?? '').trim().slice(0, 4000);
    out.lyrics = body.lyricsMode === 'instrumental' ? '[Instrumental]' : body.lyricsMode === 'auto' ? '' : lyrics;
  }
  return out;
}

// The image modes that can draw keyframes, best first: fast SDXL, then Z-Image (follows several
// characters best), then full SDXL, then SD 1.5
export const KEYFRAME_ORDER = ['img-realvisxl-lightning', 'img-z-image-turbo', 'img-realvisxl', 'img-realistic-vision'];

// The keyframe spec of a shot video: the image mode's models and flags plus its settings, at the
// mode's own pixel count in the shape of the video (the worker fits it to the video size)
export function keyframeSpec(preset, width, height) {
  const d = preset.defaults || {};
  const area = (d.width || 512) * (d.height || 512);
  const aspect = width / height;
  const r64 = (v) => Math.max(256, Math.min(2048, Math.round(v / 64) * 64));
  return {
    ...jobSpec(preset),
    kind: 'image',
    presetId: preset.id,
    params: {
      width: r64(Math.sqrt(area * aspect)),
      height: r64(Math.sqrt(area / aspect)),
      steps: qualitySteps(d, 'normal') ?? d.steps ?? 20,
      cfg: d.cfg ?? 5,
      sampler: d.sampler || 'euler',
      negative: d.negative ?? '',
    },
  };
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
    engine: preset.engine || null,
    extraArgs: preset.extraArgs || [],
  };
}
