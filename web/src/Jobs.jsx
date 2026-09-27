import { useEffect, useRef, useState } from 'react';
import { api, clipSeconds, fmtDuration, jobKind, QUALITY_LABEL, STAGES } from './util.js';
import { t } from './i18n.js';

// The task of a job that is not plain generation, as a chip
const TASK_CHIP = {
  rework: () => `🖼 ${t('Rework a photo')}`,
  animate: () => `🖼 ${t('Animate a photo')}`,
  inpaint: () => `🖌 ${t('Change a part')}`,
  upscale: () => `⤢ ${t('Upscale')}`,
  reference: () => `👤 ${t('Put a person in')}`,
  restyle: () => `🎞 ${t('Change a video')}`,
};

// A job's settings as small chips. The everyday view shows what matters to people (mode, size,
// length, quality, task); `detailed` adds the technical ones (prompt strictness, variation number).
export function ParamChips({ p, user, detailed = false }) {
  const video = (p.kind || 'video') === 'video';
  // An upscale has no generation settings: the mode, the result size and the task
  if (p.task === 'upscale') {
    return (
      <div className="pchips">
        <span>{p.presetName || p.presetId}</span>
        {p.width > 0 && <span>{p.width}×{p.height}</span>}
        <span>{TASK_CHIP.upscale()}</span>
        {user && <span>👤 {user}</span>}
      </div>
    );
  }
  const task = TASK_CHIP[p.task] ? TASK_CHIP[p.task]() : p.image ? `🖼 ${video ? t('Animate a photo') : t('Rework a photo')}` : null;
  return (
    <div className="pchips">
      <span>{p.presetName || p.presetId}</span>
      <span>{p.width}×{p.height}</span>
      {video ? <span>{t('{s} s', { s: clipSeconds(p).toFixed(1) })} · {p.outFps ?? p.fps} fps</span> : p.count > 1 && <span>× {p.count}</span>}
      <span>{QUALITY_LABEL[p.quality] ? t(QUALITY_LABEL[p.quality]) : t('{n} steps', { n: p.steps })}</span>
      {p.segments > 1 && <span>{t('long video ({n} parts)', { n: p.segments })}</span>}
      {task && <span>{task}</span>}
      {detailed && <span>{t('Prompt strictness')} {p.cfg}</span>}
      {detailed && <span>{t('Variation number')} {p.seed}</span>}
      {user && <span>👤 {user}</span>}
    </div>
  );
}

export function LogView({ jobId, live }) {
  const [lines, setLines] = useState([]);
  const box = useRef(null);
  useEffect(() => {
    let stop = false;
    const load = () => api(`/api/jobs/${jobId}/log?tail=300`).then((d) => !stop && setLines(d.lines)).catch(() => {});
    load();
    const timer = live ? setInterval(load, 3000) : null;
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [jobId, live]);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);
  return <pre className="log" ref={box}>{lines.join('\n') || '…'}</pre>;
}

function Bar({ cur, total, indeterminate }) {
  const pct = total ? Math.min(100, (cur / total) * 100) : 0;
  return (
    <div className={`bar ${indeterminate ? 'ind' : ''}`}>
      <div style={{ width: indeterminate ? undefined : pct + '%' }} />
    </div>
  );
}

// Where a running job is, in plain words, with a share done and the time left when known.
// Shared by the job card and the status pill in the header.
export function jobProgress(job, now) {
  const pr = job.progress || {};
  const st = pr.stages?.[pr.stage] || {};
  const video = jobKind(job) === 'video';
  const segs = pr.segments > 1 ? pr.segments : 1;
  const segDone = (pr.segment || 1) - 1;
  if (pr.loading && pr.loading.cur < pr.loading.total) {
    return { label: t('Loading the model…'), cur: pr.loading.cur, total: pr.loading.total, pct: null, left: null };
  }
  if (pr.stage === 'sampling' && st.total > 0) {
    const left = st.sit ? (st.total - st.cur) * st.sit : null;
    // The whole job: the share of sampling steps done over all passes
    const pct = Math.round(((segDone + st.cur / st.total) / segs) * 100);
    return { label: t('Drawing · step {cur} of {total}', { cur: st.cur, total: st.total }), cur: st.cur, total: st.total, pct, left: segs > 1 ? null : left };
  }
  if (pr.stage === 'decoding') {
    return { label: t('Finishing…'), cur: st.cur || 0, total: st.total || 0, pct: null, left: st.total && st.sit ? (st.total - st.cur) * st.sit : null };
  }
  if (pr.stage === 'saving') return { label: video ? t('Saving the video…') : t('Saving…'), pct: null, left: null };
  if (job.params?.task === 'upscale') return { label: t('Upscaling…'), pct: null, left: null };
  return { label: t('Getting ready…'), pct: null, left: null, since: st.startedAt ? (now - st.startedAt) / 1000 : 0 };
}

// The running job's clock: only this card re-renders every second, not the whole app
export function useNow(skew = 0) {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(timer);
  }, [skew]);
  return now;
}

// The running job: the preview first and large, one progress line in plain words; the stages
// and the engine log are behind "Details"
export function ActiveJob({ job, skew, onCancel, mine = true }) {
  const now = useNow(skew);
  const pr = job.progress || {};
  const stages = (job.params?.task === 'upscale' && STAGES.upscale) || STAGES[jobKind(job)] || STAGES.video;
  const idx = stages.findIndex((s) => s.key === pr.stage);
  const total = job.startedAt ? (now - job.startedAt) / 1000 : 0;
  const p = jobProgress(job, now);
  const video = jobKind(job) === 'video';
  const aspect = job.params?.width && job.params?.height ? `${job.params.width} / ${job.params.height}` : '16 / 9';

  return (
    <div className="card active">
      <div className="active-head">
        <div className="eyebrow">
          <span className="dot live" /> {video ? t('Generating a video') : t('Generating an image')}
          {pr.segments > 1 ? ` · ${t('part {n} of {total}', { n: pr.segment, total: pr.segments })}` : ''} · {fmtDuration(total)}
          {!mine && job.user ? ` · 👤 ${job.user}` : ''}
        </div>
        {onCancel && <button className="btn ghost danger btn-small" onClick={() => confirm(t('Cancel the generation?')) && onCancel(job)}>{t('Cancel')}</button>}
      </div>

      <div className="hero">
        <div className="hero-media" style={{ cursor: 'default', aspectRatio: job.previewAt ? undefined : aspect }}>
          {job.previewAt ? (
            <img src={`/files/previews/${job.id}${job.previewExt || '.webp'}?t=${Math.floor(job.previewAt)}`} alt="" />
          ) : (
            <span className="muted small">{t('A rough preview appears once drawing starts')}</span>
          )}
        </div>
        <div className="hero-info">
          <div className="sd-head">
            <span>{p.label}</span>
            <span className="muted">
              {p.pct != null ? `${p.pct}%` : ''}
              {p.left != null ? ` · ${t('≈ {time} left', { time: fmtDuration(p.left) })}` : ''}
            </span>
          </div>
          <Bar cur={p.pct ?? p.cur ?? 0} total={p.pct != null ? 100 : p.total} indeterminate={p.pct == null && !(p.total > 0 && p.cur > 0)} />
          <div className="prompt small" style={{ WebkitLineClamp: 4, display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{job.params.prompt}</div>
          <ParamChips p={job.params} user={mine ? null : job.user} />
          {job.previewAt ? <span className="preview-cap">{t('Rough preview, not the final quality')}</span> : null}
        </div>
      </div>

      <details className="more">
        <summary>{t('Details')}</summary>
        <div className="more-body">
          <div className="stages">
            {stages.map((s, i) => {
              const st = pr.stages?.[s.key];
              const state = i < idx ? 'done' : i === idx ? 'now' : 'todo';
              const dur = st?.endedAt ? (st.endedAt - st.startedAt) / 1000 : null;
              return (
                <div key={s.key} className={`stage ${state}`}>
                  <span className="stage-dot">{state === 'done' ? '✓' : i + 1}</span>
                  <span className="stage-label">{t(s.label)}</span>
                  {dur != null && <span className="stage-dur">{fmtDuration(dur)}</span>}
                </div>
              );
            })}
          </div>
          <ParamChips p={job.params} detailed />
          <span className="subhead">{t('Technical log')}</span>
          <LogView jobId={job.id} live />
        </div>
      </details>
    </div>
  );
}

// Jobs waiting for the GPU, oldest first
export function QueueList({ jobs, onCancel, canManage, bare = false }) {
  if (!jobs.length) return bare ? <div className="muted small">{t('Nothing is waiting.')}</div> : null;
  const list = (
    <ol className="queue">
      {jobs.map((j) => (
        <li key={j.id}>
          <div className="q-main">
            <div className="q-prompt">{jobKind(j) === 'video' ? '🎬' : '🖼'} {j.params.prompt || t(j.params.presetName || '')}</div>
            <ParamChips p={j.params} user={j.user} />
          </div>
          {canManage(j) && <button className="btn-icon" title={t('Remove from the queue')} onClick={() => onCancel(j)}>×</button>}
        </li>
      ))}
    </ol>
  );
  if (bare) return list;
  return (
    <div className="card">
      <h3>{t('Queue')} · {jobs.length}</h3>
      {list}
    </div>
  );
}

// The GPU status in the header: idle, or the running job's progress and the queue length.
// Warnings (throttling, overheating) show as a badge; a click opens the queue panel.
export function StatusPill({ jobs, system, online, skew, onOpen }) {
  const now = useNow(skew);
  const running = jobs.find((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const thermal = system?.throttle?.thermal?.length > 0;
  let text;
  if (!online) text = t('No connection');
  else if (running) {
    const p = jobProgress(running, now);
    text = [t('Generating'), p.pct != null ? `${p.pct}%` : null, p.left != null ? t('≈ {time} left', { time: fmtDuration(p.left) }) : null].filter(Boolean).join(' · ');
  } else text = t('Idle');
  const hw = system && [
    system.gpuBusy != null && `GPU ${system.gpuBusy}%`,
    system.gpuTemp != null && `${Math.round(system.gpuTemp)} °C`,
    system.gttTotal > 0 && `${t('GPU memory')} ${Math.round((system.gttUsed / system.gttTotal) * 100)}%`,
  ].filter(Boolean).join(' · ');
  return (
    <button className="status-pill" onClick={onOpen} title={hw || undefined}>
      <span className={`dot ${!online ? 'bad' : running ? 'live' : ''}`} />
      <span>{text}</span>
      {queued > 0 && <span className="sp-queue">· {t('{n} waiting', { n: queued })}</span>}
      {thermal && <span className="sp-badge">{t('Overheating')}</span>}
    </button>
  );
}

// The queue as a side panel: the running job and everything waiting
export function QueueDrawer({ jobs, skew, onClose, onCancel, canManage, system }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const running = jobs.find((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt));
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={t('Queue')}>
        <div className="drawer-head">
          <h3>{t('Queue')}</h3>
          <button className="btn-icon" onClick={onClose} title={t('Close')}>×</button>
        </div>
        <div className="drawer-body">
          {running ? <ActiveJob job={running} skew={skew} onCancel={canManage(running) ? onCancel : null} mine={false} /> : <div className="muted">{t('The GPU is free.')}</div>}
          <div>
            <span className="subhead">{t('Waiting')} · {queued.length}</span>
            <QueueList jobs={queued} onCancel={onCancel} canManage={canManage} bare />
          </div>
          {system?.throttle?.thermal?.length > 0 && <div className="note bad">⚠ {t('Overheating: the firmware lowered the clocks.')}</div>}
        </div>
      </aside>
    </>
  );
}
