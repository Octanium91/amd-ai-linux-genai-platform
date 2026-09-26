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
// a T5-family text encoder (Wan) means natural language and anything else CLIP (SD 1.5): tags
function promptStyle(preset) {
  if (preset.promptStyle) return preset.promptStyle;
  return preset.models?.t5xxl ? 'natural' : 'tags';
}

const STYLE = {
  tags: [
    'The mode uses Stable Diffusion 1.5 with a CLIP text encoder that reads only the first 75 tokens.',
    'Write the prompt as comma-separated phrases, the most important first: the subject with its key details, the action or pose, the setting, the lighting, the camera and lens, then a few quality terms (for example: photorealistic, highly detailed, sharp focus, film grain).',
    'At most 60 words. No full sentences, no quotation marks, no weight syntax like (word:1.2), nothing about what to avoid.',
  ],
  natural: [
    'The mode uses Wan, a video model with a T5 text encoder that understands natural language well.',
    'Write 2 to 4 flowing English sentences, 60 to 120 words: the subject and its appearance, what happens and how it moves over time, the environment, the lighting and atmosphere, the camera (shot size and camera movement), and the visual style.',
    'Describe one continuous shot without cuts or scene changes.',
  ],
};

function systemPrompt(preset, style, ctx) {
  const lines = [
    'You turn a short idea into one high-quality prompt for a local image and video generator.',
    'The idea may be in any language; the prompt is always in English.',
    'Keep everything the user asked for, do not add subjects they did not mention, and make the result specific and visual.',
    ...STYLE[style],
  ];
  if (preset.kind === 'video') {
    lines.push(ctx.duration
      ? `The result is a video clip of about ${ctx.duration} seconds: describe one clear, continuous motion that fits this length.`
      : 'The result is a short video clip: describe one clear, continuous motion.');
    if (ctx.hasImage) lines.push('The clip starts from an image the user uploaded: describe how that scene moves and how the camera behaves, and keep the subject as it is instead of describing a different scene.');
  } else {
    lines.push('The result is a still image: no motion words.');
    if (ctx.hasImage) lines.push('The user uploaded a source image that will be reworked: describe the desired result.');
  }
  lines.push('Answer with JSON: {"prompt": "..."}.');
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
  const context = [
    ['Mode', `${preset.name}. ${preset.description || ''}`.trim()],
    ['Models', modelNames.join(', ')],
    ['Size', width && height ? `${width}x${height}, ${orientation}` : ''],
    ['Idea', input.idea],
  ].filter(([, v]) => v).map(([k, v]) => k + ': ' + v).join('\n');
  const started = Date.now();
  const body = {
    model: s.model,
    stream: false,
    // Loaded only briefly: the GPU memory belongs to the generations
    keep_alive: '1m',
    format: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    options: { temperature: 0.6, num_predict: 400 },
    messages: [
      { role: 'system', content: systemPrompt(preset, style, { duration, hasImage: !!input.hasImage }) },
      { role: 'user', content: context },
    ],
  };
  if (await supportsThinking(s.url, s.model)) body.think = false;
  const out = await ollama(s.url, '/api/chat', body, 180000);
  let prompt = '';
  try {
    prompt = String(JSON.parse(out?.message?.content || '{}').prompt || '');
  } catch {
    prompt = String(out?.message?.content || '');
  }
  prompt = prompt.replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  // CLIP ignores everything after 75 tokens: a too long answer is cut at a comma near 60 words
  if (style === 'tags') prompt = clipTags(prompt, 60);
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
