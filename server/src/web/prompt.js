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

async function ollama(base, path, body, timeoutMs = 8000, signal = null) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    // The address is set by an administrator; a redirect must not take the request elsewhere
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
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

// Whether the button can work: checked at most every 30 s, the form asks on load and now and then.
// Requests arriving while a check runs share it.
let cached = { at: 0, key: '', value: null, pending: null };
export async function assistantStatus(force = false) {
  const s = readSettings().promptAssistant;
  const key = `${s.enabled}|${s.url}|${s.model}`;
  if (!force && cached.key === key && Date.now() - cached.at < 30000) return cached.value;
  if (cached.pending && cached.key === key) return cached.pending;
  const check = (async () => {
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
    cached = { at: Date.now(), key, value, pending: null };
    return value;
  })();
  cached = { ...cached, key, pending: check };
  return check;
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
const INPAINT_FIELDS = ['subject', 'lighting'];

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
    '- action: the pose or expression (for a video: the motion)',
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

function systemPrompt(preset, style, ctx, tagFields = TAG_FIELDS) {
  const lines = [
    ...RULES[style](preset.kind === 'video'),
    'The idea may be in any language; always answer in English.',
    'Keep everything the user asked for and do not add subjects they did not mention; make it specific and visual.',
    'The first exchange is only an example of the format: never reuse its objects, places, weather or wording.',
    'If the idea is already a detailed English prompt, keep every detail of it and only reorder and complete it.',
  ];
  if (preset.kind === 'video') {
    lines.push(ctx.duration
      ? `The result is a video clip of about ${ctx.duration} seconds: describe one clear, continuous motion that fits this length.`
      : 'The result is a short video clip: describe one clear, continuous motion.');
    if (ctx.task === 'reference') lines.push('The person or object comes from a photo the user uploaded: name them briefly and describe what they do, the setting and the camera.');
    else if (ctx.task === 'restyle') lines.push('The motion comes from a video the user uploaded: describe the new look of the scene and the subject (appearance, clothing, style, lighting) and keep the action as it is.');
    else if (ctx.hasImage) lines.push('The clip starts from an image the user uploaded: describe how that scene moves and how the camera behaves, and keep the subject as it is.');
  } else {
    lines.push('The result is a still photograph: no motion words.');
    if (ctx.task === 'inpaint') lines.push('Only a painted part of a photo the user uploaded is repainted: in subject describe only what should appear in that part, in lighting how it is lit to match the photo; no background, no camera.');
    else if (ctx.hasImage) lines.push('The user uploaded a source image that will be reworked: describe the desired result.');
  }
  lines.push(style === 'tags'
    ? `Answer with JSON with the fields idea_en, ${tagFields.join(', ')}.`
    : 'Answer with JSON: {"idea_en": "...", "prompt": "..."}.');
  return lines.join('\n');
}

// CLIP tokens, estimated: about 1.3 per word plus one per comma. CLIP reads 75 tokens per chunk;
// sd.cpp splits a longer prompt into chunks, and a second chunk has far less effect, so the
// content is cut to what fits next to the mode's quality tags and LoRA suffix.
const CLIP_TOKENS = 75;
export const estTokens = (s) => {
  const t = String(s || '');
  return Math.ceil((t.match(/[^\s,]+/g) || []).length * 1.3 + (t.match(/,/g) || []).length);
};

export function clipTags(prompt, maxTokens) {
  if (estTokens(prompt) <= maxTokens) return prompt;
  const out = [];
  for (const part of prompt.split(/,\s*/)) {
    if (out.length && estTokens([...out, part].join(', ')) > maxTokens) break;
    out.push(part);
  }
  let text = out.join(', ');
  while (estTokens(text) > maxTokens && text.includes(' ')) text = text.slice(0, text.lastIndexOf(' '));
  return text;
}

// Assembles a CLIP prompt from the fields: phrases in the field order, sentences broken into
// phrases, duplicates, quality words the mode adds itself, words left untranslated and things
// that cannot be seen removed; the content keeps to the token budget, then the quality tags follow
const NOT_VISUAL = /\b(sounds?|sound of|chirp(s|ing)?|noise|noisy|smell(s|ing)?|scent|creak(s|ing)?|whisper(s|ing)?|hear(s|d|ing)?|silence|silent)\b/i;
const QUALITY_WORDS = /^(8k|4k|uhd|hd|masterpiece|best quality|high quality|highly detailed|ultra detailed|photorealistic|realistic|raw photo|dslr|film grain)$/i;
const NOT_LATIN = /[Ѐ-ӿ]/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function assembleTags(fields, quality = {}, budget = CLIP_TOKENS, order = TAG_FIELDS) {
  const extra = new Set([quality.prefix, quality.suffix].filter(Boolean).join(', ').toLowerCase().split(/,\s*/));
  const seen = new Set();
  const parts = [];
  for (const k of order) {
    // Commas, semicolons and sentence ends separate phrases; "f/1.8" and "1.5 m" stay whole
    for (let p of String(fields?.[k] || '').split(/[,;]\s*|\.(?=\s|$)\s*/)) {
      p = p.replace(/["[\]{}]/g, '').replace(/\s+/g, ' ').trim().replace(/^(and|with)\s+/i, '')
        .replace(/^(A|An|The)\s/, (m) => m.toLowerCase());
      const key = p.toLowerCase();
      if (!p || !/[a-z]/i.test(p) || NOT_LATIN.test(p) || seen.has(key) || extra.has(key) || QUALITY_WORDS.test(p) || NOT_VISUAL.test(p)) continue;
      // A bare word already said in an earlier phrase ("forest" after "walking through a forest")
      if (key.split(' ').length <= 2 && parts.some((x) => new RegExp(`(^|[^a-z])${escapeRe(key)}([^a-z]|$)`, 'i').test(x))) continue;
      seen.add(key);
      parts.push(p);
    }
  }
  const room = Math.max(25, budget - estTokens(quality.prefix) - estTokens(quality.suffix) - 2);
  return [quality.prefix, clipTags(parts.join(', '), room), quality.suffix].filter(Boolean).join(', ');
}

// Asks the model for a prompt. `s` is the assistant's settings, `input` {idea, width, height,
// duration, hasImage, task}. Throws on network errors, timeouts and an aborted `signal`.
export async function enhancePrompt(s, preset, input, signal = null) {
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
  // Inpainting repaints only the masked part: no background or camera to describe there
  const tagFields = input.task === 'inpaint' ? INPAINT_FIELDS : TAG_FIELDS;
  const exampleAnswer = style === 'tags'
    ? Object.fromEntries(['idea_en', ...tagFields].map((k) => [k, example.answer[k]]))
    : example.answer;
  // idea_en comes first: the translation, generated before the rest, keeps a small model on topic
  const fields = ['idea_en', ...(style === 'tags' ? tagFields : ['prompt'])];
  const format = { type: 'object', properties: Object.fromEntries(fields.map((k) => [k, { type: 'string' }])), required: fields };
  const started = Date.now();
  const body = {
    model: s.model,
    stream: false,
    // Loaded only briefly: the GPU memory belongs to the generations
    keep_alive: '1m',
    // A prompt needs no reasoning trace; models that cannot think ignore it
    think: false,
    format,
    // Room for the translation and the answer, more for a long idea
    options: { temperature: 0.4, num_predict: Math.min(1200, 400 + Math.round(input.idea.length / 2)) },
    messages: [
      { role: 'system', content: systemPrompt(preset, style, { duration, hasImage: !!input.hasImage, task: input.task }, tagFields) },
      { role: 'user', content: describe(example.idea) },
      { role: 'assistant', content: JSON.stringify(exampleAnswer) },
      { role: 'user', content: describe(input.idea) },
    ],
  };
  const out = await ollama(s.url, '/api/chat', body, 180000, signal);
  // A cut-off answer is not a prompt: its raw JSON would end up in the result
  if (out?.done_reason === 'length') return { prompt: '', style, model: s.model, truncated: true };
  let data = {};
  try {
    data = JSON.parse(out?.message?.content || '{}');
  } catch {
    return { prompt: '', style, model: s.model };
  }
  const quality = preset.promptQuality || {};
  let prompt;
  if (style === 'tags') {
    const budget = CLIP_TOKENS - estTokens(preset.promptSuffix);
    const content = (f, order) => assembleTags(f, {}, budget, order);
    let f = data;
    let order = tagFields;
    // Nothing usable in the fields: the translation of the idea is still a prompt
    if (!content(f, order) && data.idea_en) {
      f = { subject: data.idea_en };
      order = ['subject'];
    }
    prompt = content(f, order) ? assembleTags(f, quality, budget, order) : '';
  } else {
    prompt = String(data.prompt || data.idea_en || '').replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, '').trim();
    if (prompt && quality.suffix && !prompt.includes(quality.suffix)) prompt = `${prompt} ${quality.suffix}`;
  }
  return { prompt, style, model: s.model, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

// One request per user at a time and two in total: each can hold the Ollama model (and GPU
// memory shared with the generations) for up to three minutes
const running = new Set();
const MAX_RUNNING = 2;

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
    const user = req.user.username;
    if (running.has(user) || running.size >= MAX_RUNNING) return res.status(429).json({ error: 'The prompt assistant is busy, try again in a moment' });

    running.add(user);
    // The browser gave up (closed the page, navigated away): stop waiting for the model
    const abort = new AbortController();
    res.on('close', () => !res.writableFinished && abort.abort());
    try {
      const r = await enhancePrompt(s, preset, { idea, width: req.body.width, height: req.body.height, duration: req.body.duration, hasImage: !!req.body.hasImage, task: String(req.body.task || '') }, abort.signal);
      if (r.truncated) return res.status(502).json({ error: 'The model answer was cut off, try a shorter description' });
      if (!r.prompt) return res.status(502).json({ error: 'The model returned an empty prompt, try again' });
      res.json(r);
    } catch (e) {
      if (abort.signal.aborted) return;
      console.warn(`[prompt] ${s.model} @ ${s.url}: ${e.cause?.code || e.message}`);
      if (e.name === 'TimeoutError' || e.name === 'AbortError') return res.status(502).json({ error: 'The Ollama model did not answer in time' });
      if (e.cause) return res.status(502).json({ error: 'The Ollama server is not reachable' });
      res.status(502).json({ error: 'The Ollama model returned an error' });
    } finally {
      running.delete(user);
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
