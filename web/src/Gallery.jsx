import { useEffect, useState } from 'react';
import { audioSeconds, clipSeconds, fileUrl, fmtDate, fmtDuration, jobKind, STATUS_LABEL } from './util.js';
import { t, tError } from './i18n.js';
import { LogView, ParamChips } from './Jobs.jsx';

// Failed and cancelled jobs can be put back into the queue as they were
export const canRetry = (job, canManage) => ['failed', 'cancelled'].includes(job.status) && canManage(job);

export function confirmDelete(job, onDelete) {
  if (confirm(t('Delete the generation together with its files?'))) onDelete(job);
}

const isVideoFile = (f) => /\.(mp4|webm)$/i.test(f);
const isImageFile = (f) => /\.(png|jpe?g|webp)$/i.test(f);
const isAudioFile = (f) => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f);

// An audio result: its waveform picture over the player
function AudioView({ job, file, autoPlay = false }) {
  return (
    <div className="audio-view">
      {job.thumb && <img src={`/files/thumbs/${job.thumb}?v=${job.finishedAt || 0}`} alt="" />}
      <audio key={file} src={fileUrl(file)} controls autoPlay={autoPlay} preload="metadata" />
    </div>
  );
}

// What can be done with a finished result. An image can go on as the photo of another task;
// every job can be edited and run again. `acts` carries the handlers from App.
export function NextActions({ job, index = 0, acts, onDone, primaryDownload = true }) {
  const [msg, setMsg] = useState(null);
  const file = job.files?.[index];
  const image = file && isImageFile(file);
  const audio = file && isAudioFile(file);
  const run = async (fn, okText) => {
    setMsg({ busy: true });
    try {
      await fn();
      setMsg(okText ? { text: okText } : null);
      if (!okText) onDone?.();
    } catch (e) {
      setMsg({ text: e.message, error: true });
    }
  };
  return (
    <>
      <div className="hero-actions">
        {file && primaryDownload && <a className="btn primary" href={`/api/jobs/${job.id}/download/${index}`}>{t('Download')}</a>}
        {canRetry(job, acts.canManage) && <button className="btn primary" onClick={() => { acts.onRetry(job); onDone?.(); }}>{t('Run again')}</button>}
        {image && job.params.task !== 'upscale' && acts.onUpscale && (
          <button className="btn" disabled={msg?.busy} onClick={() => run(() => acts.onUpscale(job, index), t('Queued: the upscaled image appears in the gallery.'))}>⤢ {t('Upscale ×4')}</button>
        )}
        {image && acts.onFollowUp && (
          <>
            <button className="btn" onClick={() => run(() => acts.onFollowUp(job, index, 'image', 'inpaint'))}>🖌 {t('Change a part')}</button>
            <button className="btn" onClick={() => run(() => acts.onFollowUp(job, index, 'image', 'rework'))}>🖼 {t('Rework')}</button>
            <button className="btn" onClick={() => run(() => acts.onFollowUp(job, index, 'video', 'animate'))}>🎬 {t('Animate')}</button>
            <button className="btn" onClick={() => run(() => acts.onFollowUp(job, index, 'image', 'cutout'))}>✂ {t('Remove background')}</button>
          </>
        )}
        {audio && acts.onSoundtrack && (
          <button className="btn" onClick={() => run(() => acts.onSoundtrack(job, index))}>🎬 {t('Use as the sound of a video')}</button>
        )}
        <button className="btn ghost" onClick={() => { acts.onReuse(job); onDone?.(); }}>↻ {t('Edit and run again')}</button>
      </div>
      {msg?.text && <div className={`small ${msg.error ? 'warn' : 'muted'}`}>{msg.text}</div>}
    </>
  );
}

// The technical side of a job, folded away: all settings, the negative prompt and the engine log
function TechDetails({ job }) {
  return (
    <details className="more">
      <summary>{t('Technical details')}</summary>
      <div className="more-body">
        <ParamChips p={job.params} user={job.user} detailed />
        {job.params.negative && <div className="muted small">{t('What to avoid')}: {job.params.negative}</div>}
        <span className="subhead">{t('Technical log')}</span>
        <LogView jobId={job.id} />
      </div>
    </details>
  );
}

export function Modal({ job, onClose, canManage, onDelete, ...acts }) {
  const [idx, setIdx] = useState(0);
  const [confirmDel, setConfirmDel] = useState(false);
  const files = job.files || [];
  const file = files[idx];
  const all = { canManage, onDelete, ...acts };
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
        ) : file && isAudioFile(file) ? (
          <AudioView job={job} file={file} autoPlay />
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
          {job.params.prompt && (
            <div>
              <div className="prompt" style={{ paddingRight: files.length ? 0 : 44 }}>{job.params.prompt}</div>
              <button className="link muted small" onClick={() => navigator.clipboard?.writeText(job.params.prompt)}>⧉ {t('Copy the prompt')}</button>
            </div>
          )}
          <ParamChips p={job.params} user={job.user} />
          <div className="muted small">
            {fmtDate(job.finishedAt || job.createdAt)}
            {job.durationSec ? ` · ${t('generated in {time}', { time: fmtDuration(job.durationSec) })}` : ''}
          </div>
          {job.warning && <div className="note warn">⚠ {tError(job.warning)}</div>}
          <NextActions job={job} index={idx} acts={all} onDone={onClose} />
          {canManage(job) && (confirmDel ? (
            <div className="confirm-row">
              <span>{t('Delete the generation together with its files?')}</span>
              <button className="btn danger-solid btn-small" onClick={() => { onDelete(job); onClose(); }}>{t('Delete')}</button>
              <button className="btn ghost btn-small" onClick={() => setConfirmDel(false)}>{t('Keep')}</button>
            </div>
          ) : (
            <button className="link muted" onClick={() => setConfirmDel(true)}>{t('Delete')}</button>
          ))}
          <TechDetails job={job} />
        </div>
      </div>
    </div>
  );
}

// One result tile; used by the recent results and by the library
export function Tile({ job: j, onOpen, onDelete, onReuse, onRetry, canManage, showKind = false }) {
  const kind = jobKind(j);
  const video = kind === 'video';
  const audio = kind === 'audio';
  const kindLabel = { video: t('Video'), image: t('Image'), audio: t('Audio') }[kind];
  const size = video ? t('{s} s', { s: clipSeconds(j.params).toFixed(1) })
    : audio ? (audioSeconds(j) ? fmtDuration(audioSeconds(j)) : '')
      : `${j.params.width}×${j.params.height}`;
  return (
    <div className={`tile ${j.status}`}>
      <button className={`thumb ${video || audio ? '' : 'thumb-img'}`} onClick={() => onOpen(j)} title={t('Open')}>
        {/* Thumbnails are cached for days: the version changes when a restarted job finishes again */}
        {j.thumb ? <img src={`/files/thumbs/${j.thumb}?v=${j.finishedAt || 0}`} alt="" loading="lazy" />
          : <div className="thumb-empty">{j.status === 'failed' && j.error ? tError(j.error) : t(STATUS_LABEL[j.status])}</div>}
        {j.status === 'done' && (video || audio) && <span className="play">{audio ? '♪' : '▶'}</span>}
        <span className="badge">
          {showKind ? `${kindLabel}${size ? ' · ' : ''}` : ''}
          {size}
          {kind === 'image' && j.files?.length > 1 ? ` · ${t('{n} pcs', { n: j.files.length })}` : ''}
        </span>
        {j.status !== 'done' && <span className={`badge st ${j.status}`}>{t(STATUS_LABEL[j.status])}</span>}
      </button>
      <div className="tile-body">
        <div className="tile-prompt" title={j.params.prompt}>{j.params.prompt || j.params.presetName}</div>
        <div className="tile-meta">
          <span className="muted small">{fmtDate(j.finishedAt || j.createdAt)}{j.durationSec ? ` · ${fmtDuration(j.durationSec)}` : ''}</span>
          <span className="tile-actions">
            {j.files?.length > 0 && <a className="btn-icon" href={`/api/jobs/${j.id}/download/0`} title={t('Download')}>⤓</a>}
            {canRetry(j, canManage) && <button className="btn-icon" title={t('Run again: the same job with the same settings')} onClick={() => onRetry(j)}>⟲</button>}
            <button className="btn-icon" title={t('Edit and run again')} onClick={() => onReuse(j)}>✎</button>
            {canManage(j) && <button className="btn-icon danger" title={t('Delete')} onClick={() => confirmDelete(j, onDelete)}>🗑</button>}
          </span>
        </div>
      </div>
    </div>
  );
}

// The latest result, large, with what to do next
export function ResultHero({ job, acts, onOpen }) {
  const file = job.files?.[0];
  return (
    <div className="card">
      <div className="hero">
        <div className="hero-media" onClick={() => onOpen(job)} title={t('Open')}>
          {file && isVideoFile(file) ? <video src={fileUrl(file)} autoPlay loop muted playsInline />
            : file && isAudioFile(file) ? <div onClick={(e) => e.stopPropagation()}><AudioView job={job} file={file} /></div>
            : file && isImageFile(file) ? <img src={fileUrl(file)} alt="" />
              : <div className="thumb-empty" style={{ aspectRatio: '16 / 9' }}>{job.error ? tError(job.error) : t(STATUS_LABEL[job.status])}</div>}
        </div>
        <div className="hero-info">
          <div className="eyebrow">{job.status === 'done' ? `✓ ${t('Ready')}` : t(STATUS_LABEL[job.status])} · {fmtDate(job.finishedAt || job.createdAt)}{job.durationSec ? ` · ${fmtDuration(job.durationSec)}` : ''}</div>
          {job.params.prompt && <div className="prompt small" style={{ WebkitLineClamp: 4, display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{job.params.prompt}</div>}
          <ParamChips p={job.params} />
          {job.warning && <div className="note warn">⚠ {tError(job.warning)}</div>}
          <NextActions job={job} acts={acts} />
        </div>
      </div>
    </div>
  );
}

// Recent results of one content kind; the full history lives in the library
const RECENT = 12;

export default function Gallery({ kind, jobs, onOpenAll, ...acts }) {
  const [openId, setOpenId] = useState(null);
  const shown = jobs.slice(0, RECENT);
  const open = jobs.find((j) => j.id === openId);
  const video = kind === 'video';
  const wide = video || kind === 'audio';

  return (
    <div className="card">
      <div className="gal-head">
        <h3>{t('Recent')}</h3>
        {onOpenAll && jobs.length > 0 && (
          <button className="link" onClick={onOpenAll}>{jobs.length > RECENT ? t('All {n} in the library →', { n: jobs.length }) : t('Open the library →')}</button>
        )}
      </div>
      {!shown.length ? (
        <div className="muted empty">{video ? t('Finished videos will appear here.') : kind === 'audio' ? t('Finished music, sounds and speech will appear here.') : t('Finished images will appear here.')}</div>
      ) : (
        <div className={`grid ${wide ? '' : 'grid-img'}`}>
          {shown.map((j) => <Tile key={j.id} job={j} onOpen={(x) => setOpenId(x.id)} {...acts} />)}
        </div>
      )}
      {open && <Modal job={open} onClose={() => setOpenId(null)} {...acts} />}
    </div>
  );
}
