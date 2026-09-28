import { useState } from 'react';
import { jobKind } from './util.js';
import { t } from './i18n.js';
import GenerateForm from './GenerateForm.jsx';
import { ActiveJob } from './Jobs.jsx';
import Gallery, { Modal, ResultHero } from './Gallery.jsx';

// The create workspace: the form on the left (images, video or audio), on the right the running job or
// the latest result with what to do next, a line about the queue and the recent results.
// The GPU is shared, so the running job is shown whatever its kind.
export default function Studio({ kind, setKind, user, jobs, presets, allPresets, templates, system, skew, refresh, reloadPresets, goModels, reuse, onReuseApplied, actions, goGallery, openQueue }) {
  const { canManage, onCancel } = actions;
  const [openId, setOpenId] = useState(null);
  const running = jobs.find((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued');
  const finished = jobs
    .filter((j) => jobKind(j) === kind && ['done', 'failed', 'cancelled'].includes(j.status))
    .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));
  const latest = finished.find((j) => j.user === user.username);
  const myQueued = queued.filter((j) => j.user === user.username).length;
  const open = jobs.find((j) => j.id === openId);

  return (
    <main className="layout">
      <aside className="col-form">
        <div className="seg" role="tablist" aria-label={t('What to create')} style={{ marginBottom: 12 }}>
          <button role="tab" aria-selected={kind === 'image'} className={`seg-item ${kind === 'image' ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setKind('image')}>🖼 {t('Image')}</button>
          <button role="tab" aria-selected={kind === 'video'} className={`seg-item ${kind === 'video' ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setKind('video')}>🎬 {t('Video')}</button>
          <button role="tab" aria-selected={kind === 'audio'} className={`seg-item ${kind === 'audio' ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setKind('audio')}>♪ {t('Audio')}</button>
        </div>
        <GenerateForm
          key={kind}
          kind={kind}
          user={user}
          presets={presets}
          allPresets={allPresets}
          templates={templates}
          system={system}
          jobs={jobs}
          reuse={reuse}
          onReuseApplied={onReuseApplied}
          queueSize={queued.length + (running ? 1 : 0)}
          onCreated={() => refresh({ force: true })}
          reloadPresets={reloadPresets}
          goModels={goModels}
        />
      </aside>
      <section className="col-main">
        {running ? (
          <ActiveJob job={running} skew={skew} onCancel={canManage(running) ? onCancel : null} mine={running.user === user.username} />
        ) : latest ? (
          <ResultHero job={latest} acts={actions} onOpen={(j) => setOpenId(j.id)} />
        ) : (
          <div className="card idle">
            <div className="idle-title">{t('Ready')}</div>
            <div className="muted">{t('Describe what you want on the left and press Generate. Results appear here.')}</div>
          </div>
        )}
        {queued.length > 0 && (
          <div className="card" style={{ padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span className="small">
              {t('{n} waiting in the queue', { n: queued.length })}
              {myQueued > 0 ? <span className="muted"> · {t('{n} of them yours', { n: myQueued })}</span> : null}
            </span>
            <button className="link" onClick={openQueue}>{t('View the queue')}</button>
          </div>
        )}
        <Gallery kind={kind} jobs={finished} onOpenAll={goGallery} {...actions} />
      </section>
      {open && <Modal job={open} onClose={() => setOpenId(null)} {...actions} />}
    </main>
  );
}
