// Все изменяющие запросы несут CSRF-заголовок; 401 означает, что сессия закончилась
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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h} ч ${String(m).padStart(2, '0')} мин`;
  if (m) return `${m} мин ${String(s).padStart(2, '0')} с`;
  return `${s} с`;
}

export function fmtBytes(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' ГБ';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' МБ';
  return Math.round(b / 1024) + ' КБ';
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const STAGES = {
  video: [
    { key: 'prepare', label: 'Подготовка' },
    { key: 'sampling', label: 'Сэмплирование' },
    { key: 'decoding', label: 'Декодирование VAE' },
    { key: 'saving', label: 'Сохранение и FPS' },
  ],
  image: [
    { key: 'prepare', label: 'Подготовка' },
    { key: 'sampling', label: 'Сэмплирование' },
    { key: 'decoding', label: 'Декодирование' },
    { key: 'saving', label: 'Сохранение' },
  ],
};

export const QUALITY_LABEL = { draft: 'Черновик', normal: 'Стандарт', high: 'Высокое' };

export const clipSeconds = (p) => p.duration ?? p.frames / p.fps;

export const STATUS_LABEL = {
  queued: 'В очереди',
  running: 'Генерируется',
  done: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Отменено',
};

export const jobKind = (j) => j.params?.kind || 'video';
export const fileUrl = (name) => `/files/output/${encodeURIComponent(name)}`;

function stageDuration(job, key) {
  const st = job.progress?.stages?.[key];
  if (!st?.startedAt || !st?.endedAt) return null;
  return (st.endedAt - st.startedAt) / 1000;
}

// Грубая оценка времени по последней успешной генерации того же режима:
// сэмплирование ~ шаги × пиксели × кадры, остальное ~ пиксели × кадры.
export function estimate(jobs, params) {
  const ref = jobs
    .filter((j) => j.status === 'done' && j.params.presetId === params.presetId && j.progress)
    .sort((a, b) => b.finishedAt - a.finishedAt)[0];
  if (!ref) return null;
  const vol = (p) => p.width * p.height * (p.frames || p.count || 1);
  const samp = stageDuration(ref, 'sampling');
  if (!samp) return null;
  const dec = stageDuration(ref, 'decoding') || 0;
  const r = ref.params;
  const other = Math.max(0, (ref.durationSec || 0) - samp - dec);
  return (samp * (params.steps * vol(params))) / (r.steps * vol(r)) + (dec * vol(params)) / vol(r) + other;
}
