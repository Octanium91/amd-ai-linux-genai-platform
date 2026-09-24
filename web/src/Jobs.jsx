import { useEffect, useRef, useState } from 'react';
import { api, clipSeconds, fmtDuration, jobKind, QUALITY_LABEL, STAGES } from './util.js';
import { t } from './i18n.js';

export function ParamChips({ p, user }) {
  const video = (p.kind || 'video') === 'video';
  return (
    <div className="pchips">
      <span>{p.presetName || p.presetId}</span>
      <span>{p.width}×{p.height}</span>
      {video ? <span>{t('{s} s', { s: clipSeconds(p).toFixed(1) })} · {p.outFps ?? p.fps} fps</span> : <span>× {p.count || 1}</span>}
      <span className={p.quality === 'extra' ? 'extra-text' : ''}>{QUALITY_LABEL[p.quality] ? t(QUALITY_LABEL[p.quality]) : t('{n} steps', { n: p.steps })}</span>
      {p.segments > 1 && <span className="extra-text">{t('extra · 2 segments')}</span>}
      <span>CFG {p.cfg}</span>
      <span>seed {p.seed}</span>
      {p.image && <span>🖼 {video ? t('image → video') : t('image → image')}</span>}
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

function StageDetail({ job, now }) {
  const pr = job.progress || {};
  const st = pr.stages?.[pr.stage] || {};
  const elapsed = st.startedAt ? (now - st.startedAt) / 1000 : 0;
  const video = jobKind(job) === 'video';

  if (pr.loading && pr.loading.cur < pr.loading.total) {
    return (
      <div className="stage-detail">
        <div className="sd-head"><span>{t('Loading weights into GPU memory')}</span><span>{pr.loading.cur}/{pr.loading.total}</span></div>
        <Bar cur={pr.loading.cur} total={pr.loading.total} />
      </div>
    );
  }

  if (pr.stage === 'sampling' || pr.stage === 'decoding') {
    const sampling = pr.stage === 'sampling';
    const has = st.total > 0;
    const remaining = has && st.sit ? (st.total - st.cur) * st.sit : null;
    return (
      <div className="stage-detail">
        <div className="sd-head">
          <span>
            {has
              ? t(sampling ? 'step {cur} of {total}' : 'tile {cur} of {total}', { cur: st.cur, total: st.total })
              : sampling ? t('starting…') : t('decoding…')}
            {has && st.sit ? <span className="muted"> · {t(sampling ? '{s} s/step' : '{s} s/tile', { s: st.sit.toFixed(1) })}</span> : null}
          </span>
          <span>
            {fmtDuration(elapsed)}
            {remaining != null && <span className="muted"> · {t('≈ {time} left', { time: fmtDuration(remaining) })}</span>}
          </span>
        </div>
        <Bar cur={st.cur || 0} total={st.total} indeterminate={!has || st.cur === 0} />
      </div>
    );
  }

  return (
    <div className="stage-detail">
      <div className="sd-head">
        <span>
          {pr.stage === 'saving'
            ? (video ? t('Building the mp4 and interpolating FPS (ffmpeg, on CPU)…') : t('Saving…'))
            : t('Loading models and the text encoder…')}
        </span>
        <span>{fmtDuration(elapsed)}</span>
      </div>
      <Bar indeterminate />
    </div>
  );
}

export function ActiveJob({ job, now, onCancel }) {
  const [showLog, setShowLog] = useState(false);
  const pr = job.progress || {};
  const stages = STAGES[jobKind(job)] || STAGES.video;
  const idx = stages.findIndex((s) => s.key === pr.stage);
  const total = job.startedAt ? (now - job.startedAt) / 1000 : 0;

  return (
    <div className="card active">
      <div className="active-head">
        <div>
          <div className="eyebrow">
            <span className="dot live" /> {jobKind(job) === 'video' ? t('Generating a video') : t('Generating an image')}
            {pr.segments > 1 ? ` · ${t('segment {n} of {total}', { n: pr.segment, total: pr.segments })}` : ''} · {fmtDuration(total)}
          </div>
          <div className="prompt">{job.params.prompt}</div>
          <ParamChips p={job.params} user={job.user} />
        </div>
        {onCancel && <button className="btn ghost danger" onClick={() => confirm(t('Cancel the generation?')) && onCancel(job)}>{t('Cancel')}</button>}
      </div>

      <div className="active-body">
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
        <StageDetail job={job} now={now} />
        {job.previewAt ? (
          <div className="preview">
            <img src={`/files/previews/${job.id}${job.previewExt || '.webp'}?t=${Math.floor(job.previewAt)}`} alt="" />
            <span className="preview-cap">{t('Latent preview (rough, not the final quality)')}</span>
          </div>
        ) : null}
      </div>

      <button className="link" onClick={() => setShowLog((v) => !v)}>{showLog ? '▾' : '▸'} {t('sd-cli log')}</button>
      {showLog && <LogView jobId={job.id} live />}
    </div>
  );
}

export function QueueList({ jobs, onCancel, canManage }) {
  if (!jobs.length) return null;
  return (
    <div className="card">
      <h3>{t('Queue')} · {jobs.length}</h3>
      <ol className="queue">
        {jobs.map((j) => (
          <li key={j.id}>
            <div className="q-main">
              <div className="q-prompt">{jobKind(j) === 'video' ? '🎬' : '🖼'} {j.params.prompt}</div>
              <ParamChips p={j.params} user={j.user} />
            </div>
            {canManage(j) && <button className="btn-icon" title={t('Remove from the queue')} onClick={() => onCancel(j)}>×</button>}
          </li>
        ))}
      </ol>
    </div>
  );
}
