import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, CSRF, estimate, fmtBytes, fmtDuration, langName, SPEECH_LANGS, SPEECH_VOICES, voiceName } from './util.js';
import { getLang, loc, t, tError } from './i18n.js';

const FALLBACK_RES = [[512, 512], [768, 512], [512, 768]];
// Output frame rates: the mode's own list, or native, 2× and 3× up to 48 (same rule as the server)
const outFpsOptions = (preset) => {
  const d = preset?.defaults || {};
  const fps = d.nativeFps ?? 24;
  return d.outFpsOptions || [fps, fps * 2, fps * 3].filter((f, i) => i === 0 || f <= 48);
};
const fmtLength = (sec) => (sec >= 60 ? fmtDuration(sec) : t('{s} s', { s: sec.toFixed(1) }));
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
    { key: 'cutout', label: 'Remove background', title: 'Keep the subject, make the background transparent (PNG)', image: true, noPrompt: true, cutout: true },
    { key: 'upscale', label: 'Upscale', title: 'A photo 4× larger with restored detail', image: true, noPrompt: true },
  ],
  video: [
    { key: 'create', label: 'Create', title: 'A video from a description' },
    { key: 'animate', label: 'Animate a photo', title: 'Your photo becomes the first frame and comes alive', image: true },
    { key: 'reference', label: 'Put a person in', title: 'A person or object from a photo in a new video', image: true },
    { key: 'restyle', label: 'Change a video', title: 'The motion of your video with a new look', video: true, imageOptional: true },
  ],
  audio: [
    { key: 'music', label: 'Music', title: 'A song with vocals or an instrumental from a description' },
    { key: 'sfx', label: 'Sound effect', title: 'A sound or an ambience from a description' },
    { key: 'speech', label: 'Speech', title: 'A text read aloud in a chosen voice' },
  ],
};
const fitsTask = (p, task) => (p.tasks || ['create']).includes(task.key);
const photoLabel = (task) => ({
  rework: t('Photo to rework'),
  inpaint: t('Photo'),
  upscale: t('Photo to upscale'),
  cutout: t('Photo'),
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
    // Audio: lyrics (the model writes them, yours, or none) and the speech voice
    lyricsMode: 'auto',
    lyrics: '',
    voice: d.voice ?? 'F1',
    language: SPEECH_LANGS.includes(getLang()) ? getLang() : d.language ?? 'en',
    speed: d.speed ?? 1,
  };
}

// A long video is made of parts, each continuing from the last frame of the previous one. Each part
// can have its own scene; the prompt assistant writes them all from the idea (one subject and style
// block shared by every part, one action per part). Empty parts repeat the main prompt.
const SHOWN_PARTS = 8;
const KEYFRAME_ORDER = ['img-z-image-turbo', 'img-realvisxl-lightning', 'img-realvisxl', 'img-realistic-vision'];

function StoryboardField({ form, set, preset, plan, hasImage, shots, keyModes, keyMode }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => {
    api('/api/prompt/status').then(setStatus).catch(() => {});
  }, []);
  const n = plan.segments;
  const prompts = form.prompts || [];
  const ready = !!status?.ready;
  // Part i covers its frames minus the first one, which repeats the previous part's last frame
  const at = (i) => (i === 0 ? 0 : (plan.frames + (i - 1) * (plan.frames - 1)) / plan.fps);
  const setPart = (i, v) => {
    const next = Array.from({ length: n }, (_, k) => prompts[k] || '');
    next[i] = v;
    set('prompts')(next);
  };
  const write = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api('/api/prompt/storyboard', {
        method: 'POST',
        json: { presetId: preset.id, prompt: form.prompt, parts: n, partSeconds: (plan.frames - 1) / plan.fps, hasImage },
      });
      set('prompts')(r.prompts);
      setAll(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const shown = all ? n : Math.min(n, SHOWN_PARTS);
  return (
    <div className="field">
      <span className="field-label field-label-row">
        <span>{t('Scenes')} <Info text={t('The video is made of {n} parts, each continuing from the last frame of the previous one. Give each part its own action and keep the person and the place the same.', { n })} /></span>
        {prompts.some(Boolean) && <button type="button" className="link muted small" onClick={() => set('prompts')([])}>{t('Clear')}</button>}
      </span>
      <div className="seg" role="radiogroup" aria-label={t('How the parts connect')}>
        <button type="button" role="radio" aria-checked={shots} className={`seg-item ${shots ? 'on' : ''}`} disabled={!keyModes.length}
          style={{ flex: 1, justifyContent: 'center' }} onClick={() => set('shots')(true)}>{t('A new shot per part')}</button>
        <button type="button" role="radio" aria-checked={!shots} className={`seg-item ${!shots ? 'on' : ''}`}
          style={{ flex: 1, justifyContent: 'center' }} onClick={() => set('shots')(false)}>{t('One continuous shot')}</button>
      </div>
      <span className="field-hint">
        {shots
          ? t('Every part starts from its own keyframe drawn by an image mode, so the action really changes; the parts are joined with cuts.')
          : keyModes.length
            ? t('Every part continues from the last frame of the previous one: smooth, but the action barely changes.')
            : t('Every part continues from the last frame of the previous one. Download an image mode for a video made of shots.')}
      </span>
      {shots && keyModes.length > 1 && (
        <div className="chips">
          {keyModes.map((p) => (
            <button key={p.id} type="button" className={`chip ${keyMode?.id === p.id ? 'on' : ''}`} onClick={() => set('keyframePreset')(p.id)}>{loc(p, 'name')}</button>
          ))}
        </div>
      )}
      {ready ? (
        <button type="button" className="btn btn-small" disabled={busy || !form.prompt.trim()} onClick={write}>
          {busy ? (n > 8 ? t('Writing the scenes… up to a few minutes for a long video') : t('Writing the scenes…')) : `✦ ${t('Write the scenes with AI')}`}
        </button>
      ) : (
        <span className="field-hint">{t('Without the prompt assistant, write a scene for each part yourself: empty parts repeat the main prompt, and the action repeats with it.')}</span>
      )}
      {error && <div className="note warn">⚠ {error}</div>}
      <div className="parts">
        {Array.from({ length: shown }, (_, i) => (
          <label key={i} className="part">
            <span className="part-label">{t('Part {n}', { n: i + 1 })} <span className="muted">· {fmtLength(at(i))}–{fmtLength(at(i + 1))}</span></span>
            <textarea rows={2} value={prompts[i] || ''} placeholder={form.prompt || t('The main prompt')} onChange={(e) => setPart(i, e.target.value)} />
          </label>
        ))}
      </div>
      {n > SHOWN_PARTS && (
        <button type="button" className="link small" onClick={() => setAll((v) => !v)}>{all ? t('Show fewer parts') : t('Show all {n} parts', { n })}</button>
      )}
    </div>
  );
}

// Audio settings: lyrics and length for music, length for sound effects, voice, language and speed
// for speech
function AudioFields({ task, form, set, preset }) {
  const d = preset?.defaults || {};
  if (task === 'speech') {
    return (
      <>
        <div className="field">
          <span className="field-label">{t('Voice')}</span>
          <div className="chips">
            {SPEECH_VOICES.map((v) => (
              <button key={v} type="button" className={`chip ${form.voice === v ? 'on' : ''}`} onClick={() => set('voice')(v)}>{voiceName(v)}</button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">{t('Language of the text')} <Info text={t('The language the text is written in; the voice reads it with that pronunciation.')} /></span>
          <select value={form.language} onChange={(e) => set('language')(e.target.value)}>
            {SPEECH_LANGS.map((c) => <option key={c} value={c}>{langName(c)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label field-label-row"><span>{t('Speed')}</span><b>×{Number(form.speed).toFixed(2)}</b></span>
          <input type="range" min={0.7} max={1.5} step={0.05} value={form.speed} onChange={(e) => set('speed')(Number(e.target.value))} />
          <div className="field-label-row small muted"><span>{t('Slower')}</span><span>{t('Faster')}</span></div>
        </label>
      </>
    );
  }
  const min = d.minDuration ?? 1;
  const max = d.maxDuration ?? 30;
  const step = task === 'music' ? 5 : 1;
  return (
    <>
      {task === 'music' && (
        <div className="field">
          <span className="field-label">{t('Lyrics')} <Info text={t('Mark parts with [verse], [chorus], [bridge]. The model sings in the language of the lyrics.')} /></span>
          <div className="seg" role="radiogroup" aria-label={t('Lyrics')}>
            {[['auto', t('The model writes them')], ['mine', t('My lyrics')], ['instrumental', t('No vocals')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={form.lyricsMode === k} className={`seg-item ${form.lyricsMode === k ? 'on' : ''}`}
                style={{ flex: 1, justifyContent: 'center' }} onClick={() => set('lyricsMode')(k)}>{label}</button>
            ))}
          </div>
          {form.lyricsMode === 'mine' && (
            <textarea rows={6} value={form.lyrics} placeholder={'[verse]\nMorning light on the empty street\n[chorus]\nWe are running, we are free'}
              onChange={(e) => set('lyrics')(e.target.value)} />
          )}
          {form.lyricsMode === 'auto' && <span className="field-hint">{t('The model writes lyrics that fit the description.')}</span>}
        </div>
      )}
      <label className="field">
        <span className="field-label field-label-row"><span>{t('Length')}</span><b>{fmtDuration(form.duration)}</b></span>
        <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, form.duration))} onChange={(e) => set('duration')(Number(e.target.value))} />
        <div className="field-label-row small muted"><span>{fmtDuration(min)}</span><span>{fmtDuration(max)}</span></div>
      </label>
    </>
  );
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
    <span className="hint-i" tabIndex={0} role="note" aria-label={text} onClick={(e) => e.preventDefault()}>
      i<span className="info-pop">{text}</span>
    </span>
  );
}

const TASK_ICONS = {
  create: 'M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm6.5 12l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z',
  rework: 'M4 5h11a2 2 0 0 1 2 2v3h-2V7H4v10h6v2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm15.6 7.6 1.8 1.8-6.6 6.6H13v-1.8l6.6-6.6zM6 15l2.5-3.2 1.8 2.2 1.2-1.5L14 15H6z',
  inpaint: 'M20.7 5.6 18.4 3.3a1 1 0 0 0-1.4 0L9 11.3 12.7 15l8-8a1 1 0 0 0 0-1.4zM7.5 13c-1.9 0-3.5 1.6-3.5 3.5 0 1.2-.8 2.2-2 2.5.9 1.2 2.4 2 4 2 2.8 0 5-2.2 5-5 0-1.7-1.6-3-3.5-3z',
  upscale: 'M4 4h6v2H7.4l4.3 4.3-1.4 1.4L6 7.4V10H4V4zm16 16h-6v-2h2.6l-4.3-4.3 1.4-1.4 4.3 4.3V14h2v6z',
  cutout: 'M9.6 7.6A3.5 3.5 0 1 0 6 11a3.4 3.4 0 0 0 1.5-.4L10 13l-2.5 2.4A3.5 3.5 0 1 0 9.6 17l2.4-2.4 7 7H22L9.6 7.6zM6 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0 11a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm6-8.5 1.5 1.5L22 5.5V3h-2.5L12 11.5z',
  animate: 'M4 5h12a2 2 0 0 1 2 2v2.5l4-2.5v10l-4-2.5V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm4 3.5v7l5.5-3.5L8 8.5z',
  reference: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-7 1.7-7 4.5V20h11.1a6 6 0 0 1 3.9-6.2C15.4 13.3 12.4 13 9 13zm10 1v3h3v2h-3v3h-2v-3h-3v-2h3v-3h2z',
  restyle: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6H4zm2 2h2v2H6V8zm0 6h2v2H6v-2zm10-6h2v2h-2V8zm0 6h2v2h-2v-2zm-5.5-5 4 3-4 3V9z',
};
TASK_ICONS.music = 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z';
TASK_ICONS.sfx = 'M3 10h2v4H3v-4zm4-3h2v10H7V7zm4-4h2v18h-2V3zm4 4h2v10h-2V7zm4 3h2v4h-2v-4z';
TASK_ICONS.speech = 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z';
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

// Background removal. The server's model returns a soft mask of the main subject; here it becomes
// the alpha channel of the photo, shown over a checkerboard. "Keep" and "remove" brushes paint on
// that alpha channel, and the result is exported as a PNG with transparency in the browser.
function CutoutEditor({ src, file, imageRef }) {
  const view = useRef(null);
  const alpha = useRef(null);
  const photo = useRef(null);
  const auto = useRef(null); // the model's mask, for "Reset"
  const drawing = useRef(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [mode, setMode] = useState('keep');
  const [brush, setBrush] = useState(4); // % of the photo width
  const [ghost, setGhost] = useState(false);

  const render = useCallback(() => {
    const v = view.current;
    const img = photo.current;
    if (!v || !img || !alpha.current) return;
    const g = v.getContext('2d');
    g.clearRect(0, 0, v.width, v.height);
    if (ghost) {
      g.globalAlpha = 0.25;
      g.drawImage(img, 0, 0, v.width, v.height);
      g.globalAlpha = 1;
    }
    // The cut-out subject: the photo where the alpha canvas is opaque
    const tmp = document.createElement('canvas');
    tmp.width = v.width;
    tmp.height = v.height;
    const tg = tmp.getContext('2d');
    tg.drawImage(img, 0, 0, v.width, v.height);
    tg.globalCompositeOperation = 'destination-in';
    tg.drawImage(alpha.current, 0, 0);
    g.drawImage(tmp, 0, 0);
  }, [ghost]);

  // Ask the server for the subject mask, then turn it into the alpha canvas
  useEffect(() => {
    let alive = true;
    setState('loading');
    setError('');
    (async () => {
      try {
        const fd = new FormData();
        if (file) fd.append('image', file);
        else fd.append('imageRef', imageRef);
        const r = await fetch('/api/cutout', { method: 'POST', body: fd, headers: CSRF });
        if (!r.ok) throw new Error(tError((await r.json().catch(() => ({}))).error) || `HTTP ${r.status}`);
        const mask = await createImageBitmap(await r.blob());
        const img = new Image();
        img.src = src;
        await img.decode();
        if (!alive) return;
        photo.current = img;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        view.current.width = w;
        view.current.height = h;
        const a = document.createElement('canvas');
        a.width = w;
        a.height = h;
        const ag = a.getContext('2d');
        ag.drawImage(mask, 0, 0, w, h);
        const d = ag.getImageData(0, 0, w, h);
        for (let i = 0; i < d.data.length; i += 4) {
          d.data[i + 3] = d.data[i];
          d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
        }
        ag.putImageData(d, 0, 0);
        auto.current = d;
        alpha.current = a;
        setState('ready');
      } catch (e) {
        if (alive) {
          setError(e.message);
          setState('error');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [src, file, imageRef]);

  useEffect(() => {
    if (state === 'ready') render();
  }, [state, render]);

  const point = (e) => {
    const r = view.current.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * view.current.width, ((e.clientY - r.top) / r.height) * view.current.height];
  };
  const stroke = (from, to) => {
    const g = alpha.current.getContext('2d');
    g.globalCompositeOperation = mode === 'keep' ? 'source-over' : 'destination-out';
    g.strokeStyle = '#fff';
    g.lineWidth = (brush / 100) * alpha.current.width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(...from);
    g.lineTo(...to);
    g.stroke();
    g.globalCompositeOperation = 'source-over';
    render();
  };
  const down = (e) => {
    if (state !== 'ready' || drawing.current) return;
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
    if (drawing.current?.id === e.pointerId) drawing.current = null;
  };
  const reset = () => {
    alpha.current.getContext('2d').putImageData(auto.current, 0, 0);
    render();
  };
  // The PNG is made without the faint original, whatever the view shows
  const download = () => {
    const out = document.createElement('canvas');
    out.width = view.current.width;
    out.height = view.current.height;
    const g = out.getContext('2d');
    g.drawImage(photo.current, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(alpha.current, 0, 0);
    out.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cutout.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  };

  return (
    <div className="mask-editor">
      <div className="mask-stage cutout-stage">
        <canvas ref={view} className="cutout-view" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        {state === 'loading' && <div className="cutout-wait"><span className="dot live" /> {t('Finding the subject…')}</div>}
      </div>
      {state === 'error' && <div className="error">{error}</div>}
      {state === 'ready' && (
        <>
          <div className="mask-tools">
            <div className="seg" role="radiogroup" aria-label={t('Brush')}>
              <button type="button" className={`seg-item ${mode === 'keep' ? 'on' : ''}`} onClick={() => setMode('keep')}>＋ {t('Keep')}</button>
              <button type="button" className={`seg-item ${mode === 'remove' ? 'on' : ''}`} onClick={() => setMode('remove')}>− {t('Remove')}</button>
            </div>
            <label className="mask-brush">
              <span className="muted small">{t('Brush')}</span>
              <input type="range" min={1} max={15} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
            </label>
          </div>
          <div className="mask-tools">
            <label className="checkbox checkbox-sm"><input type="checkbox" checked={ghost} onChange={(e) => setGhost(e.target.checked)} /> {t('Show the removed part faintly')}</label>
            <button type="button" className="btn btn-small ghost" onClick={reset}>{t('Reset')}</button>
          </div>
          <span className="field-hint">{t('Paint with "Keep" over what the model missed and with "Remove" over what should go.')}</span>
          <button type="button" className="btn primary" onClick={download}>⬇ {t('Download PNG')}</button>
        </>
      )}
    </div>
  );
}

// The prompt field with the "To prompt" assistant: an Ollama model (connected by an administrator
// in Settings) rewrites the description into a detailed English prompt for the selected mode.
// The previous text can be restored with one click.
const AUDIO_PROMPT = {
  music: { label: 'Describe the music', placeholder: 'upbeat indie pop, bright electric guitars, punchy drums, warm female vocal' },
  sfx: { label: 'Describe the sound', placeholder: 'heavy rain on a tin roof with distant rolling thunder' },
  speech: { label: 'Text to read aloud', placeholder: null },
};

function PromptField({ form, set, preset, isVideo, hasImage, duration, task, user, audio = false }) {
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
        json: { presetId: preset.id, prompt: form.prompt, width: form.width, height: form.height, duration: isVideo ? duration : audio ? form.duration : null, hasImage, task, lyricsMode: audio ? form.lyricsMode : null },
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
  // Speech is read as written: nothing to improve there
  const showButton = task !== 'speech' && (ready || status?.enabled || admin);
  const ap = audio ? AUDIO_PROMPT[task] : null;
  return (
    <div className="field">
      <label className="field-label" htmlFor="prompt-text">{ap ? t(ap.label) : isVideo ? t('Describe the video') : t('Describe the picture')}</label>
      <div className="prompt-box">
        <textarea id="prompt-text" rows={task === 'speech' ? 6 : 4} value={form.prompt} required disabled={busy}
          placeholder={ap && !(ready && task !== 'speech') ? ap.placeholder || t('Hello! This text will be read aloud.') : ready
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
      {task === 'sfx' && <span className="field-hint">{ready ? t('The sound model understands only English: ✦ translates your description.') : t('Describe it in English: the sound model understands only English.')}</span>}
      {task !== 'speech' && !ready && admin && !status?.enabled && <div className="note">{t('Connect an Ollama model in Settings to turn a short description into a detailed prompt.')}</div>}
    </div>
  );
}

// The soundtrack of a video: none, an audio file (or a video whose sound is taken), or for "Change a
// video" the sound of the uploaded video. The worker cuts it to the clip's length.
function SoundField({ sound, setSound, duration, canUseVideo }) {
  const input = useRef(null);
  const [length, setLength] = useState(null); // seconds of the chosen file
  const { source, file, ref, start, fade } = sound;
  const url = useMemo(() => (file ? URL.createObjectURL(file) : ref ? `/files/uploads/${ref}` : null), [file, ref]);
  useEffect(() => () => file && url && URL.revokeObjectURL(url), [file, url]);
  useEffect(() => setLength(null), [url]);
  const upd = (patch) => setSound((s) => ({ ...s, ...patch }));
  const onFile = (f) => {
    if (f && (!f.type || /^(audio|video)\//.test(f.type))) upd({ file: f, ref: null, start: 0 });
  };
  const maxStart = length ? Math.max(0, Math.floor((length - 0.5) * 2) / 2) : 0;
  const choices = [['none', t('No sound')], ['file', t('Your track')], ...(canUseVideo ? [['video', t('From the video')]] : [])];
  return (
    <div className="field">
      <span className="field-label">{t('Sound')} <Info text={t('The track is cut to the length of the video, or padded with silence if it is shorter.')} /></span>
      <div className="seg" role="radiogroup" aria-label={t('Sound')}>
        {choices.map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={source === k} className={`seg-item ${source === k ? 'on' : ''}`}
            style={{ flex: 1, justifyContent: 'center' }} onClick={() => upd({ source: k })}>{label}</button>
        ))}
      </div>
      {source === 'video' && <span className="field-hint">{t('The sound of the uploaded video, from its start.')}</span>}
      {source === 'file' && (url ? (
        <div className="sound-pick">
          <div className="sound-player">
            <audio src={url} controls preload="metadata" onLoadedMetadata={(e) => setLength(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)} />
            <button type="button" className="btn-icon" title={t('Remove')} onClick={() => upd({ file: null, ref: null, start: 0 })}>×</button>
          </div>
          {length > 1 && (
            <label className="field">
              <span className="field-label field-label-row">
                <span>{t('Start at')}</span>
                <b>{t('{a}–{b} s of {total} s', { a: Number(start).toFixed(1), b: Math.min(length, Number(start) + duration).toFixed(1), total: length.toFixed(1) })}</b>
              </span>
              <input type="range" min={0} max={maxStart} step={0.5} value={Math.min(start, maxStart)} onChange={(e) => upd({ start: Number(e.target.value) })} />
            </label>
          )}
          {length != null && length - start < duration && <span className="field-hint">{t('The track is shorter than the video: the rest will be silent.')}</span>}
          <label className="checkbox checkbox-sm"><input type="checkbox" checked={fade} onChange={(e) => upd({ fade: e.target.checked })} /> {t('Fade out at the end')}</label>
        </div>
      ) : (
        <div className="drop drop-small" role="button" tabIndex={0} onClick={() => input.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}>
          <span>
            <div className="drop-icon">♪</div>
            <div>{t('Drop an audio file here or click (MP3, WAV, OGG, FLAC, M4A or a video)')}</div>
          </span>
        </div>
      ))}
      <input ref={input} type="file" accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,video/mp4,video/quicktime,video/webm" hidden onChange={(e) => { onFile(e.target.files[0]); e.target.value = ''; }} />
    </div>
  );
}

const NO_SOUND = { source: 'none', file: null, ref: null, start: 0, fade: true };

export default function GenerateForm({ kind, user, presets, allPresets = [], templates, system, jobs, reuse, onReuseApplied, queueSize, onCreated, reloadPresets, goModels }) {
  const submitting = useRef(false);
  const [form, setForm] = useState(null);
  const [image, setImage] = useState(null); // File
  const [imageRef, setImageRef] = useState(null); // name of an already uploaded file
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [taskKey, setTaskKey] = useState(() => (TASKS[kind] || TASKS.image)[0].key);
  const [allSizes, setAllSizes] = useState(false);
  const [maskBlob, setMaskBlob] = useState(null); // a promise of the mask PNG
  const [photoSize, setPhotoSize] = useState(null); // [width, height] of the current photo
  const [video, setVideo] = useState(null); // File
  const [videoRef, setVideoRef] = useState(null); // name of an already uploaded video
  const [sound, setSound] = useState(NO_SOUND);
  const fileInput = useRef(null);
  const videoInput = useRef(null);
  const isVideo = kind === 'video';
  const isAudio = kind === 'audio';
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
    // An audio result as the sound of the video being made: nothing else in the form changes
    if (reuse.soundOnly) {
      setSound({ ...NO_SOUND, source: 'file', ref: reuse.audio });
      onReuseApplied?.();
      return;
    }
    const { _t, image: img, video: _v, mask: _m, audio, audioStart, audioFade, task: _task, presetName, frames, steps, fps, segments, kind: _k, ...params } = reuse;
    params.quality ??= 'normal';
    if (kind === 'audio') params.lyricsMode = params.lyrics === '[Instrumental]' ? 'instrumental' : params.lyrics ? 'mine' : 'auto';
    setForm((f) => ({ ...(f || {}), ...params }));
    setImage(null);
    setImageRef(img || null);
    setVideo(null);
    setVideoRef(reuse.video || null);
    setSound(!audio ? NO_SOUND
      : audio === reuse.video ? { ...NO_SOUND, source: 'video' }
        : { ...NO_SOUND, source: 'file', ref: audio, start: audioStart || 0, fade: audioFade !== false });
    setMaskBlob(null);
    setTaskKey(reuse.task || (img ? (kind === 'video' ? 'animate' : 'rework') : (TASKS[kind] || TASKS.image)[0].key));
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
      setSound((s) => (s.source === 'video' ? { ...s, source: 'none' } : s));
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
  // A video made of shots: an image mode draws a keyframe for every part first
  const keyModes = KEYFRAME_ORDER.map((id) => allPresets.find((p) => p.id === id && p.available)).filter(Boolean);
  const keyMode = keyModes.find((p) => p.id === form.keyframePreset) || keyModes[0] || null;
  const shots = isVideo && plan.segments > 1 && form.shots !== false && !!keyMode;
  // The keyframe is drawn near the video size, at least 0.5 MP (as on the server)
  const keyArea = shots ? Math.min((keyMode.defaults?.width || 512) * (keyMode.defaults?.height || 512), Math.max(form.width * form.height, 0.5e6)) : 0;
  const keyEta = shots ? estimate(jobs, { presetId: keyMode.id, width: Math.sqrt(keyArea * form.width / form.height), height: Math.sqrt(keyArea * form.height / form.width), cfg: keyMode.defaults?.cfg, steps: qualitySteps(keyMode.defaults || {}, 'normal') ?? 20, frames: 1 }, keyMode, system?.gpuPower) : null;
  const videoEta = estimate(jobs, isVideo ? { ...form, frames: plan.frames * plan.segments, steps, shots }
    : isAudio ? { ...form, task: task.key } : { ...form, frames: form.count, steps }, preset, system?.gpuPower);
  // A previous run of the mode already includes its keyframes when it was made of shots
  const lastRun = jobs.filter((j) => j.status === 'done' && j.params.presetId === form.presetId).sort((a, b) => b.finishedAt - a.finishedAt)[0];
  const eta = videoEta && keyEta && !(videoEta.source === 'history' && lastRun?.params.shots)
    ? { ...videoEta, sec: videoEta.sec + keyEta.sec * plan.segments } : videoEta;
  // The expected time with one setting changed, shown on its chip, so a choice shows what it costs
  const etaWith = (o) => {
    const f = { ...form, ...o };
    const st = qualitySteps(d, f.quality) ?? 20;
    const e = estimate(jobs, isVideo ? { ...f, frames: plan.frames * plan.segments, steps: st, shots } : { ...f, frames: f.count, steps: st }, preset, system?.gpuPower);
    return e ? fmtDuration(e.sec) : null;
  };
  // The time per result of every mode card, at its own default size and the chosen quality
  const modeEta = (p) => {
    if (p.id === form.presetId) return eta;
    const pd = p.defaults || {};
    if (isAudio) return estimate(jobs, { presetId: p.id, task: task.key, prompt: form.prompt, duration: pd.duration }, p);
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
    if (submitting.current || task.cutout) return;
    if (task.image && !image && !imageRef) return setError(t('Add a photo for this task.'));
    if (task.mask && !maskBlob) return setError(t('Paint the part of the photo to change.'));
    if (task.video && !video && !videoRef) return setError(t('Add a video for this task.'));
    if (isVideo && sound.source === 'file' && !sound.file && !sound.ref) return setError(t('Add an audio file or choose No sound.'));
    submitting.current = true;
    setError('');
    setBusy(true);
    try {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form)) if (k !== 'prompts' && v != null && v !== '') fd.append(k, v);
      if (isVideo && plan.segments > 1 && form.prompts?.some(Boolean)) fd.append('prompts', JSON.stringify(form.prompts.slice(0, plan.segments)));
      fd.set('shots', String(shots));
      if (shots) fd.set('keyframePreset', keyMode.id);
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
      if (isVideo && sound.source === 'file') {
        if (sound.file) fd.append('audio', sound.file);
        else fd.append('audioRef', sound.ref);
        fd.append('audioStart', String(sound.start));
        fd.append('audioFade', String(sound.fade));
      }
      if (isVideo && sound.source === 'video' && task.video) fd.append('audioSource', 'video');
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
    : isAudio ? (task.key === 'speech' ? t('{n} characters', { n: form.prompt.length }) : fmtDuration(form.duration))
    : isVideo
      ? [plan.duration >= 60 ? fmtDuration(plan.duration) : t('{s} s video', { s: plan.duration.toFixed(1) }), plan.segments > 1 ? t('from {n} parts', { n: plan.segments }) : null, `${form.outFps} fps`, `${form.width}×${form.height}`].filter(Boolean).join(' · ')
      : [form.count > 1 ? t('{n} images', { n: form.count }) : t('1 image'), `${form.width}×${form.height}`].join(' · ');
  // Why the button cannot be pressed yet, said next to it instead of a silently grey button
  const why = !preset ? null
    : !preset.available ? (user.role === 'admin' ? t('Download the models of this mode first') : t('Ask an administrator to download this mode'))
      : task.image && !image && !imageRef ? t('Add a photo')
        : task.mask && !maskBlob ? t('Paint the part to change')
          : task.video && !video && !videoRef ? t('Add a video')
            : !upscale && !form.prompt.trim() ? (task.key === 'speech' ? t('Enter the text to read') : t('Describe what to create'))
              : task.key === 'music' && form.lyricsMode === 'mine' && !form.lyrics.trim() ? t('Write the lyrics or choose who writes them') : null;
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
          {previewUrl && task.cutout ? (
            <>
              <CutoutEditor key={previewUrl} src={previewUrl} file={image} imageRef={imageRef} />
              <div className="photo-bar">
                <button type="button" className="btn btn-small" onClick={() => fileInput.current?.click()}>{t('Replace the photo')}</button>
              </div>
            </>
          ) : previewUrl && task.mask ? (
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
        <PromptField form={form} set={set} preset={preset} isVideo={isVideo} hasImage={!!(acceptsImage && (image || imageRef))} duration={plan.duration} task={task.key} user={user} audio={isAudio} />
      )}

      {isAudio && <AudioFields task={task.key} form={form} set={set} preset={preset} />}

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

      {task.key === 'upscale' && <div className="muted small">{t('The photo becomes 4 times larger. No other settings are needed.')}</div>}

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

      {isAudio && (<>
      <button type="button" className="more-toggle" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>{advanced ? '▾' : '▸'} {t('More settings')}</button>
      {advanced && (
        <div className="advanced">
          <label className="field">
            <span className="field-label">{t('Variation number')} <Info text={t('Random gives a new variant every time. The same number with the same settings gives the same result: handy for changing one detail and comparing.')} /></span>
            <div className="row">
              <input type="number" value={form.seed} placeholder={t('Random')} onChange={(e) => set('seed')(e.target.value === '' ? -1 : Number(e.target.value))} />
              <button type="button" className="btn" title={t('Random')} onClick={() => set('seed')(-1)}>🎲</button>
            </div>
          </label>
        </div>
      )}
      </>)}

      {!upscale && !isAudio && (<>
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
          render={(x) => {
            const e = etaWith({ width: x.w, height: x.h });
            return <>{`${x.w > x.h ? '▭' : x.w < x.h ? '▯' : '□'} ${x.w}×${x.h}${tested(x.w, x.h) ? ' ✓' : ''}`}{e && <span className="chip-sub">≈ {e}</span>}</>;
          }}
        />
        {offSize && <div className="note warn">⚠ {t('{w}×{h} is not a size this mode was tested at (✓). The result may not match the prompt.', { w: form.width, h: form.height })}</div>}
      </div>

      {isVideo ? (
        <>
        <label className="field">
          <span className="field-label field-label-row">
            <span>
              {t('Length')}{' '}
              <Info text={plan.extendable && plan.maxSegments > 1
                ? t('Up to {base} s in one model pass (the length the model was trained on). Longer videos, up to {max} s, are stitched from several parts (the striped zone).', { base: Number(plan.segSeconds.toFixed(2)), max: Number(plan.maxDuration.toFixed(2)) })
                : t('Up to {max} s per generation — the model limit.', { max: Number(plan.maxDuration.toFixed(2)) })} />
            </span>
            <b className={extraDuration ? 'extra-text' : ''}>{fmtLength(plan.duration)}</b>
          </span>
          <div className="range-wrap" style={{ '--base': `${((plan.segSeconds - 0.5) / (plan.maxDuration - 0.5 || 1)) * 100}%` }}>
            <input type="range" className={`${extraDuration ? 'extra' : ''} ${plan.extendable && plan.maxSegments > 1 ? 'has-extra' : ''}`}
              min={Math.max(0.5, Math.ceil((plan.minFrames / plan.fps) * 2) / 2)} max={plan.maxDuration} step={plan.maxDuration > 20 ? 1 : 0.5}
              value={Math.min(form.duration, plan.maxDuration)} onChange={(e) => set('duration')(Number(e.target.value))} />
          </div>
          {extraDuration && (
            <div className="note warn">⚠ {t('Stitched from {n} parts: time ×{n}, details may drift at the joins.', { n: plan.segments })}</div>
          )}
          {eta?.sec > 3600 && <div className="note warn">⚠ {t('About {time} of work: the GPU is busy all that time. Long videos are best left to run overnight.', { time: fmtDuration(eta.sec) })}</div>}
          {plan.beyondTraining && (
            <div className="note warn">⚠ {t('Passes of {frames} frames are longer than the model was trained on ({trained}): the video may lose the subject and turn into a texture. The prompt will suffer.', { frames: plan.frames, trained: plan.trainedFrames })}</div>
          )}
        </label>
        {plan.segments > 1 && <StoryboardField form={form} set={set} preset={preset} plan={plan} hasImage={!!(acceptsImage && (image || imageRef))} shots={shots} keyModes={keyModes} keyMode={keyMode} />}
        </>
      ) : (
        <div className="field">
          <span className="field-label">{t('Variations')} <Info text={t('Each variation is a separate picture; the time grows proportionally.')} /></span>
          <Chips items={COUNTS} value={form.count} onChange={set('count')} />
        </div>
      )}

      {isVideo && <SoundField sound={sound} setSound={setSound} duration={plan.duration} canUseVideo={!!task.video} />}

      <div className="field">
        <span className="field-label">{t('Quality')} <Info text={t('More model passes ({steps}) give a cleaner picture but take longer. Draft is good for trying an idea.', { steps })} /></span>
        <Chips items={QUALITY.filter((q) => qualitySteps(d, q.key) != null)} value={form.quality} onChange={set('quality')}
          render={(q) => {
            const e = etaWith({ quality: q.key });
            return <>{t(q.label)}{e && <span className="chip-sub">≈ {e}</span>}</>;
          }} />
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
              <Chips items={outFpsOptions(preset)} value={form.outFps} onChange={set('outFps')} render={(f) => (f === plan.fps ? `${f} fps · ${t('native')}` : `${f} fps`)} />
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
              <Num label={<>{t('Prompt strictness')} <Info text={t('How literally the model follows the prompt. Higher is more precise but adds overexposure and artifacts; lower is freer and softer. The default is tuned for the mode. At exactly 1 the model runs one pass instead of two: about twice as fast, but the negative prompt is not used.')} /></>}
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

      {!task.cutout && <div className="form-foot">
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
      </div>}
    </form>
  );
}
