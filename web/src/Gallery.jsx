import { useEffect, useState } from 'react';
import { clipSeconds, fileUrl, fmtDate, fmtDuration, jobKind, STATUS_LABEL } from './util.js';
import { t, tError } from './i18n.js';
import { LogView, ParamChips } from './Jobs.jsx';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'done', label: 'Done' },
  { key: 'bad', label: 'Failed and cancelled' },
];

// Failed and cancelled jobs can be put back into the queue as they were
export const canRetry = (job, canManage) => ['failed', 'cancelled'].includes(job.status) && canManage(job);

export function confirmDelete(job, onDelete) {
  if (confirm(t('Delete the generation together with its files?'))) onDelete(job);
}

const isVideoFile = (f) => /\.(mp4|webm)$/i.test(f);
const isImageFile = (f) => /\.(png|jpe?g|webp)$/i.test(f);

export function Modal({ job, onClose, onDelete, onReuse, onRetry, canManage }) {
  const [showLog, setShowLog] = useState(job.status === 'failed');
  const [idx, setIdx] = useState(0);
  const files = job.files || [];
  const file = files[idx];
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(files.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, files.length]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="btn-icon modal-x" onClick={onClose} title={t('Close')}>×</button>
        {file && isVideoFile(file) ? (
          <video key={file} src={fileUrl(file)} controls autoPlay loop playsInline />
        ) : file && isImageFile(file) ? (
          <img className="modal-img" key={file} src={fileUrl(file)} alt="" />
        ) : file ? (
          <div className="novideo">{t('The file {file} cannot be shown in the browser, but it can be downloaded.', { file })}</div>
        ) : (
          <div className="novideo">{t(STATUS_LABEL[job.status])}{job.error ? `: ${tError(job.error)}` : ''}</div>
        )}
        {files.length > 1 && (
          <div className="strip">
            {files.map((f, i) => (
              <button key={f} className={`strip-item ${i === idx ? 'on' : ''}`} onClick={() => setIdx(i)}>
                <img src={fileUrl(f)} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}
        <div className="modal-info">
          <div className="prompt">{job.params.prompt}</div>
          {job.params.negative && <div className="muted small">{t('Negative:')} {job.params.negative}</div>}
          <ParamChips p={job.params} user={job.user} />
          <div className="muted small">
            {fmtDate(job.createdAt)}
            {job.durationSec ? ` · ${t('generated in {time}', { time: fmtDuration(job.durationSec) })}` : ''}
          </div>
          {job.warning && <div className="warn small">{tError(job.warning)}</div>}
          <div className="modal-actions">
            {file && <a className="btn primary" href={`/api/jobs/${job.id}/download/${idx}`}>{t('Download')}{files.length > 1 ? ` (${idx + 1}/${files.length})` : ''}</a>}
            {canRetry(job, canManage) && (
              <button className="btn primary" onClick={() => { onRetry(job); onClose(); }}>{t('Restart')}</button>
            )}
            <button className="btn" onClick={() => { onReuse(job); onClose(); }}>{t('Repeat with these settings')}</button>
            {canManage(job) && (
              <button className="btn ghost danger" onClick={() => confirmDelete(job, (j) => { onDelete(j); onClose(); })}>{t('Delete')}</button>
            )}
          </div>
          <button className="link" onClick={() => setShowLog((v) => !v)}>{showLog ? '▾' : '▸'} {t('sd-cli log')}</button>
          {showLog && <LogView jobId={job.id} />}
        </div>
      </div>
    </div>
  );
}

// One result tile; used by the studio's recent results and by the gallery page
export function Tile({ job: j, onOpen, onDelete, onReuse, onRetry, canManage, showKind = false }) {
  const video = jobKind(j) === 'video';
  return (
    <div className={`tile ${j.status}`}>
      <button className={`thumb ${video ? '' : 'thumb-img'}`} onClick={() => onOpen(j)} title={t('Open')}>
        {j.thumb ? <img src={`/files/thumbs/${j.thumb}`} alt="" loading="lazy" /> : <div className="thumb-empty">{t(STATUS_LABEL[j.status])}</div>}
        {j.status === 'done' && video && <span className="play">▶</span>}
        <span className="badge">
          {showKind ? `${video ? t('Video') : t('Image')} · ` : ''}
          {j.params.width}×{j.params.height}
          {video
            ? ` · ${t('{s} s', { s: clipSeconds(j.params).toFixed(1) })} · ${j.params.outFps ?? j.params.fps} fps`
            : j.files?.length > 1 ? ` · ${t('{n} pcs', { n: j.files.length })}` : ''}
        </span>
        {j.status !== 'done' && <span className={`badge st ${j.status}`}>{t(STATUS_LABEL[j.status])}</span>}
      </button>
      <div className="tile-body">
        <div className="tile-prompt" title={j.params.prompt}>{j.params.prompt}</div>
        {j.status === 'failed' && j.error && <div className="tile-err" title={tError(j.error)}>{tError(j.error)}</div>}
        <div className="tile-meta">
          <span className="muted small">{fmtDate(j.createdAt)}{j.durationSec ? ` · ${fmtDuration(j.durationSec)}` : ''}</span>
          <span className="tile-actions">
            {j.files?.length > 0 && <a className="btn-icon" href={`/api/jobs/${j.id}/download/0`} title={t('Download')}>⤓</a>}
            {canRetry(j, canManage) && (
              <button className="btn-icon" title={t('Restart: the same job again, with the same seed')} onClick={() => onRetry(j)}>⟲</button>
            )}
            <button className="btn-icon" title={t('Repeat')} onClick={() => onReuse(j)}>↻</button>
            {canManage(j) && <button className="btn-icon danger" title={t('Delete')} onClick={() => confirmDelete(j, onDelete)}>🗑</button>}
          </span>
        </div>
      </div>
    </div>
  );
}

// Recent results of one content kind in the studio; the full history lives on the gallery page
const RECENT = 12;

export default function Gallery({ kind, jobs, onDelete, onReuse, onRetry, canManage, onOpenAll }) {
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState(null);
  const filtered = jobs.filter((j) => (filter === 'all' ? true : filter === 'done' ? j.status === 'done' : j.status !== 'done'));
  const shown = filtered.slice(0, RECENT);
  const open = jobs.find((j) => j.id === openId);
  const video = kind === 'video';

  return (
    <div className="card">
      <div className="gal-head">
        <h3>{t('Results')} · {jobs.filter((j) => j.status === 'done').length}</h3>
        <div className="tabs">
          {FILTERS.map((f) => (
            <button key={f.key} className={`tab ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>{t(f.label)}</button>
          ))}
        </div>
      </div>
      {!shown.length ? (
        <div className="muted empty">{video ? t('Finished videos will appear here.') : t('Finished images will appear here.')}</div>
      ) : (
        <div className={`grid ${video ? '' : 'grid-img'}`}>
          {shown.map((j) => (
            <Tile key={j.id} job={j} onOpen={(x) => setOpenId(x.id)} onDelete={onDelete} onReuse={onReuse} onRetry={onRetry} canManage={canManage} />
          ))}
        </div>
      )}
      {onOpenAll && filtered.length > 0 && (
        <div className="gal-more">
          <button className="link" onClick={onOpenAll}>
            {filtered.length > RECENT ? t('All {n} in the gallery →', { n: filtered.length }) : t('Open the gallery →')}
          </button>
        </div>
      )}
      {open && <Modal job={open} onClose={() => setOpenId(null)} onDelete={onDelete} onReuse={onReuse} onRetry={onRetry} canManage={canManage} />}
    </div>
  );
}
