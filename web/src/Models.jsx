import { useCallback, useEffect, useState } from 'react';
import { api, fmtBytes, fmtDuration } from './util.js';
import { loc, t, tError } from './i18n.js';

const CATEGORY = {
  checkpoint: 'Base models',
  diffusion: 'Diffusion models',
  motion: 'Motion modules',
  lora: 'LoRA',
  vae: 'VAE',
  text_encoder: 'Text encoders',
};
const STATUS = {
  installed: 'Installed',
  missing: 'Not downloaded',
  queued: 'Queued',
  downloading: 'Downloading',
  processing: 'Converting',
  error: 'Error',
};

function ModelRow({ m, admin, act }) {
  const pct = m.total ? (m.received / m.total) * 100 : 0;
  const eta = m.rate > 0 ? (m.total - m.received) / m.rate : null;
  const busy = ['queued', 'downloading', 'processing'].includes(m.status);
  return (
    <div className={`model ${m.status}`}>
      <div className="model-main">
        <div className="model-name">
          {m.name} <span className={`pill ${m.status}`}>{STATUS[m.status] ? t(STATUS[m.status]) : m.status}</span>
          {m.inUse && <span className="pill running">{t('in use')}</span>}
        </div>
        {m.description && <div className="muted small">{loc(m, 'description')}</div>}
        <div className="model-meta muted small">
          <span>{fmtBytes(m.installedSize || m.size)}</span>
          <span>{t('license: {license}', { license: m.license || '—' })}</span>
          {m.homepage && <a href={m.homepage} target="_blank" rel="noreferrer">{t('source ↗')}</a>}
          {m.usedBy?.length > 0 && <span>{t('needed for: {modes}', { modes: m.usedBy.join(', ') })}</span>}
        </div>
        {busy && (
          <div className="model-progress">
            <div className={`bar ${m.status !== 'downloading' ? 'ind' : ''}`}><div style={{ width: m.status === 'downloading' ? pct + '%' : undefined }} /></div>
            <span className="muted small">
              {m.status === 'downloading'
                ? `${fmtBytes(m.received)} / ${fmtBytes(m.total)} · ${t('{size}/s', { size: fmtBytes(m.rate) })}${eta ? ` · ${t('{time} left', { time: fmtDuration(eta) })}` : ''}`
                : m.status === 'processing' ? t('converting into the stable-diffusion.cpp format…') : t('waiting in the queue')}
            </span>
          </div>
        )}
        {m.status === 'error' && <div className="tile-err">{tError(m.error)}</div>}
        {m.status === 'missing' && m.partial > 0 && (
          <div className="muted small">{t('{size} already downloaded — the download will resume from here.', { size: fmtBytes(m.partial) })}</div>
        )}
      </div>
      {admin && (
        <div className="model-actions">
          {(m.status === 'missing' || m.status === 'error') && (
            <button className="btn primary" onClick={() => act(() => api('/api/models/download', { method: 'POST', json: { ids: [m.id] } }))}>{t('Download')}</button>
          )}
          {busy && <button className="btn ghost" onClick={() => act(() => api(`/api/models/${m.id}/cancel`, { method: 'POST' }))}>{t('Cancel')}</button>}
          {m.status === 'installed' && (
            <button className="btn ghost danger" disabled={m.inUse}
              onClick={() => confirm(t('Delete {name} ({size})? Modes that need it become unavailable until it is downloaded again.', { name: m.name, size: fmtBytes(m.installedSize) }))
                && act(() => api(`/api/models/${m.id}`, { method: 'DELETE' }))}>{t('Delete')}</button>
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
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
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

  if (!data) return <main className="page"><div className="card muted">{error || t('Loading…')}</div></main>;

  const installed = data.models.filter((m) => m.status === 'installed');
  const used = installed.reduce((s, m) => s + (m.installedSize || 0), 0);
  const groups = Object.keys(CATEGORY).map((c) => [c, data.models.filter((m) => m.category === c)]).filter(([, l]) => l.length);
  const other = data.models.filter((m) => !CATEGORY[m.category]);
  if (other.length) groups.push(['other', other]);

  return (
    <main className="page">
      <div className="card">
        <div className="gal-head">
          <h2>{t('Models')}</h2>
          <div className="muted small">
            {t('{n} of {total} installed · {size}', { n: installed.length, total: data.models.length, size: fmtBytes(used) })}
            {data.disk?.free != null && ` · ${t('{free} free of {total} on disk', { free: fmtBytes(data.disk.free), total: fmtBytes(data.disk.total) })}`}
          </div>
        </div>
        <p className="muted small">
          {t('The platform downloads models from the catalog by itself (resuming after interruptions) and prepares them for stable-diffusion.cpp.')}{' '}
          {admin ? t('Administrators can download and delete models.') : t('Only administrators can download and delete models.')}{' '}
          {t('The catalog is catalog/models.json; your own models can be added in data/state/models.local.json.')}
        </p>
      </div>
      {groups.map(([c, list]) => (
        <div className="card" key={c}>
          <h3>{CATEGORY[c] ? t(CATEGORY[c]) : t('Other')}</h3>
          <div className="models">{list.map((m) => <ModelRow key={m.id} m={m} admin={admin} act={act} />)}</div>
        </div>
      ))}
    </main>
  );
}
