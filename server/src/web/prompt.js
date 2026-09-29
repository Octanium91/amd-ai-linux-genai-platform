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
function promptStyle(preset, task) {
  if (preset.kind === 'audio') return task === 'sfx' ? 'sfx' : 'music';
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

// Audio: a music caption for ACE-Step (it reads genre, instruments, tempo, voice and mood) and a
// sound description for Stable Audio (it understands only English)
const AUDIO_EXAMPLES = {
  music: {
    idea: 'грустная песня про осень под гитару',
    answer: { idea_en: 'a sad song about autumn with a guitar', prompt: 'melancholic acoustic folk ballad, fingerpicked nylon guitar, soft cello, light brushed percussion, slow tempo around 70 BPM, minor key, intimate breathy female vocal, warm and nostalgic autumn mood, close and natural studio sound' },
  },
  sfx: {
    idea: 'дверь скрипит в старом доме',
    answer: { idea_en: 'a door creaks in an old house', source: 'old wooden door slowly creaking open on rusty hinges', texture: 'dry wood, squeaking metal', space: 'close, quiet empty room with a faint echo', background: 'light wind outside' },
  },
};

const AUDIO_RULES = {
  music: (ctx) => [
    'You are an expert music producer writing captions for the ACE-Step text-to-music model.',
    'First write idea_en: an exact English translation of the idea, nothing added. Then write the caption strictly about idea_en.',
    'The caption is one line of comma-separated English phrases, 25 to 60 words: genre and subgenre, the main instruments, the tempo (with an approximate BPM), the key or scale when it fits, the vocal (gender, timbre, style), the mood and energy, and the production sound.',
    ctx.lyricsMode === 'instrumental'
      ? 'The track is instrumental: write "instrumental, no vocals" and describe no singer.'
      : 'If the idea asks for a language of the vocals, or is written in a language other than English and asks for a song, name the vocal language (for example "sung in Russian").',
    'No lyrics in the caption, no song titles and no names of real artists.',
    ctx.duration ? `The track lasts about ${ctx.duration} seconds.` : '',
  ],
  sfx: (ctx) => [
    'You are an expert sound designer writing prompts for the Stable Audio sound-effect model, which understands only English.',
    'First write idea_en: an exact English translation of the idea, nothing added. Then fill the other fields with short English phrases, strictly about the sounds of idea_en:',
    '- source: what makes the sound and what it does, with every sound source named in idea_en',
    '- texture: the materials and the character of the sound',
    '- space: the distance (close, distant) and the place with its acoustics',
    '- background: quiet background sounds that belong there, or an empty string',
    'Each field at most 12 words. Only what can be heard: no colors, light, smells, weather that makes no sound, or feelings.',
    ctx.duration ? `The sound lasts about ${ctx.duration} seconds.` : '',
  ],
};

const RULES = {
  tags: () => [
    'You are an expert prompt engineer for photorealistic Stable Diffusion models (SD 1.5, SDXL) with a CLIP text encoder.',
    'You turn a short idea into the parts of a prompt. First write idea_en: an exact English translation of the idea, nothing added.',
    'Then fill every other field with short comma-separated phrases in English, not sentences, strictly about idea_en:',
    '- subject: who or what, with the key visual details (age, clothing, colors, materials, textures). Well-known characters (from films, comics, games) keep their name and get their canonical look (costume, colors, emblem, mask), each one distinct, so they are drawn correctly and do not merge into one',
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
    'Well-known characters (from films, comics, games) keep their name and get their canonical look (costume, colors, emblem, mask), each one distinct, so they are drawn correctly and do not merge into one.',
    video
      ? 'The prompt is 2 to 4 flowing English sentences, 50 to 110 words: the subject and its appearance, what happens and how it moves over time, the environment, the lighting and atmosphere, and the camera (shot size and camera movement).'
      : 'The prompt is 2 to 4 flowing English sentences, 50 to 110 words: the subject and its appearance, the pose and expression, the environment, the lighting and atmosphere, and the camera (shot size, angle, lens).',
    video
      ? 'Describe one continuous shot without cuts or scene changes. Only things that can be seen: no sounds, smells or inner thoughts.'
      : 'Only things that can be seen: no sounds, smells or inner thoughts. Text that should appear on the image goes in double quotes.',
  ],
};

function audioSystemPrompt(style, ctx) {
  return [
    ...AUDIO_RULES[style](ctx),
    'The idea may be in any language; always answer in English.',
    'Keep everything the user asked for and do not add things they did not mention; make it specific.',
    'The first exchange is only an example of the format: never reuse its instruments, sounds or wording.',
    'If the idea is already a detailed English description, keep every detail of it and only complete it.',
    style === 'sfx'
      ? 'Answer with JSON with the fields idea_en, source, texture, space, background.'
      : 'Answer with JSON: {"idea_en": "...", "prompt": "..."}.',
  ].filter(Boolean).join('\n');
}

const SFX_FIELDS = ['source', 'texture', 'space', 'background'];
// Parts a sound model cannot use; a small language model adds them anyway
const NOT_AUDIBLE = /\b(colou?rs?|colou?red|pastel|scents?|smells?|fragran\w*|aroma\w*|sunlight|sunny|sunshine|morning light|bright day|looks?|visible|views?|shiny|glowing)\b/i;
const VOCAL = /\b(vocals?|vocalist|singers?|singing|sung|voices?|choir|choral|rap|lyrics?)\b/i;
// A language the idea asks the vocals to be in ("на русском", "in Ukrainian", "українською")
const VOCAL_LANGS = [
  [/русск|по-русски|\brussian\b/i, 'Russian'],
  [/украин|україн|\bukrainian\b/i, 'Ukrainian'],
  [/английск|англійськ|\benglish\b/i, 'English'],
  [/немецк|німецьк|\bgerman\b/i, 'German'],
  [/французск|французьк|\bfrench\b/i, 'French'],
  [/испанск|іспанськ|\bspanish\b/i, 'Spanish'],
  [/итальянск|італійськ|\bitalian\b/i, 'Italian'],
  [/польск|польськ|\bpolish\b/i, 'Polish'],
  [/японск|японськ|\bjapanese\b/i, 'Japanese'],
  [/корейск|корейськ|\bkorean\b/i, 'Korean'],
  [/китайск|китайськ|\bchinese\b/i, 'Chinese'],
];
const parts = (text) => String(text || '').split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);

// The caption as ACE-Step gets it: no singer in an instrumental, the vocal language the idea asks for
export function finishMusicCaption(caption, idea, lyricsMode) {
  let list = parts(caption.replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, ''));
  if (lyricsMode === 'instrumental') {
    list = list.filter((x) => !VOCAL.test(x) || /\b(no|without)\s+vocals?\b/i.test(x));
    if (!list.some((x) => /instrumental/i.test(x))) list.push('instrumental, no vocals');
  } else {
    const lang = VOCAL_LANGS.find(([re]) => re.test(idea))?.[1];
    if (lang && !list.some((x) => new RegExp(`\\b${lang}\\b`, 'i').test(x))) list.push(`sung in ${lang}`);
  }
  return list.join(', ');
}

// A sound description from the fields: the translated idea first, so its sounds are never lost,
// then the details, without repeats and without what cannot be heard
export function assembleSfx(data) {
  const seen = new Set();
  const out = [];
  for (const part of [data.idea_en, ...SFX_FIELDS.map((k) => data[k])].flatMap(parts)) {
    const key = part.toLowerCase();
    if (seen.has(key) || NOT_AUDIBLE.test(part)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(', ');
}

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
  const style = promptStyle(preset, input.task);
  const audio = preset.kind === 'audio';
  // What the language model is told about the job (not UI text)
  const orientation = width > height ? 'landscape' : width < height ? 'portrait' : 'square';
  const describe = (idea) => [
    ['Mode', `${preset.name}. ${preset.description || ''}`.trim()],
    ['Models', modelNames.join(', ')],
    ['Size', !audio && width && height ? `${width}x${height}, ${orientation}` : ''],
    ['Length', audio && duration ? `${duration} s` : ''],
    ['Idea', idea],
  ].filter(([, v]) => v).map(([k, v]) => k + ': ' + v).join('\n');
  const example = audio ? AUDIO_EXAMPLES[style] : EXAMPLES[style][preset.kind] || EXAMPLES[style].video;
  // Inpainting repaints only the masked part: no background or camera to describe there
  const tagFields = input.task === 'inpaint' ? INPAINT_FIELDS : TAG_FIELDS;
  const exampleAnswer = style === 'tags'
    ? Object.fromEntries(['idea_en', ...tagFields].map((k) => [k, example.answer[k]]))
    : example.answer;
  // idea_en comes first: the translation, generated before the rest, keeps a small model on topic
  const fields = ['idea_en', ...(style === 'tags' ? tagFields : style === 'sfx' ? SFX_FIELDS : ['prompt'])];
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
      { role: 'system', content: audio ? audioSystemPrompt(style, { duration, lyricsMode: input.lyricsMode }) : systemPrompt(preset, style, { duration, hasImage: !!input.hasImage, task: input.task }, tagFields) },
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
  } else if (style === 'sfx') {
    prompt = assembleSfx(data);
  } else if (style === 'music') {
    prompt = finishMusicCaption(String(data.prompt || data.idea_en || ''), input.idea, input.lyricsMode);
  } else {
    prompt = String(data.prompt || data.idea_en || '').replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, '').trim();
    if (prompt && quality.suffix && !prompt.includes(quality.suffix)) prompt = `${prompt} ${quality.suffix}`;
  }
  return { prompt, style, model: s.model, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

// A storyboard for a long video. The video is rendered in parts, each continuing from the last frame
// of the previous one. Following global + local prompting (VideoStudio, Vlogger, prompt schedules):
//   - the anchor is the user's main prompt, in English, inserted by the server verbatim and first in
//     every part, so who, where and what kind of event never change (CLIP reads the first ~20 tokens
//     best, so it goes first, lightly weighted);
//   - the language model writes only what changes: one action and one camera move per part, along a
//     story arc (setup, rising action, climax, ending inside the same event), naming the characters
//     exactly as the idea does. It never describes looks, the place or the light.
// Long videos are planned in two steps: the arc as a few beats (about one per 12 s), then each beat
// written out into its parts, knowing how the previous one ended. The fields are numbered and required
// (b1…bN, a1…aN, c1…cN): a small model given an array writes a few items and stops.
const BEAT_SECONDS = 12;

const BEATS_EXAMPLE = {
  ask: '4 beats\nIdea: два рыцаря сражаются на мосту',
  answer: {
    idea_en: 'two knights fight on a bridge',
    names: 'two knights',
    looks: 'one knight in black plate armor with a red plume and a closed helmet, the other knight in silver armor with a blue shield and no helmet, his face visible',
    b1: 'the two knights face each other and draw their swords',
    b2: 'the two knights clash, swords striking, one pushes the other back',
    b3: 'the two knights fight harder, one knight is knocked down and rolls away from a blow',
    b4: 'the two knights lock swords in a last exchange and stand exhausted, breathing hard',
  },
};

const PARTS_EXAMPLE = {
  ask: '3 parts\nNames: two knights\nBeat: the two knights clash, swords striking, one pushes the other back\nBefore: the two knights face each other and draw their swords\nAfter: one knight is knocked down',
  answer: {
    a1: 'the two knights step forward and their swords clash',
    c1: 'medium shot, slow push in',
    a2: 'the two knights exchange fast strikes, sparks fly from the blades',
    c2: 'tracking shot',
    a3: 'one of the two knights shoves the other back towards the railing',
    c3: 'low angle',
  },
};

function beatsSystem(n, seconds) {
  return [
    `You plan the story of one continuous shot of about ${seconds} seconds for an AI video model; it is rendered in parts, each continuing from the previous one.`,
    'First write idea_en: an exact English translation of the idea, nothing added, nothing removed.',
    'names: the main characters or objects exactly as idea_en names them (for example "Batman and Superman"), copied word for word from idea_en.',
    'looks: how each of them looks, one short visual phrase of at most 12 words per character, each clearly different from the others. Well-known characters (films, comics, games) get their canonical look; others get a simple fixed look. Say what tells them apart, including what only one of them has, so their features never swap when they are close (for example "Batman: black armored bat suit, a cowl with pointed ears covering his upper face, black cape; Superman: blue suit, red cape, red S emblem, bare head with black hair and his whole face visible"). Never give a character a feature of another one. This is repeated in every part, so the characters stay the same and never merge.',
    `b1 … b${n}: the ${n} beats of the story in order, following the arc setup, rising action, climax, ending. Every beat names the characters exactly as in names, keeps the same kind of event as the idea (a fight stays a fight, a walk stays a walk, the ending stays inside the event), adds no new characters, and does not describe looks, the place or the light. Each beat is one short sentence.`,
    'The idea may be in any language; always answer in English. The first exchange is only an example of the format: never reuse its content.',
    `Answer with JSON with the fields idea_en, names, looks, ${Array.from({ length: n }, (_, i) => `b${i + 1}`).join(', ')}.`,
  ].join('\n');
}

function partsSystem(style, n) {
  return [
    `Write ${n} consecutive parts that play out the given beat, from where "Before" ended to where "After" begins. For each part k write:`,
    '- ak: the action of that part, naming the characters exactly as in Names (no pronouns, no nicknames); one small continuous step, different from the other parts, a little more intense as the beat builds. It never describes looks, the place or the light.',
    '- ck: the camera for that part in at most 6 words: a shot size (wide, medium, close-up) and an angle or movement.',
    'Direct it like a film: vary the shot size and angle from part to part (never the same shot twice in a row), keep screen direction (a character on the left stays on the left), and split a big action across parts (the wind-up in one, the impact in the next) so the cuts connect.',
    style === 'tags'
      ? 'Each action is a short English phrase of at most 15 words, present tense, only things that can be seen.'
      : 'Each action is one English sentence of 10 to 30 words, present tense, with the speed and size of the motion, only things that can be seen.',
    'The first exchange is only an example of the format: never reuse its content.',
    `Answer with JSON with the fields ${Array.from({ length: n }, (_, i) => `a${i + 1}, c${i + 1}`).join(', ')}.`,
  ].join('\n');
}

async function chatJson(s, system, example, ask, format, numPredict, signal) {
  const out = await ollama(s.url, '/api/chat', {
    model: s.model,
    stream: false,
    keep_alive: '1m',
    think: false,
    format,
    options: { temperature: 0.4, repeat_penalty: 1.08, num_predict: numPredict },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: example.ask },
      { role: 'assistant', content: JSON.stringify(example.answer) },
      { role: 'user', content: ask },
    ],
  }, 120000, signal);
  if (out?.done_reason === 'length') return { truncated: true };
  try {
    return { data: JSON.parse(out?.message?.content || '{}') };
  } catch {
    return { data: {} };
  }
}

// A JSON schema with required string fields: structured output cannot leave any out
const requiredFields = (keys) => ({ type: 'object', properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])), required: keys });
const numberedKeys = (prefixes, n) => Array.from({ length: n }, (_, i) => prefixes.map((p) => `${p}${i + 1}`)).flat();
const cleanText = (x) => String(x || '').replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s.]+$/g, '').trim();
const actionKey = (x) => String(x || '').toLowerCase().replace(/\bagain\b/g, '').replace(/\W+/g, ' ').trim();
const words = (x) => new Set(String(x || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);

export async function storyboard(s, preset, input, signal = null) {
  const parts = Math.max(2, Math.min(64, Math.round(Number(input.parts) || 2)));
  const partSeconds = Math.round((Number(input.partSeconds) || 2) * 10) / 10;
  const seconds = Math.round(parts * partSeconds);
  const style = promptStyle(preset);
  const started = Date.now();
  const nBeats = Math.max(1, Math.min(12, Math.round(seconds / BEAT_SECONDS), parts));

  // 1. The arc as beats, and the anchor
  const b = await chatJson(s, beatsSystem(nBeats, seconds), BEATS_EXAMPLE, `${nBeats} beats\nIdea: ${input.idea}`,
    requiredFields(['idea_en', 'names', 'looks', ...numberedKeys(['b'], nBeats)]), 300 + nBeats * 50, signal);
  if (b.truncated) return { truncated: true };
  const idea = cleanText(b.data?.idea_en);
  // The anchor: the main prompt itself when it is already English, otherwise its exact translation;
  // quality words are the mode's business and are added at the end
  const anchor = cleanText(NOT_LATIN.test(input.idea) ? idea : input.idea)
    .split(/\s*,\s*/).filter((x) => x && !QUALITY_WORDS.test(x)).join(', ');
  if (!anchor) return {};
  // Names only count when every word of them is in the anchor (the model may not invent characters)
  let names = cleanText(b.data?.names);
  if (!names || [...words(names)].some((w) => !words(anchor).has(w))) names = '';
  // "Batman, Superman" reads as "Batman and Superman" in front of an action
  const namesText = names.replace(/\s*,\s*(?:and\s+)?/g, ', ').replace(/, ([^,]+)$/, ' and $1');
  const looks = cleanText(b.data?.looks);
  let beats = Array.from({ length: nBeats }, (_, i) => cleanText(b.data?.[`b${i + 1}`])).filter(Boolean);
  if (!beats.length) beats = [anchor];

  // 2. Each beat written out into its share of the parts
  const counts = beats.map((_, i) => Math.floor(((i + 1) * parts) / beats.length) - Math.floor((i * parts) / beats.length));
  const list = [];
  const seen = new Set();
  for (let i = 0; i < beats.length; i++) {
    const n = counts[i];
    if (!n) continue;
    const r = await chatJson(s, partsSystem(style, n), PARTS_EXAMPLE,
      `${n} parts\nNames: ${names || anchor}\nBeat: ${beats[i]}\nBefore: ${list.at(-1)?.action || (i ? beats[i - 1] : 'the shot begins')}\nAfter: ${beats[i + 1] || 'the shot ends'}`,
      requiredFields(numberedKeys(['a', 'c'], n)), 150 + n * 70, signal);
    for (let k = 0; k < n; k++) {
      let action = r.truncated ? '' : cleanText(r.data?.[`a${k + 1}`]);
      let camera = r.truncated ? '' : cleanText(r.data?.[`c${k + 1}`]);
      // One part is one continuous shot: no cuts
      if (/\bcut/i.test(camera)) camera = '';
      if (!action || seen.has(actionKey(action))) action = seen.has(actionKey(beats[i])) ? list.at(-1)?.action || beats[i] : beats[i];
      // A part that does not name the characters gets them in front, so it still shows them
      if (names && ![...words(names)].some((w) => words(action).has(w))) action = `${namesText}: ${action}`;
      seen.add(actionKey(action));
      list.push({ action, camera });
    }
  }

  const quality = preset.promptQuality || {};
  const prompts = list.map(({ action, camera }, k) => {
    if (style === 'tags') {
      // (anchor:1.15) first, never cut; the action and camera get what is left of the 77-token chunk
      // then the characters' looks (up to about 45 tokens: every character must stay in), then the part
      const head = [`(${clipTags(anchor, 30)}:1.15)`, looks && clipTags(looks, 45)].filter(Boolean).join(', ');
      const budget = CLIP_TOKENS - estTokens(preset.promptSuffix) - estTokens(head) - 1;
      return `${head}, ${assembleTags({ action, camera }, quality, budget, ['action', 'camera'])}`;
    }
    const trim = (x) => x.replace(/[.\s]+$/, '');
    const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
    const text = [cap(trim(anchor)), looks && cap(trim(looks)), `Part ${k + 1} of ${list.length}: ${trim(action)}`, camera && cap(trim(camera))].filter(Boolean).join('. ') + '.';
    return quality.suffix && !text.includes(quality.suffix) ? `${text} ${quality.suffix}` : text;
  });
  return { prompts, anchor, names, looks, beats, parts: list, model: s.model, seconds: Math.round((Date.now() - started) / 100) / 10 };
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
    if (req.body?.task === 'speech') return res.status(400).json({ error: 'Speech reads the text as it is' });
    const user = req.user.username;
    if (running.has(user) || running.size >= MAX_RUNNING) return res.status(429).json({ error: 'The prompt assistant is busy, try again in a moment' });

    running.add(user);
    // The browser gave up (closed the page, navigated away): stop waiting for the model
    const abort = new AbortController();
    res.on('close', () => !res.writableFinished && abort.abort());
    try {
      const r = await enhancePrompt(s, preset, { idea, width: req.body.width, height: req.body.height, duration: req.body.duration, hasImage: !!req.body.hasImage, task: String(req.body.task || ''), lyricsMode: String(req.body.lyricsMode || '') }, abort.signal);
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

export function storyboardRoutes(api) {
  api.post('/prompt/storyboard', async (req, res) => {
    const s = readSettings().promptAssistant;
    if (!s.enabled) return res.status(409).json({ error: 'The prompt assistant is not connected. An administrator can connect an Ollama model in Settings.' });
    const idea = String(req.body?.prompt || '').trim();
    if (!idea) return res.status(400).json({ error: 'Describe what to generate first' });
    if (idea.length > 2000) return res.status(400).json({ error: 'The description is too long (at most 2000 characters)' });
    const preset = loadPresets().find((p) => p.id === req.body?.presetId);
    if (!preset || preset.kind !== 'video') return res.status(400).json({ error: 'Unknown mode' });
    const user = req.user.username;
    if (running.has(user) || running.size >= MAX_RUNNING) return res.status(429).json({ error: 'The prompt assistant is busy, try again in a moment' });
    running.add(user);
    const abort = new AbortController();
    res.on('close', () => !res.writableFinished && abort.abort());
    try {
      const r = await storyboard({ ...s, model: s.storyboardModel || s.model }, preset, { idea, parts: req.body.parts, partSeconds: req.body.partSeconds, hasImage: !!req.body.hasImage }, abort.signal);
      if (r.truncated) return res.status(502).json({ error: 'The model answer was cut off, try a shorter description' });
      if (!r.prompts) return res.status(502).json({ error: 'The model returned an empty prompt, try again' });
      res.json(r);
    } catch (e) {
      if (abort.signal.aborted) return;
      console.warn(`[prompt] storyboard ${s.model} @ ${s.url}: ${e.cause?.code || e.message}`);
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
