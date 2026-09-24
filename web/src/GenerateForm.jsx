import { useEffect, useMemo, useRef, useState } from 'react';
import { api, estimate, fmtBytes, fmtDuration } from './util.js';

const FALLBACK_RES = [[512, 512], [768, 512], [512, 768]];
const OUT_FPS = [24, 30, 50, 60, 120];
const COUNTS = [1, 2, 4];
const QUALITY = [
  { key: 'draft', label: 'Черновик' },
  { key: 'normal', label: 'Стандарт' },
  { key: 'high', label: 'Высокое' },
  { key: 'extra', label: 'Экстра', extra: true },
];

// «Экстра» — вдвое больше шагов, чем «Высокое» (как на сервере)
const qualitySteps = (d, q) => (q === 'extra' ? d.quality?.extra ?? (d.quality?.high ? d.quality.high * 2 : null) : d.quality?.[q]);
const SAMPLERS = ['euler', 'euler_a', 'dpm++2m', 'dpm++2m_sde', 'res_multistep', 'lcm', 'ddim_trailing', 'tcd'];

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

// Та же формула, что на сервере: Wan — 4n+1 кадров, AnimateDiff — ровно duration × fps.
// Длиннее предела модели (экстра) — два сегмента, второй продолжает последний кадр первого.
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

// Режим без скачанных моделей: список недостающего и кнопка загрузки (только admin)
function MissingModels({ preset, user, goModels, reloadPresets }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const total = preset.missing.reduce((s, m) => s + (m.size || 0), 0);
  const start = async () => {
    setBusy(true);
    try {
      await api('/api/models/download', { method: 'POST', json: { ids: preset.missing.map((m) => m.id) } });
      setMsg('Загрузка поставлена в очередь — прогресс в разделе «Модели».');
      reloadPresets();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="missing">
      <div className="missing-title">Для этого режима нужно скачать модели ({fmtBytes(total)}):</div>
      <ul>{preset.missing.map((m) => <li key={m.id}>{m.name} <span className="muted">· {fmtBytes(m.size)}</span></li>)}</ul>
      {user.role === 'admin' ? (
        <div className="row">
          <button type="button" className="btn primary" disabled={busy} onClick={start}>Скачать ({fmtBytes(total)})</button>
          <button type="button" className="btn ghost" onClick={goModels}>Модели →</button>
        </div>
      ) : (
        <div className="muted small">Попросите администратора скачать модели.</div>
      )}
      {msg && <div className="muted small">{msg}</div>}
    </div>
  );
}

export default function GenerateForm({ kind, user, presets, jobs, reuse, queueSize, onCreated, reloadPresets, goModels }) {
  const [form, setForm] = useState(null);
  const [image, setImage] = useState(null); // File
  const [imageRef, setImageRef] = useState(null); // имя уже загруженного файла
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const fileInput = useRef(null);
  const isVideo = kind === 'video';

  const preset = presets.find((p) => p.id === form?.presetId);

  useEffect(() => {
    if (!form && presets.length) setForm(fromPreset(presets.find((p) => p.available) || presets[0]));
  }, [presets, form]);

  useEffect(() => {
    if (!reuse || (reuse.kind || 'video') !== kind) return;
    const { _t, image: img, presetName, frames, steps, fps, kind: _k, ...params } = reuse;
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

  if (!presets.length) return <div className="card"><div className="muted">Нет режимов этого типа.</div></div>;
  if (!form) return <div className="card"><div className="muted">Загрузка…</div></div>;

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

  return (
    <form className="card form" onSubmit={submit}>
      <h2>{isVideo ? 'Новое видео' : 'Новое изображение'}</h2>

      <label className="field">
        <span className="field-label">Режим</span>
        <select value={form.presetId} onChange={(e) => pickPreset(e.target.value)}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.available ? '' : ' — нужно скачать модели'}
            </option>
          ))}
        </select>
        {preset?.description && <span className="field-hint">{preset.description}</span>}
      </label>

      {preset && !preset.available && (
        <MissingModels preset={preset} user={user} goModels={goModels} reloadPresets={reloadPresets} />
      )}

      <label className="field">
        <span className="field-label">Что сгенерировать</span>
        <textarea rows={5} value={form.prompt} required
          placeholder={isVideo ? 'a red fox running through fresh snow, cinematic lighting, slow motion' : 'portrait photo of an old fisherman, golden hour, 85mm, detailed skin'}
          onChange={(e) => set('prompt')(e.target.value)}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.currentTarget.form.requestSubmit()} />
        <span className="field-hint">Лучше на английском. Ctrl+Enter — отправить.</span>
      </label>

      {acceptsImage && (
        <div className="field">
          <span className="field-label">
            {isVideo ? 'Стартовый кадр' : 'Исходная картинка'}{' '}
            <span className="muted">{preset.image === 'required' ? '(обязательно)' : isVideo ? '(необязательно: картинка → видео)' : '(необязательно: картинка → картинка)'}</span>
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
                <button type="button" className="btn-icon drop-clear" title="Убрать"
                  onClick={(e) => { e.stopPropagation(); setImage(null); setImageRef(null); }}>×</button>
              </>
            ) : (
              <span className="muted">Перетащите картинку или нажмите</span>
            )}
          </div>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files[0])} />
        </div>
      )}

      <div className="field">
        <span className="field-label">Разрешение</span>
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
              <span>Длительность {extraDuration && <span className="extra-badge">экстра</span>}</span>
              <b className={extraDuration ? 'extra-text' : ''}>{Number(form.duration).toFixed(1)} с</b>
            </span>
            <div className="range-wrap" style={{ '--base': `${((plan.baseDuration - 0.5) / (plan.maxDuration - 0.5 || 1)) * 100}%` }}>
              <input type="range" className={`${extraDuration ? 'extra' : ''} ${plan.extendable ? 'has-extra' : ''}`}
                min={Math.max(0.5, Math.ceil(((d.minFrames ?? 5) / plan.nativeFps) * 2) / 2)} max={plan.maxDuration} step={0.5}
                value={Math.min(form.duration, plan.maxDuration)} onChange={(e) => set('duration')(Number(e.target.value))} />
            </div>
            <span className={`field-hint ${extraDuration ? 'extra-text' : ''}`}>
              {extraDuration
                ? `Экстра: длиннее предела модели (${plan.baseDuration} с). Видео собирается из 2 сегментов — второй продолжает последний кадр первого. Время ×2, на стыке возможен скачок движения.`
                : plan.extendable
                  ? `До ${plan.baseDuration} с — за один проход модели. Дальше, до ${plan.maxDuration} с, — экстра-зона (красная).`
                  : `До ${plan.maxDuration} с за одну генерацию — предел модели.`}
            </span>
          </label>
          <div className="field">
            <span className="field-label">Кадров в секунду (FPS)</span>
            <Chips items={OUT_FPS} value={form.outFps} onChange={set('outFps')} />
            <span className="field-hint">
              {interpolated
                ? `Модель рисует ${plan.nativeFps} к/с, до ${form.outFps} к/с кадры досчитываются интерполяцией: движение плавнее, деталей не прибавится. Почти не влияет на время.`
                : 'Родная частота модели, без интерполяции.'}
            </span>
          </div>
        </>
      ) : (
        <div className="field">
          <span className="field-label">Количество вариантов</span>
          <Chips items={COUNTS} value={form.count} onChange={set('count')} />
          <span className="field-hint">Каждый вариант — отдельная генерация с новым seed; время растёт пропорционально.</span>
        </div>
      )}

      <div className="field">
        <span className="field-label">Качество</span>
        <Chips items={QUALITY} value={form.quality} onChange={set('quality')} render={(q) => q.label} />
        <span className={`field-hint ${form.quality === 'extra' ? 'extra-text' : ''}`}>
          {form.quality === 'extra'
            ? `Экстра: ${steps} проходов — вдвое больше «Высокого». Время ×2; прирост качества уже небольшой.`
            : `Больше проходов модели (${steps}) — чище картинка, но дольше. Черновик подходит, чтобы проверить идею.`}
        </span>
      </div>

      <button type="button" className="link" onClick={() => setAdvanced((a) => !a)}>{advanced ? '▾' : '▸'} Дополнительно</button>
      {advanced && (
        <div className="advanced">
          <label className="field">
            <span className="field-label">Чего избегать (негативный промпт)</span>
            <textarea rows={2} value={form.negative} onChange={(e) => set('negative')(e.target.value)} />
            {form.cfg <= 1 && <span className="field-hint">При CFG 1 негативный промпт не используется.</span>}
          </label>
          <Num label="Строгость следования описанию (CFG)" value={form.cfg} onChange={set('cfg')} step={0.5} min={0} max={30}
            hint="Насколько буквально модель выполняет описание. Выше — точнее, но появляются пересвет и артефакты; ниже — свободнее и мягче. Значение по умолчанию подобрано под режим." />
          <label className="field">
            <span className="field-label">Зерно случайности (Seed)</span>
            <div className="row">
              <input type="number" value={form.seed} onChange={(e) => set('seed')(e.target.value === '' ? -1 : Number(e.target.value))} />
              <button type="button" className="btn-icon" title="Случайное (-1)" onClick={() => set('seed')(-1)}>⚄</button>
            </div>
            <span className="field-hint">−1 — каждый раз новый вариант. Тот же seed с теми же настройками даёт тот же результат: удобно, чтобы менять одну деталь и сравнивать.</span>
          </label>
          <div className="grid2">
            <Num label="Ширина" value={form.width} onChange={set('width')} step={16} min={128} max={2048} />
            <Num label="Высота" value={form.height} onChange={set('height')} step={16} min={128} max={2048} />
          </div>
          {d.flowShift != null && (
            <Num label="Flow shift" value={form.flowShift} onChange={set('flowShift')} step={0.5} min={0} max={30}
              hint="Тонкая настройка расписания шумов Wan. Обычно 3; для 720p можно 5." />
          )}
          <label className="field">
            <span className="field-label">Сэмплер</span>
            <select value={form.sampler} onChange={(e) => set('sampler')(e.target.value)}>
              {SAMPLERS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="submit-row">
        <button className="btn primary" disabled={busy || !preset?.available || !form.prompt.trim()}>
          {busy ? 'Отправка…' : queueSize ? `В очередь (${queueSize} перед вами)` : 'Сгенерировать'}
        </button>
        <span className="muted small">
          {isVideo
            ? `${plan.segments > 1 ? `2 сегмента × ${plan.frames}` : plan.frames} кадр. при ${plan.nativeFps} к/с${interpolated ? ` → ${form.outFps} к/с` : ''} · ${form.width}×${form.height}`
            : `${form.count} × ${form.width}×${form.height}`}
          <br />
          {eta ? `≈ ${fmtDuration(eta)} по прошлой генерации` : 'оценка времени появится после первой генерации'}
        </span>
      </div>
    </form>
  );
}
