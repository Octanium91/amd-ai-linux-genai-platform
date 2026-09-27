import { dateLocale, getLang, t, tError } from './i18n.js';

// Every mutating request carries the CSRF header; 401 means the session has expired
export const CSRF = { 'X-Requested-With': 'genai-platform' };

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (init.method && init.method !== 'GET') Object.assign(init.headers, CSRF);
  if (init.json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.json);
    delete init.json;
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
  if (!res.ok) {
    const err = new Error(tError(data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return t('{h} h {m} min', { h, m: String(m).padStart(2, '0') });
  if (m) return t('{m} min {s} s', { m, s: String(s).padStart(2, '0') });
  return t('{s} s', { s });
}

export function fmtBytes(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(1) + ' ' + t('TB');
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' ' + t('GB');
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' ' + t('MB');
  return Math.round(b / 1024) + ' ' + t('KB');
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const STAGES = {
  video: [
    { key: 'prepare', label: 'Getting ready' },
    { key: 'sampling', label: 'Drawing' },
    { key: 'decoding', label: 'Finishing' },
    { key: 'saving', label: 'Saving the video' },
  ],
  audio: [
    { key: 'prepare', label: 'Getting ready' },
    { key: 'sampling', label: 'Composing' },
    { key: 'decoding', label: 'Finishing' },
    { key: 'saving', label: 'Saving' },
  ],
  image: [
    { key: 'prepare', label: 'Getting ready' },
    { key: 'sampling', label: 'Drawing' },
    { key: 'decoding', label: 'Finishing' },
    { key: 'saving', label: 'Saving' },
  ],
  // Upscaling has no drawing: the whole run is one stage
  upscale: [
    { key: 'prepare', label: 'Upscaling' },
    { key: 'saving', label: 'Saving' },
  ],
};

export const QUALITY_LABEL = { draft: 'Draft', normal: 'Standard', high: 'High', extra: 'Extra' };

export const clipSeconds = (p) => p.duration ?? p.frames / p.fps;

export const STATUS_LABEL = {
  queued: 'Queued',
  running: 'Generating',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const jobKind = (j) => j.params?.kind || 'video';

// Speech: the built-in voices (F1–F5, M1–M5) and the languages of the speech model
export const SPEECH_VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];
export const SPEECH_LANGS = ['en', 'uk', 'ru', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'cs', 'sk', 'sl', 'hr', 'bg', 'ro', 'hu', 'nl', 'sv', 'da', 'fi', 'et', 'lv', 'lt', 'el', 'tr', 'ar', 'hi', 'id', 'vi', 'ja', 'ko'];
export const voiceName = (v) => (/^F\d$/.test(v || '') ? t('Female {n}', { n: v.slice(1) }) : /^M\d$/.test(v || '') ? t('Male {n}', { n: v.slice(1) }) : v || '');
export function langName(code) {
  try {
    const name = new Intl.DisplayNames([getLang()], { type: 'language' }).of(code);
    return name ? name[0].toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}
// The length of an audio result: measured after saving, otherwise the requested one
export const audioSeconds = (j) => j.audioSec ?? j.params?.duration ?? null;
export const fileUrl = (name) => `/files/output/${encodeURIComponent(name)}`;

function stageDuration(job, key) {
  const st = job.progress?.stages?.[key];
  if (!st?.startedAt || !st?.endedAt) return null;
  return (st.endedAt - st.startedAt) / 1000;
}

// Scales a measured run to other parameters: sampling ~ steps × pixels × frames × CFG passes
// (CFG > 1 adds a negative pass), decoding ~ pixels × frames, loading stays the same.
const vol = (p) => p.width * p.height * (p.frames || p.count || 1) * (p.segments || 1);
const passes = (p) => (p.cfg > 1 ? 2 : 1);
const scaleRun = (r, p, gpuFactor = 1) =>
  ((r.samplingSec * p.steps * vol(p) * passes(p)) / (r.steps * vol(r) * passes(r)) + (r.decodeSec * vol(p)) / vol(r)) * gpuFactor +
  r.otherSec;

// Time estimate: from the latest successful job of the same mode on this machine; before the first
// one, from the mode's reference measurement scaled by the relative power of this GPU.
// Audio has no steps to count: the time grows with the length (music, effects) or the text
// (speech). The last run of the mode gives the rate; before that, the mode's reference measurement.
function estimateAudio(jobs, params, preset) {
  const speech = params.task === 'speech' || preset?.engine?.task === 'tts';
  const amount = (p, j) => (speech ? String(p.prompt || '').length : Number(j?.audioSec ?? p.duration) || 0);
  const job = jobs
    .filter((j) => j.status === 'done' && j.params.presetId === params.presetId && j.durationSec)
    .sort((a, b) => b.finishedAt - a.finishedAt)[0];
  const want = amount(params);
  const ref = preset?.reference || {};
  const fixed = ref.fixedSec ?? 3;
  if (job) {
    const had = amount(job.params, job);
    const rate = had > 0 ? Math.max(0, job.durationSec - fixed) / had : 0;
    return { sec: fixed + rate * want, source: 'history' };
  }
  if (preset?.reference) return { sec: fixed + (speech ? ref.perChar ?? 0.01 : ref.perAudioSec ?? 1) * want, source: 'reference' };
  return null;
}

export function estimate(jobs, params, preset, gpuPower) {
  if (preset?.kind === 'audio') return estimateAudio(jobs, params, preset);
  const job = jobs
    .filter((j) => j.status === 'done' && j.params.presetId === params.presetId && j.progress)
    .sort((a, b) => b.finishedAt - a.finishedAt)[0];
  const samplingSec = job && stageDuration(job, 'sampling');
  if (samplingSec) {
    // Progress is kept per pass: the stage times are of the last pass, so a multi-pass video is
    // measured as one pass (its share of the total time) and scaled from there
    const segs = job.params.segments || 1;
    const decodeSec = stageDuration(job, 'decoding') || 0;
    const otherSec = Math.max(0, (job.durationSec || 0) / segs - samplingSec - decodeSec);
    return { sec: scaleRun({ ...job.params, segments: 1, samplingSec, decodeSec, otherSec }, params), source: 'history' };
  }
  if (preset?.reference && gpuPower?.score) {
    return { sec: scaleRun(preset.reference, params, 1 / gpuPower.score), source: 'reference', gpu: gpuPower.name };
  }
  return null;
}
