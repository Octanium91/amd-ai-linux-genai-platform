// The "to prompt" assistant: an Ollama model turns the user's idea (in any language) into an
// English prompt written for the mode that will run it. Administrators connect the Ollama server
// in Settings; the button in the form is active only while the configured model is available.
// Ollama API: POST /api/chat (stream: false, format: JSON schema), GET /api/tags, POST /api/show.
import { readSettings } from '../common/settings.js';
import { loadCatalog } from './models.js';
import { loadPresets } from './presets.js';

// A base URL without a trailing slash, or null when it is not an http(s) URL
export function ollamaUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function ollama(base, path, body, timeoutMs = 8000) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!r.ok) throw new Error(data?.error || `Ollama answered ${r.status}`);
  return data;
}

// Ollama reports "dolphin-phi" as "dolphin-phi:latest"
const sameModel = (a, b) => a === b || a === `${b}:latest` || `${a}:latest` === b;

export async function listModels(base) {
  const [tags, version] = await Promise.all([ollama(base, '/api/tags'), ollama(base, '/api/version').catch(() => null)]);
  return {
    version: version?.version || null,
    models: (tags?.models || []).map((m) => ({ name: m.name, size: m.size, parameters: m.details?.parameter_size || null })),
  };
}

// Whether the button can work: checked at most every 30 s, the form asks on load and now and then
let cached = { at: 0, key: '', value: null };
export async function assistantStatus(force = false) {
  const s = readSettings().promptAssistant;
  const key = `${s.enabled}|${s.url}|${s.model}`;
  if (!force && cached.key === key && Date.now() - cached.at < 30000) return cached.value;
  let value = { enabled: s.enabled, ready: false, model: s.model };
  if (s.enabled) {
    try {
      const { models } = await listModels(s.url);
      value = models.some((m) => sameModel(m.name, s.model))
        ? { ...value, ready: true }
        : { ...value, error: 'The model is not installed on the Ollama server' };
    } catch (e) {
      value = { ...value, error: 'The Ollama server is not reachable' };
      console.warn(`[prompt] ${s.url}: ${e.cause?.code || e.message}`);
    }
  }
  cached = { at: Date.now(), key, value };
  return value;
}

// Thinking models (qwen3 and others) are asked not to think: a prompt needs no reasoning trace
const thinking = new Map();
async function supportsThinking(base, model) {
  if (!thinking.has(model)) {
    const info = await ollama(base, '/api/show', { model }).catch(() => null);
    thinking.set(model, !!info?.capabilities?.includes('thinking'));
  }
  return thinking.get(model);
}

// How the mode reads a prompt. A mode may say so in catalog/presets.json (`promptStyle`); otherwise
// a T5 or language-model text encoder (Wan, Z-Image) means natural language and CLIP (SD 1.5, SDXL) tags
function promptStyle(preset) {
  if (preset.promptStyle) return preset.promptStyle;
  return preset.models?.t5xxl || preset.models?.llm ? 'natural' : 'tags';
}

// For CLIP modes the model fills these fields and the server assembles them in this order, then
// adds the mode's quality tags (`promptQuality` in catalog/presets.json). Small models keep a
// structure far better than they follow rules about a free text.
const TAG_FIELDS = ['subject', 'action', 'setting', 'lighting', 'camera'];

// One worked example per style and kind: the idea in another language on purpose
const EXAMPLES = {
  tags: {
    image: {
      idea: 'лиса сидит в снегу',
      answer: { idea_en: 'a fox sitting in the snow', subject: 'close up portrait of a red fox, detailed fur, amber eyes', action: 'sitting calmly, looking at the camera', setting: 'fresh snow, falling snowflakes, winter forest', lighting: 'soft winter light, golden hour', camera: 'shallow depth of field, 85mm lens' },
    },
    video: {
      idea: 'старый замок на скале в грозу',
      answer: { idea_en: 'an old castle on a cliff in a thunderstorm', subject: 'old stone castle on a cliff, tall towers', action: 'storm clouds moving fast over the towers, flags waving', setting: 'rain, lightning, stormy sea below', lighting: 'dramatic lighting, dark clouds', camera: 'wide shot, slow camera push in' },
    },
  },
  natural: {
    image: {
      idea: 'старик-рыбак в порту',
      answer: { idea_en: 'an old fisherman in a harbor', prompt: 'A weathered old fisherman with a thick grey beard and a knitted navy sweater stands on a wooden pier, holding a coil of rope and looking calmly past the camera. Fishing boats with peeling paint are moored behind him and gulls sit on the posts. Soft overcast daylight brings out every wrinkle and the texture of the wool. Half-body portrait, 85mm lens, shallow depth of field.' },
    },
    video: {
      idea: 'лиса бежит по снегу на рассвете',
      answer: { idea_en: 'a fox runs through the snow at dawn', prompt: 'A red fox with thick, frosted fur runs across a snowy meadow at dawn, its paws kicking up small bursts of powder with every stride. Pale golden light rises behind distant pine trees and long blue shadows stretch across the snow. The camera tracks the fox from the side at a low angle, keeping it sharp while the background drifts past softly. Realistic, calm and crisp winter morning.' },
    },
  },
};

const RULES = {
  tags: () => [
    'You are an expert prompt engineer for photorealistic Stable Diffusion models (SD 1.5, SDXL) with a CLIP text encoder.',
    'You turn a short idea into the parts of a prompt. First write idea_en: an exact English translation of the idea, nothing added.',
    'Then fill every other field with short comma-separated phrases in English, not sentences, strictly about idea_en:',
    '- subject: who or what, with the key visual details (age, clothing, colors, materials, textures)',
    '- action: the pose, expression or motion',
    '- setting: the place, background and weather',
    '- lighting: the kind and direction of light, time of day',
    '- camera: shot size, angle, lens, depth of field',
    'Each field at most 12 words. Only things that can be seen: no sounds, smells, feelings or story.',
    'Do not write quality words like 8k, masterpiece or high quality: they are added automatically.',
  ],
  natural: (video) => [
    `You are an expert prompt engineer for a modern ${video ? 'text-to-video' : 'text-to-image'} model whose text encoder understands natural language well.`,
    'First write idea_en: an exact English translation of the idea, nothing added. Then write the prompt strictly about idea_en.',
    video
      ? 'The prompt is 2 to 4 flowing English sentences, 50 to 110 words: the subject and its appearance, what happens and how it moves over time, the environment, the lighting and atmosphere, and the camera (shot size and camera movement).'
      : 'The prompt is 2 to 4 flowing English sentences, 50 to 110 words: the subject and its appearance, the pose and expression, the environment, the lighting and atmosphere, and the camera (shot size, angle, lens).',
    video
      ? 'Describe one continuous shot without cuts or scene changes. Only things that can be seen: no sounds, smells or inner thoughts.'
      : 'Only things that can be seen: no sounds, smells or inner thoughts. Text that should appear on the image goes in double quotes.',
  ],
};

function systemPrompt(preset, style, ctx) {
  const lines = [
    ...RULES[style](preset.kind === 'video'),
    'The idea may be in any language; always answer in English.',
    'Keep everything the user asked for and do not add subjects they did not mention; make it specific and visual.',
    'The first exchange is only an example of the format: never reuse its objects, places, weather or wording.',
  ];
  if (preset.kind === 'video') {
    lines.push(ctx.duration
      ? `The result is a video clip of about ${ctx.duration} seconds: describe one clear, continuous motion that fits this length.`
      : 'The result is a short video clip: describe one clear, continuous motion.');
    if (ctx.hasImage) lines.push('The clip starts from an image the user uploaded: describe how that scene moves and how the camera behaves, and keep the subject as it is.');
  } else {
    lines.push('The result is a still photograph: no motion words.');
    if (ctx.hasImage) lines.push('The user uploaded a source image that will be reworked: describe the desired result.');
  }
  lines.push(style === 'tags'
    ? `Answer with JSON with the fields idea_en, ${TAG_FIELDS.join(', ')}.`
    : 'Answer with JSON: {"idea_en": "...", "prompt": "..."}.');
  return lines.join('\n');
}

export function clipTags(prompt, maxWords) {
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  if (words(prompt) <= maxWords) return prompt;
  const out = [];
  for (const part of prompt.split(/,\s*/)) {
    if (out.length && words([...out, part].join(', ')) > maxWords) break;
    out.push(part);
  }
  const text = out.join(', ');
  return words(text) <= maxWords ? text : text.split(/\s+/).slice(0, maxWords).join(' ');
}

// Assembles a CLIP prompt from the fields: phrases in the field order, sentences broken into
// phrases, duplicates and quality words the mode adds itself removed, at most `maxWords` words
// for the content, then the mode's quality prefix and suffix
const NOT_VISUAL = /\b(sounds?|chirp\w*|noise|noisy|smell\w*|scent|creak\w*|whisper\w*|music|song|hear\w*|silen\w*)\b/i;
const QUALITY_WORDS = /^(8k|4k|uhd|hd|masterpiece|best quality|high quality|highly detailed|ultra detailed|photorealistic|realistic|raw photo|dslr|film grain)$/i;
export function assembleTags(fields, quality = {}, maxWords = 45) {
  const extra = new Set([quality.prefix, quality.suffix].filter(Boolean).join(', ').toLowerCase().split(/,\s*/));
  const seen = new Set();
  const parts = [];
  for (const k of TAG_FIELDS) {
    for (let p of String(fields?.[k] || '').split(/[,.;]\s*/)) {
      p = p.replace(/["'()[\]{}]/g, '').replace(/\s+/g, ' ').trim().replace(/^(and|with)\s+/i, '')
        .replace(/^(A|An|The)\s/, (m) => m.toLowerCase());
      const key = p.toLowerCase();
      if (!p || seen.has(key) || extra.has(key) || QUALITY_WORDS.test(p) || NOT_VISUAL.test(p)) continue;
      // A bare word already said in an earlier phrase ("forest" after "walking through a forest")
      if (key.split(' ').length <= 2 && parts.some((x) => new RegExp(`\\b${key.replace(/[^\w ]/g, '')}\\b`, 'i').test(x))) continue;
      seen.add(key);
      parts.push(p);
    }
  }
  const content = clipTags(parts.join(', '), maxWords);
  return [quality.prefix, content, quality.suffix].filter(Boolean).join(', ');
}

// Asks the model for a prompt. `s` is the assistant's settings, `input` {idea, width, height,
// duration, hasImage}. Throws on network errors and timeouts.
export async function enhancePrompt(s, preset, input) {
  const catalog = loadCatalog();
  const modelNames = Object.values(preset.models || {}).map((id) => catalog.find((m) => m.id === id)?.name || id);
  const width = Number(input.width) || null;
  const height = Number(input.height) || null;
  const duration = Number(input.duration) > 0 ? Math.round(Number(input.duration) * 10) / 10 : null;
  const style = promptStyle(preset);
  // What the language model is told about the job (not UI text)
  const orientation = width > height ? 'landscape' : width < height ? 'portrait' : 'square';
  const describe = (idea) => [
    ['Mode', `${preset.name}. ${preset.description || ''}`.trim()],
    ['Models', modelNames.join(', ')],
    ['Size', width && height ? `${width}x${height}, ${orientation}` : ''],
    ['Idea', idea],
  ].filter(([, v]) => v).map(([k, v]) => k + ': ' + v).join('\n');
  const example = EXAMPLES[style][preset.kind] || EXAMPLES[style].video;
  // idea_en comes first: the translation, generated before the rest, keeps a small model on topic
  const fields = ['idea_en', ...(style === 'tags' ? TAG_FIELDS : ['prompt'])];
  const format = { type: 'object', properties: Object.fromEntries(fields.map((k) => [k, { type: 'string' }])), required: fields };
  const started = Date.now();
  const body = {
    model: s.model,
    stream: false,
    // Loaded only briefly: the GPU memory belongs to the generations
    keep_alive: '1m',
    format,
    options: { temperature: 0.5, num_predict: 400 },
    messages: [
      { role: 'system', content: systemPrompt(preset, style, { duration, hasImage: !!input.hasImage }) },
      { role: 'user', content: describe(example.idea) },
      { role: 'assistant', content: JSON.stringify(example.answer) },
      { role: 'user', content: describe(input.idea) },
    ],
  };
  if (await supportsThinking(s.url, s.model)) body.think = false;
  const out = await ollama(s.url, '/api/chat', body, 180000);
  let data = {};
  try {
    data = JSON.parse(out?.message?.content || '{}');
  } catch {
    data = style === 'tags' ? { subject: out?.message?.content } : { prompt: out?.message?.content };
  }
  const quality = preset.promptQuality || {};
  let prompt;
  if (style === 'tags') {
    // CLIP reads 75 tokens: about 45 words of content plus the quality tags
    prompt = TAG_FIELDS.some((k) => data[k]) ? assembleTags(data, quality) : '';
  } else {
    prompt = String(data.prompt || '').replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, '').trim();
    if (prompt && quality.suffix && !prompt.includes(quality.suffix)) prompt = `${prompt} ${quality.suffix}`;
  }
  return { prompt, style, model: s.model, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

export function promptRoutes(api) {
  api.get('/prompt/status', async (req, res) => res.json(await assistantStatus()));

  api.post('/prompt/enhance', async (req, res) => {
    const s = readSettings().promptAssistant;
    if (!s.enabled) return res.status(409).json({ error: 'The prompt assistant is not connected. An administrator can connect an Ollama model in Settings.' });
    const idea = String(req.body?.prompt || '').trim();
    if (!idea) return res.status(400).json({ error: 'Describe what to generate first' });
    if (idea.length > 2000) return res.status(400).json({ error: 'The description is too long (at most 2000 characters)' });
    const preset = loadPresets().find((p) => p.id === req.body?.presetId);
    if (!preset) return res.status(400).json({ error: 'Unknown mode' });

    try {
      const r = await enhancePrompt(s, preset, { idea, width: req.body.width, height: req.body.height, duration: req.body.duration, hasImage: !!req.body.hasImage });
      if (!r.prompt) return res.status(502).json({ error: 'The model returned an empty prompt, try again' });
      res.json(r);
    } catch (e) {
      console.warn(`[prompt] ${s.model} @ ${s.url}: ${e.cause?.code || e.message}`);
      if (e.name === 'TimeoutError' || e.name === 'AbortError') return res.status(502).json({ error: 'The Ollama model did not answer in time' });
      if (e.cause) return res.status(502).json({ error: 'The Ollama server is not reachable' });
      res.status(502).json({ error: 'The Ollama model returned an error' });
    }
  });
}

export function promptAdminRoutes(api, requireAdmin) {
  // Models of an Ollama server, for choosing one in Settings (the address being entered, not yet saved)
  api.get('/settings/ollama', requireAdmin, async (req, res) => {
    const base = ollamaUrl(req.query.url || readSettings().promptAssistant.url);
    if (!base) return res.status(400).json({ error: 'The Ollama address must be an http:// or https:// URL' });
    try {
      res.json({ url: base, ...(await listModels(base)) });
    } catch (e) {
      res.status(502).json({ error: 'The Ollama server is not reachable' });
    } finally {
      cached.at = 0;
    }
  });
}
