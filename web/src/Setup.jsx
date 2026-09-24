import { useEffect, useMemo, useState } from 'react';
import { api, fmtBytes } from './util.js';
import { loc, t } from './i18n.js';

// First-run setup: while no mode is usable, an administrator picks which model packs to download.
// Required packs have a grey checkbox that cannot be cleared; download progress continues in the regular UI.
export default function Setup({ user, info, onStarted, onSkip }) {
  const { packs, disk, family } = info;
  const [picked, setPicked] = useState(() => new Set(packs.filter((p) => p.required || p.recommended).map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // A pack pulls in its dependencies (e.g. AnimateLCM video needs the SD 1.5 base)
  const effective = useMemo(() => {
    const out = new Set(picked);
    for (const p of packs) if (p.required) out.add(p.id);
    for (const id of [...out]) for (const dep of packs.find((p) => p.id === id)?.requires || []) out.add(dep);
    return out;
  }, [picked, packs]);

  // Count each model once even if it belongs to several packs (UMT5 is shared by both Wan packs)
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
          <h2>{t('The platform is not ready yet')}</h2>
          <p className="muted">{t('No generation models have been downloaded yet. Ask an administrator to open the platform and choose what to download.')}</p>
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
        <h2>{t('First-run setup: which models to download')}</h2>
        <p className="muted">
          {t('Models are not part of the image — the platform downloads them from Hugging Face and prepares them for stable-diffusion.cpp. Pick what you need; models can be added or removed later in the Models section.')}
          {family && <> {t('Hardware:')} <b>{family}</b> — {t('recommendations take it into account.')}</>}
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
                  <span className="pack-name">{loc(p, 'name')}</span>
                  {p.required && <span className="pill">{t('always required')}</span>}
                  {!p.required && locked && !p.installed && <span className="pill">{t('needed for the selection')}</span>}
                  {p.recommended && !p.required && <span className="pill installed">{t('recommended')}</span>}
                  {p.experimental && <span className="pill error">{t('experimental')}</span>}
                  {p.installed && <span className="pill installed">{t('already downloaded')}</span>}
                  <span className="pack-size">{p.installed ? '' : fmtBytes(p.remaining)}</span>
                </div>
                <div className="muted small">{loc(p, 'description')}</div>
                <div className="pack-models muted small">
                  {p.models.map((m) => (
                    <span key={m.id} className={m.status === 'installed' ? 'done' : ''}>
                      {m.status === 'installed' ? '✓ ' : ''}{m.name} · {fmtBytes(m.size)}
                    </span>
                  ))}
                </div>
                {p.presetInfo?.length > 0 && <div className="muted small">{t('Enables modes:')} {p.presetInfo.map((x) => loc(x, 'name')).join(', ')}</div>}
              </div>
            </label>
          );
        })}
      </div>

      <div className="card setup-foot">
        <div>
          <div><b>{t('To download: {size}', { size: fmtBytes(total) })}</b> ({t('{n} files', { n: toDownload.length })})</div>
          <div className={`small ${tooBig ? 'extra-text' : 'muted'}`}>
            {disk?.free != null && t('Free on the models disk: {size}', { size: fmtBytes(disk.free) })}
            {tooBig && ` — ${t('not enough space')}`}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
        <div className="row">
          <button className="btn ghost" onClick={onSkip}>{t('Later')}</button>
          <button className="btn primary" disabled={busy || !toDownload.length || tooBig} onClick={start}>
            {busy ? t('Starting…') : t('Download selected ({size})', { size: fmtBytes(total) })}
          </button>
        </div>
      </div>
    </main>
  );
}
