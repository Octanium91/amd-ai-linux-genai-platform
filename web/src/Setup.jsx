import { useEffect, useMemo, useState } from 'react';
import { api, fmtBytes } from './util.js';

// Первичная настройка: пока ни один режим не готов, администратор выбирает, какие наборы моделей скачать.
// Обязательные наборы отмечены серой неснимаемой галочкой; прогресс загрузки дальше показывает обычный интерфейс.
export default function Setup({ user, info, onStarted, onSkip }) {
  const { packs, disk, family } = info;
  const [picked, setPicked] = useState(() => new Set(packs.filter((p) => p.required || p.recommended).map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Набор тянет за собой зависимости (например, видео AnimateLCM требует основу SD 1.5)
  const effective = useMemo(() => {
    const out = new Set(picked);
    for (const p of packs) if (p.required) out.add(p.id);
    for (const id of [...out]) for (const dep of packs.find((p) => p.id === id)?.requires || []) out.add(dep);
    return out;
  }, [picked, packs]);

  // Модели считаем один раз, даже если они входят в несколько наборов (UMT5 у обеих Wan)
  const toDownload = useMemo(() => {
    const m = new Map();
    for (const p of packs) if (effective.has(p.id)) for (const x of p.models) if (x.status !== 'installed') m.set(x.id, x);
    return [...m.values()];
  }, [effective, packs]);
  const total = toDownload.reduce((s, m) => s + m.size, 0);
  const tooBig = disk?.free != null && total > disk.free;

  useEffect(() => setError(''), [picked]);

  if (user.role !== 'admin') {
    return (
      <main className="page setup">
        <div className="card">
          <h2>Платформа ещё не готова</h2>
          <p className="muted">Модели для генерации пока не скачаны. Попросите администратора открыть платформу и выбрать, что скачать.</p>
        </div>
      </main>
    );
  }

  const toggle = (p) => {
    if (p.required || p.installed) return;
    setPicked((s) => {
      const n = new Set(s);
      n.has(p.id) ? n.delete(p.id) : n.add(p.id);
      return n;
    });
  };

  const start = async () => {
    setBusy(true);
    try {
      await api('/api/models/download', { method: 'POST', json: { ids: toDownload.map((m) => m.id) } });
      onStarted();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page setup">
      <div className="card">
        <h2>Первичная настройка: какие модели скачать</h2>
        <p className="muted">
          Модели не входят в образ — платформа скачает их с Hugging Face и подготовит для stable-diffusion.cpp.
          Выберите, что нужно; добавить или удалить модели можно позже в разделе «Модели».
          {family && <> Железо: <b>{family}</b> — рекомендации отмечены с учётом этого.</>}
        </p>
      </div>

      <div className="packs">
        {packs.map((p) => {
          const on = p.installed || effective.has(p.id);
          const locked = p.required || p.installed || (!picked.has(p.id) && effective.has(p.id));
          return (
            <label key={p.id} className={`pack ${on ? 'on' : ''} ${locked ? 'locked' : ''}`}>
              <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(p)} />
              <div className="pack-body">
                <div className="pack-head">
                  <span className="pack-name">{p.name}</span>
                  {p.required && <span className="pill">нужно в любом случае</span>}
                  {!p.required && locked && !p.installed && <span className="pill">нужно для выбранного</span>}
                  {p.recommended && !p.required && <span className="pill installed">рекомендуется</span>}
                  {p.experimental && <span className="pill error">экспериментально</span>}
                  {p.installed && <span className="pill installed">уже скачано</span>}
                  <span className="pack-size">{p.installed ? '' : fmtBytes(p.remaining)}</span>
                </div>
                <div className="muted small">{p.description}</div>
                <div className="pack-models muted small">
                  {p.models.map((m) => (
                    <span key={m.id} className={m.status === 'installed' ? 'done' : ''}>
                      {m.status === 'installed' ? '✓ ' : ''}{m.name} · {fmtBytes(m.size)}
                    </span>
                  ))}
                </div>
                {p.presetNames?.length > 0 && <div className="muted small">Даёт режимы: {p.presetNames.join(', ')}</div>}
              </div>
            </label>
          );
        })}
      </div>

      <div className="card setup-foot">
        <div>
          <div><b>К загрузке: {fmtBytes(total)}</b> ({toDownload.length} файлов)</div>
          <div className={`small ${tooBig ? 'extra-text' : 'muted'}`}>
            {disk?.free != null && `Свободно на диске с моделями: ${fmtBytes(disk.free)}`}
            {tooBig && ' — не хватает места'}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
        <div className="row">
          <button className="btn ghost" onClick={onSkip}>Позже</button>
          <button className="btn primary" disabled={busy || !toDownload.length || tooBig} onClick={start}>
            {busy ? 'Запуск…' : `Скачать выбранное (${fmtBytes(total)})`}
          </button>
        </div>
      </div>
    </main>
  );
}
