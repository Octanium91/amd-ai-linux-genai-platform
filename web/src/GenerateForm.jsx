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
  const toFrames = (sec) => (exact ? Math.round(sec * fps) : Math.round((sec * fps) / 4) * 4 + 1);
  const seconds = (f) => (exact ? f : f - 1) / fps;
  let seg = Number(segmentFrames) > 0 ? Math.round(Number(segmentFrames)) : trained;
  if (!exact) seg = Math.round((seg - 1) / 4) * 4 + 1;
  seg = Math.min(hardMax, Math.max(minFrames, seg));
  const extendable = preset?.kind === 'video' && preset?.image !== 'none';
  const maxSegments = extendable ? Math.max(1, d.maxSegments ?? 2) : 1;
  const segSeconds = seconds(seg);
  const maxDuration = segSeconds * maxSegments;
  const wanted = Math.min(maxDuration, Math.max(0.5, Number(duration) || d.duration || 2));
  const segments = Math.min(maxSegments, Math.max(1, Math.ceil(wanted / segSeconds - 1e-6)));
  const frames = Math.min(seg, Math.max(minFrames, toFrames(wanted / segments)));
  return {
    frames, segments, fps, segmentFrames: seg, trainedFrames: trained, segSeconds, maxDuration, maxSegments, extendable,
    // The real length: every seam drops the frame that repeats the previous pass's last one
    hardMax, minFrames, duration: seconds(frames) * segments - (exact && segments > 1 ? (segments - 1) / fps : 0), beyondTraining: frames > trained,
  };
}

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
    for (const [c, color] of [[view.current, 'rgba(240, 106, 106, 0.55)'], [mask.current, '#fff']]) {
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
  const down = (e) => {
    e.preventDefault();
    view.current.setPointerCapture(e.pointerId);
    const p = point(e);
    drawing.current = p;
    stroke(p, p);
  };
  const move = (e) => {
    if (!drawing.current) return;
    const p = point(e);
    stroke(drawing.current, p);
    drawing.current = p;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = null;
    setPainted(true);
    mask.current.toBlob((b) => onChange(b), 'image/png');
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
function PromptField({ form, set, preset, isVideo, hasImage, duration, task }) {
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

  return (
    <div className="field">
      <div className="field-label-row">
        <label className="field-label" htmlFor="prompt-text">{t('What to generate')}</label>
        <span title={title}>
          <button type="button" className="btn ghost btn-small prompt-ai" disabled={!ready || busy || !form.prompt.trim()} onClick={run}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path fill="currentColor" d="M10 3l1.9 5.1L17 10l-5.1 1.9L10 17l-1.9-5.1L3 10l5.1-1.9L10 3zm8 10l.9 2.1L21 16l-2.1.9L18 19l-.9-2.1L15 16l2.1-.9L18 13z" />
            </svg>
            {busy ? t('Writing…') : t('To prompt')}
          </button>
        </span>
      </div>
      <textarea id="prompt-text" rows={5} value={form.prompt} required disabled={busy}
        placeholder={isVideo ? 'a red fox running through fresh snow, cinematic lighting, slow motion' : 'portrait photo of an old fisherman, golden hour, 85mm, detailed skin'}
        onChange={(e) => {
          set('prompt')(e.target.value);
          setUndo(null);
        }}
        onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.repeat && e.currentTarget.form.requestSubmit()} />
      {undo != null && (
        <span className="field-hint">
          {t('The assistant rewrote the description.')}{' '}
          <button type="button" className="link" onClick={() => { set('prompt')(undo); setUndo(null); }}>{t('Restore my text')}</button>
        </span>
      )}
      {error && <span className="field-hint warn">{error}</span>}
      <span className="field-hint">
        {ready ? t('Describe the idea in any language and press "To prompt". English prompts work best. Ctrl+Enter submits.') : t('English prompts work best. Ctrl+Enter submits.')}
      </span>
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
  const [maskBlob, setMaskBlob] = useState(null);
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
    setForm((f) => ({ ...fromPreset(p), prompt: f.prompt }));
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
  const interpolated = form.outFps !== plan.fps;

  const onFile = (f) => {
    if (f && f.type.startsWith('image/')) {
      setImage(f);
      setImageRef(null);
      setMaskBlob(null);
    }
  };
  const onVideo = (f) => {
    if (f && f.type.startsWith('video/')) {
      setVideo(f);
      setVideoRef(null);
    }
  };
  // Rework and inpaint follow the photo's aspect ratio
  const onPhotoLoad = (e) => {
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
      if (task.mask && maskBlob) fd.append('mask', maskBlob, 'mask.png');
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

  const summary = upscale ? t('4× larger') : isVideo
    ? (plan.segments > 1
      ? t('{n} segments × {frames} frames at {fps} fps', { n: plan.segments, frames: plan.frames, fps: plan.fps })
      : t('{frames} frames at {fps} fps', { frames: plan.frames, fps: plan.fps }))
      + (interpolated ? ` → ${form.outFps} fps` : '') + ` · ${form.width}×${form.height}`
    : `${form.count} × ${form.width}×${form.height}`;

  return (
    <form className="card form" onSubmit={submit}>
      <h2>{isVideo ? t('New video') : t('New image')}</h2>

      <div className="task-tabs" role="tablist" aria-label={t('Task')}>
        {tasks.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={x.key === task.key}
            className={`task-tab ${x.key === task.key ? 'on' : ''}`} onClick={() => pickTask(x.key)}>
            <span className="task-name">{t(x.label)}</span>
            <span className="task-hint">{t(x.title)}</span>
          </button>
        ))}
      </div>

      <label className="field">
        <span className="field-label">{t('Mode')}</span>
        <select value={form.presetId} onChange={(e) => pickPreset(e.target.value)}>
          {modes.map((p) => (
            <option key={p.id} value={p.id}>
              {loc(p, 'name')}{p.available ? '' : ` — ${t('models need to be downloaded')}`}
            </option>
          ))}
        </select>
        {preset?.description && <span className="field-hint">{loc(preset, 'description')}</span>}
      </label>

      {preset?.minGtt && system?.gttTotal && system.gttTotal < preset.minGtt * 1024 ** 3 * 0.95 && (
        <div className="missing">
          <div className="small">
            {t('This mode needs about {need} GB of GPU memory (GTT); this system has {have}. It may run out of memory — see the system check.', { need: preset.minGtt, have: fmtBytes(system.gttTotal) })}
          </div>
        </div>
      )}

      {preset && !preset.available && (
        <MissingModels preset={preset} user={user} goModels={goModels} reloadPresets={reloadPresets} />
      )}

      {!upscale && (
        <PromptField form={form} set={set} preset={preset} isVideo={isVideo} hasImage={!!(acceptsImage && (image || imageRef))} duration={plan.duration} task={task.key} />
      )}

      {acceptsImage && (
        <div className="field">
          <span className="field-label">
            {photoLabel(task.key)}
          </span>
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
            {previewUrl && task.mask ? (
              <span className="muted small">{t('Click to choose another photo')}</span>
            ) : previewUrl ? (
              <>
                <img src={previewUrl} alt="" onLoad={onPhotoLoad} />
                <button type="button" className="btn-icon drop-clear" title={t('Remove')}
                  onClick={(e) => { e.stopPropagation(); setImage(null); setImageRef(null); }}>×</button>
              </>
            ) : (
              <span className="muted">{t('Drop an image here or click')}</span>
            )}
          </div>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files[0])} />
          {previewUrl && task.mask && (
            <>
              <img src={previewUrl} alt="" hidden onLoad={onPhotoLoad} />
              <MaskEditor key={previewUrl} src={previewUrl} onChange={setMaskBlob} />
            </>
          )}
        </div>
      )}

      {task.video && (
        <div className="field">
          <span className="field-label">{t('Video')}</span>
          {videoUrl ? (
            <div className="video-pick">
              <video src={videoUrl} controls muted playsInline preload="metadata" />
              <button type="button" className="btn-icon drop-clear" title={t('Remove')} onClick={() => { setVideo(null); setVideoRef(null); }}>×</button>
            </div>
          ) : (
            <div className="drop" role="button" tabIndex={0} onClick={() => videoInput.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), videoInput.current?.click())}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onVideo(e.dataTransfer.files[0]); }}>
              <span className="muted">{t('Drop a video here or click (MP4, MOV, WebM)')}</span>
            </div>
          )}
          <input ref={videoInput} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(e) => onVideo(e.target.files[0])} />
          <span className="field-hint">{t('The video is taken from its start, as long as the duration below.')}</span>
          <label className="field">
            <span className="field-label">{t('What to keep from the video')}</span>
            <select value={form.control || 'edges'} onChange={(e) => set('control')(e.target.value)}>
              <option value="edges">{t('Contours: the motion and shapes, a new look from the prompt')}</option>
              <option value="gray">{t('Grayscale: more of the original, new colors and details')}</option>
            </select>
          </label>
        </div>
      )}

      {task.strength != null && (
        <label className="field">
          <span className="field-label field-label-row">
            <span>{t('How much to change')}</span>
            <b>{Math.round((form.strength ?? task.strength) * 100)}%</b>
          </span>
          <input type="range" min={0.1} max={1} step={0.05} value={form.strength ?? task.strength} onChange={(e) => set('strength')(Number(e.target.value))} />
          <span className="field-hint">{t('Low keeps the photo almost as it is, high follows the description and changes it a lot.')}</span>
        </label>
      )}

      {upscale && <div className="muted small">{t('The photo becomes 4 times larger. No other settings are needed.')}</div>}

      {!upscale && (<>
      <div className="field">
        <span className="field-label">{t('Resolution')}</span>
        <Chips
          items={resolutions.map(([w, h]) => ({ key: `${w}x${h}`, w, h }))}
          value={`${form.width}x${form.height}`}
          onChange={(k) => { const [w, h] = k.split('x').map(Number); setForm((f) => ({ ...f, width: w, height: h })); }}
          render={(x) => `${x.w}×${x.h}${recommended?.some(([w, h]) => w === x.w && h === x.h) ? ' ✓' : ''}`}
        />
        {recommended && (
          <span className={`field-hint ${offSize ? 'extra-text' : ''}`}>
            {offSize
              ? t('{w}×{h} is not a size this mode was tested at (✓). The result may not match the prompt.', { w: form.width, h: form.height })
              : t('✓ — sizes this mode was tested at and follows the prompt best.')}
          </span>
        )}
      </div>

      {isVideo ? (
        <>
          <label className="field">
            <span className="field-label field-label-row">
              <span>{t('Duration')} {extraDuration && <span className="extra-badge">{t('extra')}</span>}</span>
              <b className={extraDuration ? 'extra-text' : ''}>{t('{s} s', { s: (isVideo ? plan.duration : Number(form.duration)).toFixed(1) })}</b>
            </span>
            <div className="range-wrap" style={{ '--base': `${((plan.segSeconds - 0.5) / (plan.maxDuration - 0.5 || 1)) * 100}%` }}>
              <input type="range" className={`${extraDuration ? 'extra' : ''} ${plan.extendable && plan.maxSegments > 1 ? 'has-extra' : ''}`}
                min={Math.max(0.5, Math.ceil((plan.minFrames / plan.fps) * 2) / 2)} max={plan.maxDuration} step={0.5}
                value={Math.min(form.duration, plan.maxDuration)} onChange={(e) => set('duration')(Number(e.target.value))} />
            </div>
            <span className={`field-hint ${extraDuration ? 'extra-text' : ''}`}>
              {extraDuration
                ? t('Built from {n} passes of {s} s: each continues from the last frame of the previous one, so details may drift at the seams. Time ×{n}.', { n: plan.segments, s: Number(plan.segSeconds.toFixed(2)) })
                : plan.extendable && plan.maxSegments > 1
                  ? t('Up to {base} s in one model pass (the length the model was trained on). Longer videos, up to {max} s, are built from several passes (red zone).', { base: Number(plan.segSeconds.toFixed(2)), max: Number(plan.maxDuration.toFixed(2)) })
                  : t('Up to {max} s per generation — the model limit.', { max: Number(plan.maxDuration.toFixed(2)) })}
            </span>
            {plan.beyondTraining && (
              <span className="field-hint extra-text">
                {t('Passes of {frames} frames are longer than the model was trained on ({trained}): the video may lose the subject and turn into a texture. The prompt will suffer.', { frames: plan.frames, trained: plan.trainedFrames })}
              </span>
            )}
          </label>
          <div className="field">
            <span className="field-label">{t('Frames per second (FPS)')}</span>
            <Chips items={OUT_FPS} value={form.outFps} onChange={set('outFps')} />
            <span className="field-hint">
              {interpolated
                ? t('The model renders {native} fps; up to {out} fps the frames are interpolated: smoother motion, no extra detail. Barely affects the time.', { native: plan.fps, out: form.outFps })
                : t('The native frame rate of the model, no interpolation.')}
            </span>
          </div>
        </>
      ) : (
        <div className="field">
          <span className="field-label">{t('Number of variants')}</span>
          <Chips items={COUNTS} value={form.count} onChange={set('count')} />
          <span className="field-hint">{t('Each variant is a separate generation with a new seed; the time grows proportionally.')}</span>
        </div>
      )}

      <div className="field">
        <span className="field-label">{t('Quality')}</span>
        <Chips items={QUALITY} value={form.quality} onChange={set('quality')} render={(q) => t(q.label)} />
        <span className={`field-hint ${form.quality === 'extra' ? 'extra-text' : ''}`}>
          {form.quality === 'extra'
            ? t('Extra: {steps} passes — twice as many as High. Time ×2; the quality gain is already small.', { steps })
            : t('More model passes ({steps}) give a cleaner picture but take longer. Draft is good for trying an idea.', { steps })}
        </span>
      </div>

      <button type="button" className="link" onClick={() => setAdvanced((a) => !a)}>{advanced ? '▾' : '▸'} {t('Advanced')}</button>
      {advanced && (
        <div className="advanced">
          <label className="field">
            <span className="field-label">{t('What to avoid (negative prompt)')}</span>
            <textarea rows={2} value={form.negative} onChange={(e) => set('negative')(e.target.value)} />
            {form.cfg <= 1 && <span className="field-hint">{t('At CFG 1 the negative prompt is not used.')}</span>}
          </label>
          <Num label={t('Prompt adherence (CFG)')} value={form.cfg} onChange={set('cfg')} step={0.5} min={0} max={30}
            hint={t('How literally the model follows the prompt. Higher is more precise but adds overexposure and artifacts; lower is freer and softer. The default is tuned for the mode.')} />
          <label className="field">
            <span className="field-label">{t('Random seed')}</span>
            <div className="row">
              <input type="number" value={form.seed} onChange={(e) => set('seed')(e.target.value === '' ? -1 : Number(e.target.value))} />
              <button type="button" className="btn-icon" title={t('Random (-1)')} onClick={() => set('seed')(-1)}>⚄</button>
            </div>
            <span className="field-hint">{t('−1 gives a new variant every time. The same seed with the same settings gives the same result: handy for changing one detail and comparing.')}</span>
          </label>
          <div className="grid2">
            <Num label={t('Width')} value={form.width} onChange={set('width')} step={16} min={128} max={2048} />
            <Num label={t('Height')} value={form.height} onChange={set('height')} step={16} min={128} max={2048} />
          </div>
          {isVideo && (
            <label className="field">
              <span className="field-label">{t('Frames per model pass')}</span>
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
            <Num label="Flow shift" value={form.flowShift} onChange={set('flowShift')} step={0.5} min={0} max={30}
              hint={t('Fine-tunes the Wan noise schedule. Usually 3; 5 for 720p.')} />
          )}
          <label className="field">
            <span className="field-label">{t('Sampler')}</span>
            <select value={form.sampler} onChange={(e) => set('sampler')(e.target.value)}>
              {SAMPLERS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
      )}
      </>)}

      {error && <div className="error">{error}</div>}

      <div className="submit-row">
        <button className="btn primary" disabled={busy || !preset?.available || (!upscale && !form.prompt.trim())}>
          {busy ? t('Submitting…') : queueSize ? t('Add to queue ({n} ahead of you)', { n: queueSize }) : t('Generate')}
        </button>
        <span className="muted small">
          {summary}
          <br />
          {eta?.source === 'history'
            ? t('≈ {time} based on the previous generation', { time: fmtDuration(eta.sec) })
            : eta
              ? t('≈ {time}, a rough estimate for the {gpu}', { time: fmtDuration(eta.sec), gpu: eta.gpu })
              : t('A time estimate appears after the first generation')}
        </span>
      </div>
    </form>
  );
}
