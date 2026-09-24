import { useEffect, useMemo, useRef, useState } from 'react';
import { api, estimate, fmtBytes, fmtDuration } from './util.js';
import { loc, t } from './i18n.js';

const FALLBACK_RES = [[512, 512], [768, 512], [512, 768]];
const OUT_FPS = [24, 30, 50, 60, 120];
const COUNTS = [1, 2, 4];
const QUALITY = [
  { key: 'draft', label: 'Draft' },
  { key: 'normal', label: 'Standard' },
  { key: 'high', label: 'High' },
  { key: 'extra', label: 'Extra', extra: true },
];
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
  };
}

// Same formula as the server: Wan takes 4n+1 frames, AnimateDiff exactly duration × fps.
// Longer than the model limit (extra): two segments, the second continues from the last frame of the first.
function planFrames(preset, duration) {
  const d = preset?.defaults || {};
  const nativeFps = d.nativeFps ?? 24;
  const maxFrames = d.maxFrames ?? 121;
  const exact = d.frameRule === 'exact';
  const base = (exact ? maxFrames : maxFrames - 1) / nativeFps;
  const extendable = preset?.kind === 'video' && preset?.image !== 'none';
  const segments = extendable && duration > base + 1e-6 ? 2 : 1;
  const raw = (duration / segments) * nativeFps;
  const frames = Math.min(maxFrames, Math.max(d.minFrames ?? 5, exact ? Math.round(raw) : Math.round(raw / 4) * 4 + 1));
  return { frames, segments, nativeFps, baseDuration: base, maxDuration: extendable ? base * 2 : base, extendable };
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

export default function GenerateForm({ kind, user, presets, templates, system, jobs, reuse, queueSize, onCreated, reloadPresets, goModels }) {
  const [form, setForm] = useState(null);
  const [image, setImage] = useState(null); // File
  const [imageRef, setImageRef] = useState(null); // name of an already uploaded file
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const fileInput = useRef(null);
  const isVideo = kind === 'video';

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
    const { _t, image: img, presetName, frames, steps, fps, segments, kind: _k, ...params } = reuse;
    params.quality ??= 'normal';
    setForm((f) => ({ ...(f || {}), ...params }));
    setImage(null);
    setImageRef(img || null);
  }, [reuse, kind]);

  const previewUrl = useMemo(() => {
    if (image) return URL.createObjectURL(image);
    if (imageRef) return `/files/uploads/${imageRef}`;
    return null;
  }, [image, imageRef]);
  useEffect(() => () => image && previewUrl && URL.revokeObjectURL(previewUrl), [image, previewUrl]);

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

  const d = preset?.defaults || {};
  const resolutions = preset?.resolutions || FALLBACK_RES;
  const acceptsImage = preset && preset.image !== 'none';
  const plan = planFrames(preset, form.duration);
  const steps = qualitySteps(d, form.quality) ?? 20;
  const extraDuration = isVideo && plan.segments > 1;
  const eta = estimate(jobs, isVideo ? { ...form, frames: plan.frames * plan.segments, steps } : { ...form, frames: form.count, steps });
  const interpolated = form.outFps !== plan.nativeFps;

  const onFile = (f) => {
    if (f && f.type.startsWith('image/')) {
      setImage(f);
      setImageRef(null);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form)) if (v != null && v !== '') fd.append(k, v);
      if (acceptsImage && image) fd.append('image', image);
      else if (acceptsImage && imageRef) fd.append('imageRef', imageRef);
      await api('/api/jobs', { method: 'POST', body: fd });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const summary = isVideo
    ? (plan.segments > 1
      ? t('2 segments × {frames} frames at {fps} fps', { frames: plan.frames, fps: plan.nativeFps })
      : t('{frames} frames at {fps} fps', { frames: plan.frames, fps: plan.nativeFps }))
      + (interpolated ? ` → ${form.outFps} fps` : '') + ` · ${form.width}×${form.height}`
    : `${form.count} × ${form.width}×${form.height}`;

  return (
    <form className="card form" onSubmit={submit}>
      <h2>{isVideo ? t('New video') : t('New image')}</h2>

      <label className="field">
        <span className="field-label">{t('Mode')}</span>
        <select value={form.presetId} onChange={(e) => pickPreset(e.target.value)}>
          {presets.map((p) => (
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

      <label className="field">
        <span className="field-label">{t('What to generate')}</span>
        <textarea rows={5} value={form.prompt} required
          placeholder={isVideo ? 'a red fox running through fresh snow, cinematic lighting, slow motion' : 'portrait photo of an old fisherman, golden hour, 85mm, detailed skin'}
          onChange={(e) => set('prompt')(e.target.value)}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.currentTarget.form.requestSubmit()} />
        <span className="field-hint">{t('English prompts work best. Ctrl+Enter submits.')}</span>
      </label>

      {acceptsImage && (
        <div className="field">
          <span className="field-label">
            {isVideo ? t('Start frame') : t('Source image')}{' '}
            <span className="muted">
              {preset.image === 'required' ? t('(required)') : isVideo ? t('(optional: image → video)') : t('(optional: image → image)')}
            </span>
          </span>
          <div
            className={`drop ${drag ? 'drag' : ''} ${previewUrl ? 'has' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }}
          >
            {previewUrl ? (
              <>
                <img src={previewUrl} alt="" />
                <button type="button" className="btn-icon drop-clear" title={t('Remove')}
                  onClick={(e) => { e.stopPropagation(); setImage(null); setImageRef(null); }}>×</button>
              </>
            ) : (
              <span className="muted">{t('Drop an image here or click')}</span>
            )}
          </div>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files[0])} />
        </div>
      )}

      <div className="field">
        <span className="field-label">{t('Resolution')}</span>
        <Chips
          items={resolutions.map(([w, h]) => ({ key: `${w}x${h}`, w, h }))}
          value={`${form.width}x${form.height}`}
          onChange={(k) => { const [w, h] = k.split('x').map(Number); setForm((f) => ({ ...f, width: w, height: h })); }}
          render={(x) => `${x.w}×${x.h}`}
        />
      </div>

      {isVideo ? (
        <>
          <label className="field">
            <span className="field-label field-label-row">
              <span>{t('Duration')} {extraDuration && <span className="extra-badge">{t('extra')}</span>}</span>
              <b className={extraDuration ? 'extra-text' : ''}>{t('{s} s', { s: Number(form.duration).toFixed(1) })}</b>
            </span>
            <div className="range-wrap" style={{ '--base': `${((plan.baseDuration - 0.5) / (plan.maxDuration - 0.5 || 1)) * 100}%` }}>
              <input type="range" className={`${extraDuration ? 'extra' : ''} ${plan.extendable ? 'has-extra' : ''}`}
                min={Math.max(0.5, Math.ceil(((d.minFrames ?? 5) / plan.nativeFps) * 2) / 2)} max={plan.maxDuration} step={0.5}
                value={Math.min(form.duration, plan.maxDuration)} onChange={(e) => set('duration')(Number(e.target.value))} />
            </div>
            <span className={`field-hint ${extraDuration ? 'extra-text' : ''}`}>
              {extraDuration
                ? t('Extra: longer than the model limit ({base} s). The video is built from 2 segments, the second continues from the last frame of the first. Time ×2; a motion jump at the seam is possible.', { base: plan.baseDuration })
                : plan.extendable
                  ? t('Up to {base} s in a single model pass. Beyond that, up to {max} s, is the extra zone (red).', { base: plan.baseDuration, max: plan.maxDuration })
                  : t('Up to {max} s per generation — the model limit.', { max: plan.maxDuration })}
            </span>
          </label>
          <div className="field">
            <span className="field-label">{t('Frames per second (FPS)')}</span>
            <Chips items={OUT_FPS} value={form.outFps} onChange={set('outFps')} />
            <span className="field-hint">
              {interpolated
                ? t('The model renders {native} fps; up to {out} fps the frames are interpolated: smoother motion, no extra detail. Barely affects the time.', { native: plan.nativeFps, out: form.outFps })
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

      {error && <div className="error">{error}</div>}

      <div className="submit-row">
        <button className="btn primary" disabled={busy || !preset?.available || !form.prompt.trim()}>
          {busy ? t('Submitting…') : queueSize ? t('Add to queue ({n} ahead of you)', { n: queueSize }) : t('Generate')}
        </button>
        <span className="muted small">
          {summary}
          <br />
          {eta ? t('≈ {time} based on the previous generation', { time: fmtDuration(eta) }) : t('A time estimate appears after the first generation')}
        </span>
      </div>
    </form>
  );
}
