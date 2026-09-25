import { useEffect, useMemo, useState } from 'react';
import { jobKind } from './util.js';
import { t } from './i18n.js';
import { Modal, Tile } from './Gallery.jsx';

// Everything generated so far, videos and images together, with filters and search.
// Actions are the same as in the studio; "repeat" opens the matching studio with the form filled in.
const KINDS = [
  { key: 'all', label: 'All' },
  { key: 'video', label: 'Videos' },
  { key: 'image', label: 'Images' },
];
const STATUSES = [
  { key: 'done', label: 'Done' },
  { key: 'bad', label: 'Failed and cancelled' },
  { key: 'all', label: 'All' },
];
const PAGE = 48;

export default function GalleryPage({ user, jobs, onDelete, onReuse, onRetry, canManage }) {
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('done');
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState(null);

  const finished = useMemo(() => jobs
    .filter((j) => ['done', 'failed', 'cancelled'].includes(j.status))
    .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt)), [jobs]);
  const severalUsers = new Set(finished.map((j) => j.user)).size > 1;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = finished.filter((j) => (kind === 'all' || jobKind(j) === kind)
    && (status === 'all' || (status === 'done' ? j.status === 'done' : j.status !== 'done'))
    && (!mine || j.user === user.username)
    && words.every((w) => `${j.params.prompt} ${j.params.presetName || ''}`.toLowerCase().includes(w)));
  // A new filter starts from the first page again
  useEffect(() => setLimit(PAGE), [kind, status, mine, query]);
  const open = jobs.find((j) => j.id === openId);
  const count = (k) => finished.filter((j) => j.status === 'done' && (k === 'all' || jobKind(j) === k)).length;

  return (
    <main className="gallery-page">
      <div className="card">
        <div className="gal-head">
          <h3>{t('Gallery')} · {count('all')}</h3>
          <input
            className="gal-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search by prompt')}
          />
        </div>
        <div className="gal-filters">
          <div className="tabs">
            {KINDS.map((f) => (
              <button key={f.key} className={`tab ${kind === f.key ? 'on' : ''}`} onClick={() => setKind(f.key)}>
                {t(f.label)} <span className="muted">{count(f.key)}</span>
              </button>
            ))}
          </div>
          <div className="tabs">
            {STATUSES.map((f) => (
              <button key={f.key} className={`tab ${status === f.key ? 'on' : ''}`} onClick={() => setStatus(f.key)}>{t(f.label)}</button>
            ))}
          </div>
          {severalUsers && (
            <div className="tabs">
              <button className={`tab ${!mine ? 'on' : ''}`} onClick={() => setMine(false)}>{t('Everyone')}</button>
              <button className={`tab ${mine ? 'on' : ''}`} onClick={() => setMine(true)}>{t('Mine')}</button>
            </div>
          )}
        </div>
        {!shown.length ? (
          <div className="muted empty">{finished.length ? t('Nothing matches the filters.') : t('Nothing has been generated yet.')}</div>
        ) : (
          <div className="grid grid-all">
            {shown.slice(0, limit).map((j) => (
              <Tile key={j.id} job={j} showKind={kind === 'all'} onOpen={(x) => setOpenId(x.id)}
                onDelete={onDelete} onReuse={onReuse} onRetry={onRetry} canManage={canManage} />
            ))}
          </div>
        )}
        {shown.length > limit && (
          <div className="gal-more">
            <button className="btn" onClick={() => setLimit((n) => n + PAGE)}>
              {t('Show more ({n} left)', { n: shown.length - limit })}
            </button>
          </div>
        )}
      </div>
      {open && <Modal job={open} onClose={() => setOpenId(null)} onDelete={onDelete} onReuse={onReuse} onRetry={onRetry} canManage={canManage} />}
    </main>
  );
}
