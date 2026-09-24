import { dateLocale, t, tError } from './i18n.js';

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
    { key: 'prepare', label: 'Preparing' },
    { key: 'sampling', label: 'Sampling' },
    { key: 'decoding', label: 'VAE decoding' },
    { key: 'saving', label: 'Saving and FPS' },
  ],
  image: [
    { key: 'prepare', label: 'Preparing' },
    { key: 'sampling', label: 'Sampling' },
    { key: 'decoding', label: 'Decoding' },
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
export function estimate(jobs, params, preset, gpuPower) {
  const job = jobs
    .filter((j) => j.status === 'done' && j.params.presetId === params.presetId && j.progress)
    .sort((a, b) => b.finishedAt - a.finishedAt)[0];
  const samplingSec = job && stageDuration(job, 'sampling');
  if (samplingSec) {
    const decodeSec = stageDuration(job, 'decoding') || 0;
    const otherSec = Math.max(0, (job.durationSec || 0) - samplingSec - decodeSec);
    return { sec: scaleRun({ ...job.params, samplingSec, decodeSec, otherSec }, params), source: 'history' };
  }
  if (preset?.reference && gpuPower?.score) {
    return { sec: scaleRun(preset.reference, params, 1 / gpuPower.score), source: 'reference', gpu: gpuPower.name };
  }
  return null;
}
