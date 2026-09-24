import { useEffect, useState } from 'react';
import { clipSeconds, fileUrl, fmtDate, fmtDuration, STATUS_LABEL } from './util.js';
import { LogView, ParamChips } from './Jobs.jsx';

const FILTERS = [
  { key: 'all', label: 'Все' },
  { key: 'done', label: 'Готовые' },
  { key: 'bad', label: 'Ошибки и отмены' },
];

function confirmDelete(job, onDelete) {
  if (confirm('Удалить генерацию вместе с файлами?')) onDelete(job);
}

const isVideoFile = (f) => /\.(mp4|webm)$/i.test(f);
const isImageFile = (f) => /\.(png|jpe?g|webp)$/i.test(f);

function Modal({ job, onClose, onDelete, onReuse, canManage }) {
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
        <button className="btn-icon modal-x" onClick={onClose} title="Закрыть">×</button>
        {file && isVideoFile(file) ? (
          <video key={file} src={fileUrl(file)} controls autoPlay loop playsInline />
        ) : file && isImageFile(file) ? (
          <img className="modal-img" key={file} src={fileUrl(file)} alt="" />
        ) : file ? (
          <div className="novideo">Файл {file} не отображается в браузере, его можно скачать.</div>
        ) : (
          <div className="novideo">{STATUS_LABEL[job.status]}{job.error ? `: ${job.error}` : ''}</div>
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
          {job.params.negative && <div className="muted small">Негативный: {job.params.negative}</div>}
          <ParamChips p={job.params} user={job.user} />
          <div className="muted small">
            {fmtDate(job.createdAt)}
            {job.durationSec ? ` · генерация ${fmtDuration(job.durationSec)}` : ''}
          </div>
          {job.warning && <div className="warn small">{job.warning}</div>}
          <div className="modal-actions">
            {file && <a className="btn primary" href={`/api/jobs/${job.id}/download/${idx}`}>Скачать{files.length > 1 ? ` (${idx + 1}/${files.length})` : ''}</a>}
            <button className="btn" onClick={() => { onReuse(job); onClose(); }}>Повторить с этими параметрами</button>
            {canManage(job) && (
              <button className="btn ghost danger" onClick={() => confirmDelete(job, (j) => { onDelete(j); onClose(); })}>Удалить</button>
            )}
          </div>
          <button className="link" onClick={() => setShowLog((v) => !v)}>{showLog ? '▾' : '▸'} Лог sd-cli</button>
          {showLog && <LogView jobId={job.id} />}
        </div>
      </div>
    </div>
  );
}

export default function Gallery({ kind, jobs, onDelete, onReuse, canManage }) {
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState(null);
  const shown = jobs.filter((j) => (filter === 'all' ? true : filter === 'done' ? j.status === 'done' : j.status !== 'done'));
  const open = jobs.find((j) => j.id === openId);
  const video = kind === 'video';

  return (
    <div className="card">
      <div className="gal-head">
        <h3>Результаты · {jobs.filter((j) => j.status === 'done').length}</h3>
        <div className="tabs">
          {FILTERS.map((f) => (
            <button key={f.key} className={`tab ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
      </div>
      {!shown.length ? (
        <div className="muted empty">Здесь появятся {video ? 'готовые видео' : 'готовые изображения'}.</div>
      ) : (
        <div className={`grid ${video ? '' : 'grid-img'}`}>
          {shown.map((j) => (
            <div key={j.id} className={`tile ${j.status}`}>
              <button className={`thumb ${video ? '' : 'thumb-img'}`} onClick={() => setOpenId(j.id)} title="Открыть">
                {j.thumb ? <img src={`/files/thumbs/${j.thumb}`} alt="" loading="lazy" /> : <div className="thumb-empty">{STATUS_LABEL[j.status]}</div>}
                {j.status === 'done' && video && <span className="play">▶</span>}
                <span className="badge">
                  {j.params.width}×{j.params.height}
                  {video ? ` · ${clipSeconds(j.params).toFixed(1)} с · ${j.params.outFps ?? j.params.fps} fps` : j.files?.length > 1 ? ` · ${j.files.length} шт.` : ''}
                </span>
                {j.status !== 'done' && <span className={`badge st ${j.status}`}>{STATUS_LABEL[j.status]}</span>}
              </button>
              <div className="tile-body">
                <div className="tile-prompt" title={j.params.prompt}>{j.params.prompt}</div>
                {j.status === 'failed' && j.error && <div className="tile-err" title={j.error}>{j.error}</div>}
                <div className="tile-meta">
                  <span className="muted small">{fmtDate(j.createdAt)}{j.durationSec ? ` · ${fmtDuration(j.durationSec)}` : ''}</span>
                  <span className="tile-actions">
                    {j.files?.length > 0 && <a className="btn-icon" href={`/api/jobs/${j.id}/download/0`} title="Скачать">⤓</a>}
                    <button className="btn-icon" title="Повторить" onClick={() => onReuse(j)}>↻</button>
                    {canManage(j) && <button className="btn-icon danger" title="Удалить" onClick={() => confirmDelete(j, onDelete)}>🗑</button>}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && <Modal job={open} onClose={() => setOpenId(null)} onDelete={onDelete} onReuse={onReuse} canManage={canManage} />}
    </div>
  );
}
