import { jobKind } from './util.js';
import { t } from './i18n.js';
import GenerateForm from './GenerateForm.jsx';
import { ActiveJob, QueueList } from './Jobs.jsx';
import Gallery from './Gallery.jsx';

// Studio for one content type. The GPU is shared, so the current generation is shown in every section.
export default function Studio({ kind, user, jobs, presets, templates, system, now, refresh, reloadPresets, goModels, reuse, actions, goGallery }) {
  const { canManage, onCancel, onDelete, onRetry, onReuse } = actions;
  const running = jobs.find((j) => j.status === 'running');
  const queuedAll = jobs.filter((j) => j.status === 'queued').sort((a, b) => (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt));
  const finished = jobs
    .filter((j) => jobKind(j) === kind && ['done', 'failed', 'cancelled'].includes(j.status))
    .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));

  return (
    <main className="layout">
      <aside className="col-form">
        <GenerateForm
          key={kind}
          kind={kind}
          user={user}
          presets={presets}
          templates={templates}
          system={system}
          jobs={jobs}
          reuse={reuse}
          queueSize={queuedAll.length + (running ? 1 : 0)}
          onCreated={refresh}
          reloadPresets={reloadPresets}
          goModels={goModels}
        />
      </aside>
      <section className="col-main">
        {running ? (
          <ActiveJob job={running} now={now} onCancel={canManage(running) ? onCancel : null} />
        ) : (
          <div className="card idle">
            <div className="idle-title">{t('GPU is idle')}</div>
            <div className="muted">{t('Describe what to generate and add the job to the queue.')}</div>
          </div>
        )}
        <QueueList jobs={queuedAll} onCancel={onCancel} canManage={canManage} />
        <Gallery kind={kind} jobs={finished} onDelete={onDelete} onReuse={onReuse} onRetry={onRetry} canManage={canManage} onOpenAll={goGallery} />
      </section>
    </main>
  );
}
