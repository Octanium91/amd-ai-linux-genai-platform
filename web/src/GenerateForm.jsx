import { useEffect, useMemo, useRef, useState } from 'react';
import { api, estimate, fmtBytes, fmtDuration } from './util.js';
import { loc, t, tError } from './i18n.js';

const FALLBACK_RES = [[512, 512], [768, 512], [512, 768]];
const OUT_FPS = [24, 30, 50, 60, 120];
const COUNTS = [1, 2, 4];
const QUALITY = [
  { key: 'draft', label: 'Draft' },
  { key: 'normal', label: 'Standard' },
  { key: 'high', label: 'High' },
  { key: 'extra', label: 'Extra', extra: true },
];
// What the user wants to do. A task decides which modes fit (a mode lists its `tasks`, see
// server/src/web/presets.js) and which inputs the form asks for: a photo, a mask painted over it,
// a video. `strength` is the default of the "how much to change" slider.
const TASKS = {
  image: [
    { key: 'create', label: 'Create', title: 'An image from a description' },
    { key: 'rework', label: 'Rework a photo', title: 'Your photo changed by the description', image: true, strength: 0.6 },
    { key: 'inpaint', label: 'Change a part', title: 'Paint a part of the photo and describe what goes there', image: true, mask: true, strength: 0.9 },
    { key: 'upscale', label: 'Upscale', title: 'A photo 4× larger with restored detail', image: true, noPrompt: true },
  ],
  video: [
    { key: 'create', label: 'Create', title: 'A video from a description' },
    { key: 'animate', label: 'Animate a photo', title: 'Your photo becomes the first frame and comes alive', image: true },
    { key: 'reference', label: 'Put a person in', title: 'A person or object from a photo in a new video', image: true },
    { key: 'restyle', label: 'Change a video', title: 'The motion of your video with a new look', video: true, imageOptional: true },
  ],
};
const fitsTask = (p, task) => (p.tasks || ['create']).includes(task.key);
const photoLabel = (task) => ({
  rework: t('Photo to rework'),
  inpaint: t('Photo'),
  upscale: t('Photo to upscale'),
  animate: t('Start frame'),
  reference: t('Photo of the person or object'),
  restyle: t('Reference photo (optional)'),
})[task] || t('Photo');

// A photo as the engine should see it: turned upright by its EXIF orientation (the browser shows it
// that way, sd-cli would not) and at most 2048 px on the long side (the mask canvas and the
// upload stay small; no mode generates larger)
const MAX_PHOTO_SIDE = 2048;
async function normalizePhoto(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const png = file.type === 'image/png';
    const blob = await new Promise((r) => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.95));
    return blob ? new File([blob], png ? 'photo.png' : 'photo.jpg', { type: blob.type }) : file;
  } catch {
    return file;
  }
}

// The generation size for a photo: its aspect ratio at about the mode's default pixel count,
// in multiples of 64, so the photo is not stretched
function fitSize(w, h, d) {
  const area = (d.width || 512) * (d.height || 512);
  const k = Math.sqrt(area / (w * h));
  const r = (v) => Math.max(256, Math.min(2048, Math.round((v * k) / 64) * 64));
  return [r(w), r(h)];
}

const SAMPLERS = ['euler', 'euler_a', 'dpm++2m', 'dpm++2m_sde', 'res_multistep', 'lcm', 'ddim_trailing', 'tcd'];

// "Extra" is twice the steps of "High" (same rule as the server)
const qualitySteps = (d, q) => (q === 'extra' ? d.quality?.extra ?? (d.quality?.high ? d.quality.high * 2 : null) : d.quality?.[q]);

function fromPreset(p) {
  const d = p?.defaults || {};
  return {
    presetId: p?.id || '',
    prompt: '',
    negative: d.negative ?? '',
    width: d.width ?? 512,
    height: d.height ?? 512,
    duration: d.duration ?? 2,
    outFps: d.outFps ?? d.nativeFps ?? 24,
    count: 1,
    quality: 'normal',
    cfg: d.cfg ?? 5,
    flowShift: d.flowShift ?? null,
    sampler: d.sampler ?? 'euler',
    seed: -1,
    // Frames per model pass; empty means the length the model was trained on
    segmentFrames: null,
  };
}

// Same function as on the server (server/src/web/params.js): frames per model pass and the number
// of passes. segmentFrames is what the model was trained on; longer passes follow the prompt worse.
// Longer videos are built from up to maxSegments passes, each continuing from the last frame.
function videoPlan(preset, duration, segmentFrames) {
  const d = preset?.defaults || {};
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
  const extendable = preset?.kind === 'video' && preset?.image !== 'none';
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
    hardMax, minFrames, duration: total(frames, segments), beyondTraining: frames > trained,
  };
}

// An ⓘ next to a label: the explanation appears on hover or keyboard focus instead of a
// permanent hint under every field
export function Info({ text }) {
  if (!text) return null;
  return (
    <span className="info" tabIndex={0} role="note" aria-label={text} onClick={(e) => e.preventDefault()}>
      i<span className="info-pop">{text}</span>
    </span>
  );
}

const TASK_ICONS = {
  create: 'M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm6.5 12l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z',
  rework: 'M4 5h11a2 2 0 0 1 2 2v3h-2V7H4v10h6v2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm15.6 7.6 1.8 1.8-6.6 6.6H13v-1.8l6.6-6.6zM6 15l2.5-3.2 1.8 2.2 1.2-1.5L14 15H6z',
  inpaint: 'M20.7 5.6 18.4 3.3a1 1 0 0 0-1.4 0L9 11.3 12.7 15l8-8a1 1 0 0 0 0-1.4zM7.5 13c-1.9 0-3.5 1.6-3.5 3.5 0 1.2-.8 2.2-2 2.5.9 1.2 2.4 2 4 2 2.8 0 5-2.2 5-5 0-1.7-1.6-3-3.5-3z',
  upscale: 'M4 4h6v2H7.4l4.3 4.3-1.4 1.4L6 7.4V10H4V4zm16 16h-6v-2h2.6l-4.3-4.3 1.4-1.4 4.3 4.3V14h2v6z',
  animate: 'M4 5h12a2 2 0 0 1 2 2v2.5l4-2.5v10l-4-2.5V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm4 3.5v7l5.5-3.5L8 8.5z',
  reference: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-7 1.7-7 4.5V20h11.1a6 6 0 0 1 3.9-6.2C15.4 13.3 12.4 13 9 13zm10 1v3h3v2h-3v3h-2v-3h-3v-2h3v-3h2z',
  restyle: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6H4zm2 2h2v2H6V8zm0 6h2v2H6v-2zm10-6h2v2h-2V8zm0 6h2v2h-2v-2zm-5.5-5 4 3-4 3V9z',
};
const TaskIcon = ({ name }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d={TASK_ICONS[name] || TASK_ICONS.create} fill="currentColor" /></svg>
);

function Num({ label, value, onChange, step = 1, min, max, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type="number" value={value ?? ''} step={step} min={min} max={max}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function Chips({ items, value, onChange, render = (x) => x }) {
  return (
    <div className="chips">
      {items.map((x) => {
        const key = typeof x === 'object' ? x.key : x;
        return (
          <button type="button" key={key} className={`chip ${value === key ? 'on' : ''} ${x?.extra ? 'extra' : ''}`} onClick={() => onChange(key)}>
            {render(x)}
          </button>
        );
      })}
    </div>
  );
}

// A mode without downloaded models: the missing files and a download button (admin only)
function MissingModels({ preset, user, goModels, reloadPresets }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const total = preset.missing.reduce((s, m) => s + (m.size || 0), 0);
  const start = async () => {
    setBusy(true);
    try {
      await api('/api/models/download', { method: 'POST', json: { ids: preset.missing.map((m) => m.id) } });
      setMsg(t('Download queued — progress is in the Models section.'));
      reloadPresets();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="missing">
      <div className="missing-title">{t('This mode needs models to be downloaded ({size}):', { size: fmtBytes(total) })}</div>
      <ul>{preset.missing.map((m) => <li key={m.id}>{m.name} <span className="muted">· {fmtBytes(m.size)}</span></li>)}</ul>
      {user.role === 'admin' ? (
        <div className="row">
          <button type="button" className="btn primary" disabled={busy} onClick={start}>{t('Download ({size})', { size: fmtBytes(total) })}</button>
          <button type="button" className="btn ghost" onClick={goModels}>{t('Models →')}</button>
        </div>
      ) : (
        <div className="muted small">{t('Ask an administrator to download the models.')}</div>
      )}
      {msg && <div className="muted small">{msg}</div>}
    </div>
  );
}

// Painting the part of a photo to change (inpainting). The overlay shows the strokes in red; a
// hidden canvas at the photo's own resolution holds the mask sd-cli gets: white is repainted,
// black is kept. The mask is handed over as a PNG after every stroke.
function MaskEditor({ src, onChange }) {
  const view = useRef(null);
  const mask = useRef(null);
  const drawing = useRef(null);
  const [brush, setBrush] = useState(6); // % of the photo width
  const [painted, setPainted] = useState(false);

  const setup = (img) => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    for (const c of [view.current, mask.current]) {
      c.width = w;
      c.height = h;
    }
    const m = mask.current.getContext('2d');
    m.fillStyle = '#000';
    m.fillRect(0, 0, w, h);
    view.current.getContext('2d').clearRect(0, 0, w, h);
    setPainted(false);
    onChange(null);
  };

  const point = (e) => {
    const r = view.current.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * view.current.width, ((e.clientY - r.top) / r.height) * view.current.height];
  };
  const stroke = (from, to) => {
    const size = (brush / 100) * view.current.width;
    const paint = getComputedStyle(document.documentElement).getPropertyValue('--mask-paint').trim() || 'rgba(240, 106, 106, 0.55)';
    for (const [c, color] of [[view.current, paint], [mask.current, '#fff']]) {
      const g = c.getContext('2d');
      g.strokeStyle = color;
      g.lineWidth = size;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(...from);
      g.lineTo(...to);
      g.stroke();
    }
  };
  // One finger or pen at a time: a second touch does not draw a line across the photo
  const down = (e) => {
    if (drawing.current) return;
    e.preventDefault();
    view.current.setPointerCapture(e.pointerId);
    const p = point(e);
    drawing.current = { id: e.pointerId, p };
    stroke(p, p);
  };
  const move = (e) => {
    if (drawing.current?.id !== e.pointerId) return;
    const p = point(e);
    stroke(drawing.current.p, p);
    drawing.current.p = p;
  };
  const up = (e) => {
    if (drawing.current?.id !== e.pointerId) return;
    drawing.current = null;
    setPainted(true);
    // A promise: a submit right after the stroke waits for this very mask
    onChange(new Promise((resolve) => mask.current.toBlob(resolve, 'image/png')));
  };
  const clear = () => {
    const img = view.current.previousSibling;
    if (img?.naturalWidth) setup(img);
  };

  return (
    <div className="mask-editor">
      <div className="mask-stage">
        <img src={src} alt="" onLoad={(e) => setup(e.currentTarget)} draggable={false} />
        <canvas ref={view} className="mask-view" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        <canvas ref={mask} hidden />
      </div>
      <div className="mask-tools">
        <label className="mask-brush">
          <span className="muted small">{t('Brush')}</span>
          <input type="range" min={2} max={20} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
        </label>
        <button type="button" className="btn btn-small" disabled={!painted} onClick={clear}>{t('Clear')}</button>
      </div>
      <span className="field-hint">{painted ? t('Only the painted part changes; the rest of the photo stays as it is.') : t('Paint over the part of the photo to change.')}</span>
    </div>
  );
}

// The prompt field with the "To prompt" assistant: an Ollama model (connected by an administrator
// in Settings) rewrites the description into a detailed English prompt for the selected mode.
// The previous text can be restored with one click.
function PromptField({ form, set, preset, isVideo, hasImage, duration, task, user }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => api('/api/prompt/status').then((s) => alive && setStatus(s)).catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const ready = !!status?.ready && !!preset;
  const title = ready
    ? t('Turn the description into a detailed prompt for this mode ({model})', { model: status.model })
    : status?.enabled
      ? `${tError(status.error) || t('The prompt assistant is not available')}. ${t('An administrator can check it in Settings.')}`
      : t('Connect an Ollama model in Settings to turn a short description into a detailed prompt.');

  const run = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api('/api/prompt/enhance', {
        method: 'POST',
        json: { presetId: preset.id, prompt: form.prompt, width: form.width, height: form.height, duration: isVideo ? duration : null, hasImage, task },
      });
      setUndo(form.prompt);
      set('prompt')(r.prompt);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const admin = user?.role === 'admin';
  // Not set up: users do not see the button at all, administrators get a hint where to set it up
  const showButton = ready || status?.enabled || admin;
  return (
    <div className="field">
      <label className="field-label" htmlFor="prompt-text">{isVideo ? t('Describe the video') : t('Describe the picture')}</label>
      <div className="prompt-box">
        <textarea id="prompt-text" rows={4} value={form.prompt} required disabled={busy}
          placeholder={ready
            ? t('Describe your idea in any language — ✦ turns it into a detailed prompt')
            : isVideo ? 'a red fox running through fresh snow, cinematic lighting, slow motion' : 'portrait photo of an old fisherman, golden hour, 85mm, detailed skin'}
          onChange={(e) => {
            set('prompt')(e.target.value);
            setUndo(null);
          }}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.repeat && e.currentTarget.form.requestSubmit()} />
        <div className="prompt-tools">
          {undo != null && (
            <button type="button" className="undo-chip" onClick={() => { set('prompt')(undo); setUndo(null); }} title={t('Restore my text')}>↶ {t('Undo')}</button>
          )}
          {showButton && (
            <span title={title}>
              <button type="button" className="prompt-ai" disabled={!ready || busy || !form.prompt.trim()} onClick={run}>
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                  <path fill="currentColor" d="M10 3l1.9 5.1L17 10l-5.1 1.9L10 17l-1.9-5.1L3 10l5.1-1.9L10 3zm8 10l.9 2.1L21 16l-2.1.9L18 19l-.9-2.1L15 16l2.1-.9L18 13z" />
                </svg>
                {busy ? t('Writing…') : t('Improve with AI')}
              </button>
            </span>
          )}
        </div>
      </div>
      {error && <div className="note warn">⚠ {error}</div>}
      {!ready && admin && !status?.enabled && <div className="note">{t('Connect an Ollama model in Settings to turn a short description into a detailed prompt.')}</div>}
    </div>
  );
}

export default function GenerateForm({ kind, user, presets, templates, system, jobs, reuse, onReuseApplied, queueSize, onCreated, reloadPresets, goModels }) {
  const submitting = useRef(false);
  const [form, setForm] = useState(null);
  const [image, setImage] = useState(null); // File
  const [imageRef, setImageRef] = useState(null); // name of an already uploaded file
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [taskKey, setTaskKey] = useState('create');
  const [allSizes, setAllSizes] = useState(false);
  const [maskBlob, setMaskBlob] = useState(null); // a promise of the mask PNG
  const [photoSize, setPhotoSize] = useState(null); // [width, height] of the current photo
  const [video, setVideo] = useState(null); // File
  const [videoRef, setVideoRef] = useState(null); // name of an already uploaded video
  const fileInput = useRef(null);
  const videoInput = useRef(null);
  const isVideo = kind === 'video';
  const tasks = TASKS[kind] || TASKS.image;
  const task = tasks.find((x) => x.key === taskKey) || tasks[0];

  const preset = presets.find((p) => p.id === form?.presetId);

  // Initial fill: a random hidden template, preferring modes whose models are already downloaded
  useEffect(() => {
    if (form || !presets.length || templates === undefined) return;
    const usable = (templates || []).filter((x) => presets.some((p) => p.id === x.presetId));
    const ready = usable.filter((x) => presets.find((p) => p.id === x.presetId)?.available);
    const pool = ready.length ? ready : usable;
    const tpl = pool[Math.floor(Math.random() * pool.length)];
    if (!tpl) return setForm(fromPreset(presets.find((p) => p.available) || presets[0]));
    const { kind: _k, category, presetId, ...params } = tpl;
    setForm({ ...fromPreset(presets.find((p) => p.id === presetId)), ...params, seed: -1 });
  }, [presets, templates, form]);

  useEffect(() => {
    if (!reuse || (reuse.kind || 'video') !== kind) return;
    const { _t, image: img, video: _v, mask: _m, task: _task, presetName, frames, steps, fps, segments, kind: _k, ...params } = reuse;
    params.quality ??= 'normal';
    setForm((f) => ({ ...(f || {}), ...params }));
    setImage(null);
    setImageRef(img || null);
    setVideo(null);
    setVideoRef(reuse.video || null);
    setMaskBlob(null);
    setTaskKey(reuse.task || (img ? (kind === 'video' ? 'animate' : 'rework') : 'create'));
    // Applied once: coming back to the tab later must not overwrite what the user typed since
    onReuseApplied?.();
  }, [reuse, kind]);

  useEffect(() => {
    const task = (TASKS[kind] || TASKS.image).find((x) => x.key === taskKey);
    const current = presets.find((p) => p.id === form?.presetId);
    if (!form || !task || !current || fitsTask(current, task)) return;
    const fit = presets.filter((p) => fitsTask(p, task));
    const p = fit.find((x) => x.available) || fit[0];
    if (p) setForm((f) => ({ ...fromPreset(p), prompt: f.prompt, strength: f.strength }));
  }, [taskKey, form?.presetId, presets, kind]);

  const previewUrl = useMemo(() => {
    if (image) return URL.createObjectURL(image);
    if (imageRef) return `/files/uploads/${imageRef}`;
    return null;
  }, [image, imageRef]);
  useEffect(() => () => image && previewUrl && URL.revokeObjectURL(previewUrl), [image, previewUrl]);
  const videoUrl = useMemo(() => {
    if (video) return URL.createObjectURL(video);
    if (videoRef) return `/files/uploads/${videoRef}`;
    return null;
  }, [video, videoRef]);
  useEffect(() => () => video && videoUrl && URL.revokeObjectURL(videoUrl), [video, videoUrl]);

  if (!presets.length) return <div className="card"><div className="muted">{t('No modes of this type.')}</div></div>;
  if (!form) return <div className="card"><div className="muted">{t('Loading…')}</div></div>;

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const pickPreset = (id) => {
    const p = presets.find((x) => x.id === id);
    const fitted = photoSize && ['rework', 'inpaint'].includes(taskKey) && p ? fitSize(photoSize[0], photoSize[1], p.defaults || {}) : null;
    setForm((f) => ({ ...fromPreset(p), prompt: f.prompt, strength: f.strength, ...(fitted ? { width: fitted[0], height: fitted[1] } : {}) }));
    if (p?.image === 'none') {
      setImage(null);
      setImageRef(null);
    }
  };
  const modes = presets.filter((p) => fitsTask(p, task));
  const pickTask = (key) => {
    const next = tasks.find((x) => x.key === key);
    setTaskKey(key);
    setMaskBlob(null);
    if (!next.image && !next.imageOptional) {
      setImage(null);
      setImageRef(null);
    }
    if (!next.video) {
      setVideo(null);
      setVideoRef(null);
    }
    setForm((f) => ({ ...f, strength: next.strength ?? null }));
    // Keep the mode when it fits the task, otherwise the first fitting one that is ready
    if (preset && !fitsTask(preset, next)) {
      const fit = presets.filter((p) => fitsTask(p, next));
      const p = fit.find((x) => x.available) || fit[0];
      if (p) pickPreset(p.id);
    }
  };

  const d = preset?.defaults || {};
  const resolutions = preset?.resolutions || FALLBACK_RES;
  const acceptsImage = !!(task.image || task.imageOptional) && !!preset;
  const upscale = !!task.noPrompt;
  const plan = videoPlan(preset, form.duration, form.segmentFrames);
  // Sizes the mode was tested at; others work but follow the prompt less reliably
  const recommended = preset?.recommendedResolutions;
  const offSize = !!recommended && !recommended.some(([w, h]) => w === Number(form.width) && h === Number(form.height));
  const steps = qualitySteps(d, form.quality) ?? 20;
  const extraDuration = isVideo && plan.segments > 1;
  const eta = estimate(jobs, isVideo ? { ...form, frames: plan.frames * plan.segments, steps } : { ...form, frames: form.count, steps }, preset, system?.gpuPower);
  // The time per result of every mode card, at its own default size and the chosen quality
  const modeEta = (p) => {
    if (p.id === form.presetId) return eta;
    const pd = p.defaults || {};
    const pSteps = qualitySteps(pd, form.quality) ?? pd.steps ?? 20;
    const pPlan = videoPlan(p, form.duration);
    const params = { presetId: p.id, width: pd.width, height: pd.height, cfg: pd.cfg, steps: pSteps, frames: isVideo ? pPlan.frames * pPlan.segments : form.count };
    return estimate(jobs, params, p, system?.gpuPower);
  };

  const onFile = async (f) => {
    if (f && f.type.startsWith('image/')) {
      setMaskBlob(null);
      setImage(await normalizePhoto(f));
      setImageRef(null);
    }
  };
  const onVideoMeta = (e) => {
    const v = e.currentTarget;
    if (!v.videoWidth || !preset) return;
    const portrait = v.videoHeight > v.videoWidth;
    if (portrait === Number(form.height) > Number(form.width)) return;
    const r = (preset.recommendedResolutions || preset.resolutions || []).find(([w, h]) => (h > w) === portrait);
    if (r) setForm((f) => ({ ...f, width: r[0], height: r[1] }));
  };
  const onVideo = (f) => {
    if (f && f.type.startsWith('video/')) {
      setVideo(f);
      setVideoRef(null);
    }
  };
  // Rework and inpaint follow the photo's aspect ratio
  const onPhotoLoad = (e) => {
    setPhotoSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight]);
    if (!['rework', 'inpaint'].includes(task.key) || !preset) return;
    const [w, h] = fitSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight, preset.defaults || {});
    setForm((f) => (f.width === w && f.height === h ? f : { ...f, width: w, height: h }));
  };

  const submit = async (e) => {
    e.preventDefault();
    // Ctrl+Enter bypasses the disabled button, and a held key repeats: one job per submit
    if (submitting.current) return;
    if (task.image && !image && !imageRef) return setError(t('Add a photo for this task.'));
    if (task.mask && !maskBlob) return setError(t('Paint the part of the photo to change.'));
    if (task.video && !video && !videoRef) return setError(t('Add a video for this task.'));
    submitting.current = true;
    setError('');
    setBusy(true);
    try {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form)) if (v != null && v !== '') fd.append(k, v);
      fd.set('task', task.key);
      if (task.strength != null) fd.set('strength', String(form.strength ?? task.strength));
      if (upscale && !form.prompt.trim()) fd.set('prompt', '');
      if (acceptsImage && image) fd.append('image', image);
      else if (acceptsImage && imageRef) fd.append('imageRef', imageRef);
      const maskPng = task.mask ? await maskBlob : null;
      if (task.mask && !maskPng) throw new Error(t('Paint the part of the photo to change.'));
      if (maskPng) fd.append('mask', maskPng, 'mask.png');
      if (task.video && video) fd.append('video', video);
      else if (task.video && videoRef) fd.append('videoRef', videoRef);
      await api('/api/jobs', { method: 'POST', body: fd });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const summary = upscale ? t('4× larger')
    : isVideo
      ? [t('{s} s video', { s: plan.duration.toFixed(1) }), plan.segments > 1 ? t('from {n} parts', { n: plan.segments }) : null, `${form.outFps} fps`, `${form.width}×${form.height}`].filter(Boolean).join(' · ')
      : [form.count > 1 ? t('{n} images', { n: form.count }) : t('1 image'), `${form.width}×${form.height}`].join(' · ');
  // Why the button cannot be pressed yet, said next to it instead of a silently grey button
  const why = !preset ? null
    : !preset.available ? (user.role === 'admin' ? t('Download the models of this mode first') : t('Ask an administrator to download this mode'))
      : task.image && !image && !imageRef ? t('Add a photo')
        : task.mask && !maskBlob ? t('Paint the part to change')
          : task.video && !video && !videoRef ? t('Add a video')
            : !upscale && !form.prompt.trim() ? t('Describe what to create') : null;
  const tested = (w, h) => recommended?.some(([a, b]) => a === w && b === h);
  const shownSizes = recommended && !allSizes ? resolutions.filter(([w, h]) => tested(w, h) || (w === Number(form.width) && h === Number(form.height))) : resolutions;

  return (
    <form className="card form" onSubmit={submit}>
      <div className="task-tabs" role="tablist" aria-label={t('Task')}>
        {tasks.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={x.key === task.key} title={t(x.title)}
            className={`task-tab ${x.key === task.key ? 'on' : ''}`} onClick={() => pickTask(x.key)}>
            <TaskIcon name={x.key} />
            <span className="task-name">{t(x.label)}</span>
            {!presets.some((p) => fitsTask(p, x) && p.available) && <span className="task-dot" title={t('Needs a model download')} />}
          </button>
        ))}
      </div>
      <div className="task-hint">{t(task.title)}</div>

      {acceptsImage && (
        <div className="field">
          <span className="field-label">{photoLabel(task.key)}</span>
          {previewUrl && task.mask ? (
            <>
              <img src={previewUrl} alt="" hidden onLoad={onPhotoLoad} />
              <MaskEditor key={previewUrl} src={previewUrl} onChange={setMaskBlob} />
              <div className="photo-bar">
                <button type="button" className="btn btn-small" onClick={() => fileInput.current?.click()}>{t('Replace the photo')}</button>
              </div>
            </>
          ) : (
            <div
              className={`drop ${drag ? 'drag' : ''} ${previewUrl ? 'has' : ''}`}
              onClick={() => fileInput.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInput.current?.click();
                }
              }}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }}
            >
              {previewUrl ? (
                <>
                  <img src={previewUrl} alt="" onLoad={onPhotoLoad} />
                  <button type="button" className="btn-icon drop-clear" title={t('Remove')}
                    onClick={(e) => { e.stopPropagation(); setImage(null); setImageRef(null); }}>×</button>
                </>
              ) : (
                <span>
                  <div className="drop-icon">⬆</div>
                  <div>{t('Drop a photo here or click to choose')}</div>
                  {isVideo && task.key !== 'animate' && <div className="muted small">{t('The person or object should be fully in view, ideally on a plain background.')}</div>}
                </span>
              )}
            </div>
          )}
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files[0])} />
        </div>
      )}

      {task.video && (
        <div className="field">
          <span className="field-label">{t('Video')} <Info text={t('The video is taken from its start, as long as the length below.')} /></span>
          {videoUrl ? (
            <div className="video-pick">
              <video src={videoUrl} controls muted playsInline preload="metadata" onLoadedMetadata={onVideoMeta} />
              <button type="button" className="btn-icon drop-clear" title={t('Remove')} onClick={() => { setVideo(null); setVideoRef(null); }}>×</button>
            </div>
          ) : (
            <div className="drop" role="button" tabIndex={0} onClick={() => videoInput.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), videoInput.current?.click())}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onVideo(e.dataTransfer.files[0]); }}>
              <span>
                <div className="drop-icon">⬆</div>
                <div>{t('Drop a video here or click (MP4, MOV, WebM)')}</div>
              </span>
            </div>
          )}
          <input ref={videoInput} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(e) => onVideo(e.target.files[0])} />
          <div className="seg" role="radiogroup" aria-label={t('What to keep from the video')}>
            <button type="button" className={`seg-item ${(form.control || 'edges') === 'edges' ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }} onClick={() => set('control')('edges')}>{t('Motion and shapes')}</button>
            <button type="button" className={`seg-item ${form.control === 'gray' ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }} onClick={() => set('control')('gray')}>{t('Colors only')}</button>
          </div>
          <span className="field-hint">
            {form.control === 'gray'
              ? t('Recolor: keeps almost all of the original, the prompt changes the colors')
              : t('Contours: the motion and shapes, a new look from the prompt')}
          </span>
        </div>
      )}

      {!upscale && (
        <PromptField form={form} set={set} preset={preset} isVideo={isVideo} hasImage={!!(acceptsImage && (image || imageRef))} duration={plan.duration} task={task.key} user={user} />
      )}

      {task.strength != null && (
        <label className="field">
          <span className="field-label field-label-row">
            <span>{t('How much to change')} <Info text={t('Low keeps the photo almost as it is, high follows the description and changes it a lot.')} /></span>
            <b>{Math.round((form.strength ?? task.strength) * 100)}%</b>
          </span>
          <input type="range" min={0.1} max={1} step={0.05} value={form.strength ?? task.strength} onChange={(e) => set('strength')(Number(e.target.value))} />
          <div className="field-label-row small muted"><span>{t('Subtle')}</span><span>{t('Strong')}</span></div>
        </label>
      )}

      {upscale && <div className="muted small">{t('The photo becomes 4 times larger. No other settings are needed.')}</div>}

      <div className="field">
        <span className="field-label">{t('Model')}</span>
        <div className="modes" role="radiogroup" aria-label={t('Model')}>
          {modes.map((p) => {
            const e = modeEta(p);
            const lowMem = p.minGtt && system?.gttTotal && system.gttTotal < p.minGtt * 1024 ** 3 * 0.95;
            const size = (p.missing || []).reduce((s, m) => s + (m.size || 0), 0);
            return (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === form.presetId}
                className={`mode-card ${p.id === form.presetId ? 'on' : ''}`} onClick={() => pickPreset(p.id)}>
                <span className="mode-name">{loc(p, 'name')}</span>
                <span className="mode-time">{e ? `≈ ${fmtDuration(e.sec)}` : '—'}</span>
                <span className="mode-badges">
                  {p.experimental && <span className="mode-badge beta">{t('Beta')}</span>}
                  {!p.available && <span className="mode-badge dl">⬇ {fmtBytes(size)}</span>}
                  {lowMem && <span className="mode-badge beta">{t('Needs {n} GB', { n: p.minGtt })}</span>}
                </span>
              </button>
            );
          })}
        </div>
        {preset?.description && <div className="mode-desc">{loc(preset, 'description')}</div>}
        {preset?.minGtt && system?.gttTotal && system.gttTotal < preset.minGtt * 1024 ** 3 * 0.95 && (
          <div className="note warn">⚠ {t('This mode needs about {need} GB of GPU memory (GTT); this system has {have}. It may run out of memory — see the system check.', { need: preset.minGtt, have: fmtBytes(system.gttTotal) })}</div>
        )}
      </div>

      {preset && !preset.available && (
        <MissingModels preset={preset} user={user} goModels={goModels} reloadPresets={reloadPresets} />
      )}

      {!upscale && (<>
      <div className="field">
        <span className="field-label field-label-row">
          <span>{t('Shape and size')} {recommended && <Info text={t('✓ — sizes this mode was tested at and follows the prompt best.')} />}</span>
          {recommended && recommended.length < resolutions.length && (
            <button type="button" className="link muted small" onClick={() => setAllSizes((v) => !v)}>{allSizes ? t('Tested sizes only') : t('Other sizes')}</button>
          )}
        </span>
        <Chips
          items={shownSizes.map(([w, h]) => ({ key: `${w}x${h}`, w, h }))}
          value={`${form.width}x${form.height}`}
          onChange={(k) => { const [w, h] = k.split('x').map(Number); setForm((f) => ({ ...f, width: w, height: h })); }}
          render={(x) => `${x.w > x.h ? '▭' : x.w < x.h ? '▯' : '□'} ${x.w}×${x.h}${tested(x.w, x.h) ? ' ✓' : ''}`}
        />
        {offSize && <div className="note warn">⚠ {t('{w}×{h} is not a size this mode was tested at (✓). The result may not match the prompt.', { w: form.width, h: form.height })}</div>}
      </div>

      {isVideo ? (
        <label className="field">
          <span className="field-label field-label-row">
            <span>
              {t('Length')}{' '}
              <Info text={plan.extendable && plan.maxSegments > 1
                ? t('Up to {base} s in one model pass (the length the model was trained on). Longer videos, up to {max} s, are stitched from several parts (the striped zone).', { base: Number(plan.segSeconds.toFixed(2)), max: Number(plan.maxDuration.toFixed(2)) })
                : t('Up to {max} s per generation — the model limit.', { max: Number(plan.maxDuration.toFixed(2)) })} />
            </span>
            <b className={extraDuration ? 'extra-text' : ''}>{t('{s} s', { s: plan.duration.toFixed(1) })}</b>
          </span>
          <div className="range-wrap" style={{ '--base': `${((plan.segSeconds - 0.5) / (plan.maxDuration - 0.5 || 1)) * 100}%` }}>
            <input type="range" className={`${extraDuration ? 'extra' : ''} ${plan.extendable && plan.maxSegments > 1 ? 'has-extra' : ''}`}
              min={Math.max(0.5, Math.ceil((plan.minFrames / plan.fps) * 2) / 2)} max={plan.maxDuration} step={0.5}
              value={Math.min(form.duration, plan.maxDuration)} onChange={(e) => set('duration')(Number(e.target.value))} />
          </div>
          {extraDuration && (
            <div className="note warn">⚠ {t('Stitched from {n} parts: time ×{n}, details may drift at the joins.', { n: plan.segments })}</div>
          )}
          {plan.beyondTraining && (
            <div className="note warn">⚠ {t('Passes of {frames} frames are longer than the model was trained on ({trained}): the video may lose the subject and turn into a texture. The prompt will suffer.', { frames: plan.frames, trained: plan.trainedFrames })}</div>
          )}
        </label>
      ) : (
        <div className="field">
          <span className="field-label">{t('Variations')} <Info text={t('Each variation is a separate picture; the time grows proportionally.')} /></span>
          <Chips items={COUNTS} value={form.count} onChange={set('count')} />
        </div>
      )}

      <div className="field">
        <span className="field-label">{t('Quality')} <Info text={t('More model passes ({steps}) give a cleaner picture but take longer. Draft is good for trying an idea.', { steps })} /></span>
        <Chips items={QUALITY} value={form.quality} onChange={set('quality')} render={(q) => t(q.label)} />
        {form.quality === 'extra' && <div className="note warn">⚠ {t('Extra: {steps} passes — twice as many as High. Time ×2; the quality gain is already small.', { steps })}</div>}
      </div>

      <button type="button" className="more-toggle" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>{advanced ? '▾' : '▸'} {t('More settings')}</button>
      {advanced && (
        <div className="advanced">
          {isVideo && (
            <div className="field">
              <span className="field-label">
                {t('Smoothness')}{' '}
                <Info text={t('The model renders {native} fps; up to {out} fps the frames are interpolated: smoother motion, no extra detail. Barely affects the time.', { native: plan.fps, out: form.outFps })} />
              </span>
              <Chips items={OUT_FPS} value={form.outFps} onChange={set('outFps')} render={(f) => (f === plan.fps ? `${f} fps · ${t('native')}` : `${f} fps`)} />
            </div>
          )}
          <label className="field">
            <span className="field-label">{t('What to avoid')} <Info text={t('Things you do not want in the result, e.g. text, blur, extra fingers. At prompt strictness 1 it is not used.')} /></span>
            <textarea rows={2} value={form.negative} onChange={(e) => set('negative')(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{t('Variation number')} <Info text={t('Random gives a new variant every time. The same number with the same settings gives the same result: handy for changing one detail and comparing.')} /></span>
            <div className="row">
              <input type="number" value={form.seed} placeholder={t('Random')} onChange={(e) => set('seed')(e.target.value === '' ? -1 : Number(e.target.value))} />
              <button type="button" className="btn" title={t('Random')} onClick={() => set('seed')(-1)}>🎲</button>
            </div>
          </label>

          <details className="more">
            <summary>{t('Expert settings')}</summary>
            <div className="more-body">
              <Num label={<>{t('Prompt strictness')} <Info text={t('How literally the model follows the prompt. Higher is more precise but adds overexposure and artifacts; lower is freer and softer. The default is tuned for the mode.')} /></>}
                value={form.cfg} onChange={set('cfg')} step={0.5} min={0} max={30} />
              <div className="grid2">
                <Num label={t('Width')} value={form.width} onChange={set('width')} step={16} min={128} max={2048} />
                <Num label={t('Height')} value={form.height} onChange={set('height')} step={16} min={128} max={2048} />
              </div>
              {isVideo && (
                <label className="field">
                  <span className="field-label">{t('Length of one part (frames)')}</span>
                  <input type="number" min={plan.minFrames} max={plan.hardMax} step={d.frameRule === 'exact' ? 1 : 4}
                    placeholder={String(plan.trainedFrames)} value={form.segmentFrames ?? ''}
                    onChange={(e) => set('segmentFrames')(e.target.value === '' ? null : Number(e.target.value))} />
                  <span className={`field-hint ${plan.segmentFrames > plan.trainedFrames ? 'extra-text' : ''}`}>
                    {plan.segmentFrames > plan.trainedFrames
                      ? t('Above {trained}, the length the model was trained on: the result stops following the prompt. Up to {max} is possible.', { trained: plan.trainedFrames, max: plan.hardMax })
                      : t('Empty: {trained}, the length the model was trained on. Longer videos are split into passes of this length.', { trained: plan.trainedFrames })}
                  </span>
                </label>
              )}
              {d.flowShift != null && (
                <Num label={<>{t('Motion schedule (flow shift)')} <Info text={t('Fine-tunes the Wan noise schedule. Usually 3; 5 for 720p.')} /></>}
                  value={form.flowShift} onChange={set('flowShift')} step={0.5} min={0} max={30} />
              )}
              <label className="field">
                <span className="field-label">{t('Sampling method')}</span>
                <select value={form.sampler} onChange={(e) => set('sampler')(e.target.value)}>
                  {SAMPLERS.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
            </div>
          </details>
        </div>
      )}
      </>)}

      {error && <div className="error">{error}</div>}

      <div className="form-foot">
        <div className="submit-row">
          <div className="eta">
            <span className="eta-time">
              {eta ? `≈ ${fmtDuration(eta.sec)}` : '—'}
            </span>
            <span className="eta-sub">
              {summary}
              {eta?.source === 'history' ? ` · ${t('by the previous run')}` : eta ? ` · ${t('rough estimate')}` : ''}
            </span>
          </div>
          <button className="btn primary" title="Ctrl+Enter" disabled={busy || !!why}>
            {busy ? t('Submitting…') : queueSize ? t('Add to queue · {n} ahead', { n: queueSize }) : t('Generate')}
          </button>
          {why && !busy && <span className="submit-why">{why}</span>}
        </div>
      </div>
    </form>
  );
}
