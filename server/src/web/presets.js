// Presets are ready-made generation modes (video, images) assembled from catalog models.
import path from 'node:path';
import { config } from '../common/config.js';
import { isInstalled, loadCatalog } from './models.js';
import { readJson, statePath } from '../common/store.js';

export function loadPresets() {
  const base = readJson(path.join(config.catalogDir, 'presets.json'), []);
  const local = readJson(statePath('presets.local.json'), []);
  const map = new Map(base.map((p) => [p.id, p]));
  for (const p of local) map.set(p.id, { ...(map.get(p.id) || {}), ...p });
  return [...map.values()];
}

// Model roles in a preset: model, diffusion, vae, t5xxl, clip_vision, motion_module, high_noise
// plus any extra roles (e.g. LoRA) that are only used to check that files are present.
export function presetModels(preset, catalog = loadCatalog()) {
  return Object.entries(preset.models || {}).map(([role, id]) => ({
    role,
    id,
    entry: catalog.find((m) => m.id === id),
  }));
}

// What a mode can be used for. A mode may list its tasks in catalog/presets.json (`tasks`);
// otherwise they follow from whether it takes an image (`image`: none, optional, required).
//   image: create (text → image), rework (image → image), inpaint (repaint a masked part),
//          upscale (a dedicated upscaler mode)
//   video: create (text → video), animate (the photo is the first frame),
//          reference (a person or object from a photo in a new video), restyle (video → video)
export const TASK_INPUTS = {
  create: {},
  rework: { image: true },
  inpaint: { image: true, mask: true },
  upscale: { image: true, noPrompt: true },
  animate: { image: true },
  reference: { image: true },
  restyle: { video: true, imageOptional: true },
};

export function presetTasks(p) {
  if (Array.isArray(p.tasks)) return p.tasks.filter((t) => TASK_INPUTS[t]);
  const image = p.image || 'none';
  if (p.kind === 'video') return image === 'none' ? ['create'] : image === 'required' ? ['animate'] : ['create', 'animate'];
  return image === 'none' ? ['create'] : image === 'required' ? ['rework', 'inpaint'] : ['create', 'rework', 'inpaint'];
}

export function presetsWithAvailability() {
  const catalog = loadCatalog();
  return loadPresets().map((p) => {
    const models = presetModels(p, catalog);
    const missing = models.filter((m) => !m.entry || !isInstalled(m.entry));
    return {
      ...p,
      tasks: presetTasks(p),
      available: missing.length === 0,
      missing: missing.map((m) => ({
        id: m.id,
        name: m.entry?.name || m.id,
        size: m.entry?.size || 0,
        unknown: !m.entry,
      })),
    };
  });
}

// Hidden start templates (catalog/templates.json): a prompt plus tested parameters.
// The UI fills the form with a random template on open; templates cannot be picked manually.
export function loadTemplates() {
  const t = readJson(path.join(config.catalogDir, 'templates.json'), {});
  const neg = t.negatives || {};
  const out = {};
  for (const kind of ['image', 'video']) {
    const d = t.defaults?.[kind] || {};
    out[kind] = (t[kind] || []).map(({ negative, preset, ...x }) => {
      const n = negative ?? d.negative;
      return {
        ...d,
        ...x,
        kind,
        presetId: preset || d.preset,
        negative: neg[n] ?? n ?? '',
      };
    }).map(({ preset, ...x }) => x);
  }
  return out;
}
