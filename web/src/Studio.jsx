import { useState } from 'react';
import { api, jobKind } from './util.js';
import GenerateForm from './GenerateForm.jsx';
import { ActiveJob, QueueList } from './Jobs.jsx';
import Gallery from './Gallery.jsx';

// Студия одного типа контента. GPU общий, поэтому текущая генерация видна в любом разделе.
export default function Studio({ kind, user, jobs, presets, now, refresh, reloadPresets, goModels }) {
  const [reuse, setReuse] = useState(null);
  const running = jobs.find((j) => j.status === 'running');
  const queuedAll = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  const finished = jobs
    .filter((j) => jobKind(j) === kind && ['done', 'failed', 'cancelled'].includes(j.status))
    .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));

  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      alert(e.message);
    }
    refresh();
  };
  const canManage = (job) => user.role === 'admin' || job.user === user.username;
  const onCancel = (job) => act(() => api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }));
  const onDelete = (job) => act(() => api(`/api/jobs/${job.id}`, { method: 'DELETE' }));
  const onReuse = (job) => {
    setReuse({ ...job.params, _t: Date.now() });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <main className="layout">
      <aside className="col-form">
        <GenerateForm
          key={kind}
          kind={kind}
          user={user}
          presets={presets}
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
            <div className="idle-title">GPU свободен</div>
            <div className="muted">Опишите, что сгенерировать, и поставьте задачу в очередь.</div>
          </div>
        )}
        <QueueList jobs={queuedAll} onCancel={onCancel} canManage={canManage} />
        <Gallery kind={kind} jobs={finished} onDelete={onDelete} onReuse={onReuse} canManage={canManage} />
      </section>
    </main>
  );
}
