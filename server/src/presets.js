// Пресеты — готовые режимы генерации (видео, изображения), собранные из моделей каталога.
import path from 'node:path';
import { config } from './config.js';
import { isInstalled, loadCatalog } from './models.js';
import { readJson, statePath } from './store.js';

export function loadPresets() {
  const base = readJson(path.join(config.catalogDir, 'presets.json'), []);
  const local = readJson(statePath('presets.local.json'), []);
  const map = new Map(base.map((p) => [p.id, p]));
  for (const p of local) map.set(p.id, { ...(map.get(p.id) || {}), ...p });
  return [...map.values()];
}

// Роли моделей в пресете: model, diffusion, vae, t5xxl, clip_vision, motion_module, high_noise
// плюс любые дополнительные (например, LoRA) — они нужны только для проверки наличия.
export function presetModels(preset, catalog = loadCatalog()) {
  return Object.entries(preset.models || {}).map(([role, id]) => ({
    role,
    id,
    entry: catalog.find((m) => m.id === id),
  }));
}

export function presetsWithAvailability() {
  const catalog = loadCatalog();
  return loadPresets().map((p) => {
    const models = presetModels(p, catalog);
    const missing = models.filter((m) => !m.entry || !isInstalled(m.entry));
    return {
      ...p,
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

// Скрытые стартовые шаблоны (catalog/templates.json): промпт + проверенные параметры.
// Интерфейс подставляет случайный шаблон при открытии; выбрать шаблон вручную нельзя.
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
