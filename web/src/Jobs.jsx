import { useEffect, useRef, useState } from 'react';
import { api, clipSeconds, fmtDuration, jobKind, QUALITY_LABEL, STAGES } from './util.js';

export function ParamChips({ p, user }) {
  const video = (p.kind || 'video') === 'video';
  return (
    <div className="pchips">
      <span>{p.presetName || p.presetId}</span>
      <span>{p.width}×{p.height}</span>
      {video ? <span>{clipSeconds(p).toFixed(1)} с · {p.outFps ?? p.fps} fps</span> : <span>× {p.count || 1}</span>}
      <span className={p.quality === 'extra' ? 'extra-text' : ''}>{QUALITY_LABEL[p.quality] || `${p.steps} шаг.`}</span>
      {p.segments > 1 && <span className="extra-text">экстра · 2 сегмента</span>}
      <span>CFG {p.cfg}</span>
      <span>seed {p.seed}</span>
      {p.image && <span>🖼 {video ? 'картинка → видео' : 'картинка → картинка'}</span>}
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
    const t = live ? setInterval(load, 3000) : null;
    return () => {
      stop = true;
      if (t) clearInterval(t);
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
        <div className="sd-head"><span>Загрузка весов в память GPU</span><span>{pr.loading.cur}/{pr.loading.total}</span></div>
        <Bar cur={pr.loading.cur} total={pr.loading.total} />
      </div>
    );
  }

  if (pr.stage === 'sampling' || pr.stage === 'decoding') {
    const unit = pr.stage === 'sampling' ? 'шаг' : 'плитка';
    const has = st.total > 0;
    const remaining = has && st.sit ? (st.total - st.cur) * st.sit : null;
    return (
      <div className="stage-detail">
        <div className="sd-head">
          <span>
            {has ? `${unit} ${st.cur} из ${st.total}` : pr.stage === 'sampling' ? 'запуск…' : 'декодирование…'}
            {has && st.sit ? <span className="muted"> · {st.sit.toFixed(1)} с/{unit}</span> : null}
          </span>
          <span>
            {fmtDuration(elapsed)}
            {remaining != null && <span className="muted"> · осталось ≈ {fmtDuration(remaining)}</span>}
          </span>
        </div>
        <Bar cur={st.cur || 0} total={st.total} indeterminate={!has || st.cur === 0} />
      </div>
    );
  }

  return (
    <div className="stage-detail">
      <div className="sd-head">
        <span>{pr.stage === 'saving' ? (video ? 'Сборка mp4 и интерполяция FPS (ffmpeg, на CPU)…' : 'Сохранение…') : 'Загрузка моделей и текстового энкодера…'}</span>
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
            <span className="dot live" /> {jobKind(job) === 'video' ? 'Генерируется видео' : 'Генерируется изображение'}
            {pr.segments > 1 ? ` · сегмент ${pr.segment} из ${pr.segments}` : ''} · {fmtDuration(total)}
          </div>
          <div className="prompt">{job.params.prompt}</div>
          <ParamChips p={job.params} user={job.user} />
        </div>
        {onCancel && <button className="btn ghost danger" onClick={() => confirm('Отменить генерацию?') && onCancel(job)}>Отменить</button>}
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
                <span className="stage-label">{s.label}</span>
                {dur != null && <span className="stage-dur">{fmtDuration(dur)}</span>}
              </div>
            );
          })}
        </div>
        <StageDetail job={job} now={now} />
        {job.previewAt ? (
          <div className="preview">
            <img src={`/files/previews/${job.id}${job.previewExt || '.webp'}?t=${Math.floor(job.previewAt)}`} alt="превью" />
            <span className="preview-cap">Превью латентов (грубое, не финальное качество)</span>
          </div>
        ) : null}
      </div>

      <button className="link" onClick={() => setShowLog((v) => !v)}>{showLog ? '▾' : '▸'} Лог sd-cli</button>
      {showLog && <LogView jobId={job.id} live />}
    </div>
  );
}

export function QueueList({ jobs, onCancel, canManage }) {
  if (!jobs.length) return null;
  return (
    <div className="card">
      <h3>Очередь · {jobs.length}</h3>
      <ol className="queue">
        {jobs.map((j) => (
          <li key={j.id}>
            <div className="q-main">
              <div className="q-prompt">{jobKind(j) === 'video' ? '🎬' : '🖼'} {j.params.prompt}</div>
              <ParamChips p={j.params} user={j.user} />
            </div>
            {canManage(j) && <button className="btn-icon" title="Убрать из очереди" onClick={() => onCancel(j)}>×</button>}
          </li>
        ))}
      </ol>
    </div>
  );
}
