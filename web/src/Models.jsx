import { useCallback, useEffect, useState } from 'react';
import { api, fmtBytes, fmtDuration } from './util.js';

const CATEGORY = {
  checkpoint: 'Базовые модели',
  diffusion: 'Диффузионные модели',
  motion: 'Модули движения',
  lora: 'LoRA',
  vae: 'VAE',
  text_encoder: 'Текстовые энкодеры',
};
const STATUS = {
  installed: 'Установлена',
  missing: 'Не скачана',
  queued: 'В очереди',
  downloading: 'Загрузка',
  processing: 'Конвертация',
  error: 'Ошибка',
};

function ModelRow({ m, admin, act }) {
  const pct = m.total ? (m.received / m.total) * 100 : 0;
  const eta = m.rate > 0 ? (m.total - m.received) / m.rate : null;
  const busy = ['queued', 'downloading', 'processing'].includes(m.status);
  return (
    <div className={`model ${m.status}`}>
      <div className="model-main">
        <div className="model-name">
          {m.name} <span className={`pill ${m.status}`}>{STATUS[m.status] || m.status}</span>
          {m.inUse && <span className="pill running">используется</span>}
        </div>
        {m.description && <div className="muted small">{m.description}</div>}
        <div className="model-meta muted small">
          <span>{fmtBytes(m.installedSize || m.size)}</span>
          <span>лицензия: {m.license || '—'}</span>
          {m.homepage && <a href={m.homepage} target="_blank" rel="noreferrer">источник ↗</a>}
          {m.usedBy?.length > 0 && <span>нужна для: {m.usedBy.join(', ')}</span>}
        </div>
        {busy && (
          <div className="model-progress">
            <div className={`bar ${m.status !== 'downloading' ? 'ind' : ''}`}><div style={{ width: m.status === 'downloading' ? pct + '%' : undefined }} /></div>
            <span className="muted small">
              {m.status === 'downloading'
                ? `${fmtBytes(m.received)} / ${fmtBytes(m.total)} · ${fmtBytes(m.rate)}/с${eta ? ` · осталось ${fmtDuration(eta)}` : ''}`
                : m.status === 'processing' ? 'конвертация в формат stable-diffusion.cpp…' : 'ждёт своей очереди'}
            </span>
          </div>
        )}
        {m.status === 'error' && <div className="tile-err">{m.error}</div>}
        {m.status === 'missing' && m.partial > 0 && <div className="muted small">Докачано {fmtBytes(m.partial)} — загрузка продолжится с этого места.</div>}
      </div>
      {admin && (
        <div className="model-actions">
          {(m.status === 'missing' || m.status === 'error') && (
            <button className="btn primary" onClick={() => act(() => api('/api/models/download', { method: 'POST', json: { ids: [m.id] } }))}>Скачать</button>
          )}
          {busy && <button className="btn ghost" onClick={() => act(() => api(`/api/models/${m.id}/cancel`, { method: 'POST' }))}>Отменить</button>}
          {m.status === 'installed' && (
            <button className="btn ghost danger" disabled={m.inUse}
              onClick={() => confirm(`Удалить ${m.name} (${fmtBytes(m.installedSize)})? Режимы, которым она нужна, станут недоступны до повторной загрузки.`)
                && act(() => api(`/api/models/${m.id}`, { method: 'DELETE' }))}>Удалить</button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Models({ user, onChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const admin = user.role === 'admin';

  const load = useCallback(() => api('/api/models').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      alert(e.message);
    }
    load();
    onChange();
  };

  if (!data) return <main className="page"><div className="card muted">{error || 'Загрузка…'}</div></main>;

  const installed = data.models.filter((m) => m.status === 'installed');
  const used = installed.reduce((s, m) => s + (m.installedSize || 0), 0);
  const groups = Object.keys(CATEGORY).map((c) => [c, data.models.filter((m) => m.category === c)]).filter(([, l]) => l.length);
  const other = data.models.filter((m) => !CATEGORY[m.category]);
  if (other.length) groups.push(['other', other]);

  return (
    <main className="page">
      <div className="card">
        <div className="gal-head">
          <h2>Модели</h2>
          <div className="muted small">
            Установлено {installed.length} из {data.models.length} · {fmtBytes(used)}
            {data.disk?.free != null && ` · свободно на диске ${fmtBytes(data.disk.free)} из ${fmtBytes(data.disk.total)}`}
          </div>
        </div>
        <p className="muted small">
          Платформа сама скачивает модели из каталога (с продолжением после обрыва) и готовит их для stable-diffusion.cpp.
          {admin ? ' Скачивать и удалять может администратор.' : ' Скачивать и удалять модели может только администратор.'}
          {' '}Каталог — <code>catalog/models.json</code>, свои модели можно добавить в <code>data/state/models.local.json</code>.
        </p>
      </div>
      {groups.map(([c, list]) => (
        <div className="card" key={c}>
          <h3>{CATEGORY[c] || 'Прочее'}</h3>
          <div className="models">{list.map((m) => <ModelRow key={m.id} m={m} admin={admin} act={act} />)}</div>
        </div>
      ))}
    </main>
  );
}
