import { useCallback, useEffect, useRef, useState } from 'react';
import { api, jobKind, setUnauthorizedHandler } from './util.js';
import { t, useLang } from './i18n.js';
import { LangSwitch } from './LangSwitch.jsx';
import { ThemeSwitch } from './ThemeSwitch.jsx';
import { Logo } from './Logo.jsx';
import Login from './Login.jsx';
import Studio from './Studio.jsx';
import GalleryPage from './GalleryPage.jsx';
import Models from './Models.jsx';
import Users, { ChangePassword } from './Users.jsx';
import Setup from './Setup.jsx';
import System from './System.jsx';
import Settings from './Settings.jsx';
import { QueueDrawer, StatusPill } from './Jobs.jsx';

// Two places to be in: Create (images and video, chosen inside the workspace) and the Library of
// everything generated. Administration lives behind one "Admin" menu.
const CREATE_TABS = ['image', 'video', 'audio'];
const ADMIN_TABS = [
  { key: 'models', label: 'Models', icon: 'models' },
  { key: 'users', label: 'Users', icon: 'users' },
  { key: 'system', label: 'System', icon: 'system' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];
const TABS = [...CREATE_TABS, 'gallery', ...ADMIN_TABS.map((x) => x.key)];

const ICONS = {
  settings: 'M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.4 2.5h4l.4-2.5c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6ZM13 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z',
  gallery: 'M4 4h7v7H4V4Zm2 2v3h3V6H6Zm7-2h7v7h-7V4Zm2 2v3h3V6h-3ZM4 13h7v7H4v-7Zm2 2v3h3v-3H6Zm7-2h7v7h-7v-7Zm2 2v3h3v-3h-3Z',
  create: 'M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm6.5 12l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z',
  models: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3L18.7 8 12 11.7 5.3 8 12 4.3ZM5 9.7l6 3.3v6.7l-6-3.3V9.7Zm8 10V13l6-3.3v6.7l-6 3.3Z',
  system: 'M3 12h4l2-6 4 12 2-6h6v-2h-4.6L15 4.5 11 16.8 9 10.5 8.3 10H3v2Z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7.5 6a3.5 3.5 0 1 0 0-7 1 1 0 0 0 0 2 1.5 1.5 0 1 1 0 3 1 1 0 0 0 0 2ZM9 13c-3.9 0-7 2-7 4.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5C16 15 12.9 13 9 13Zm5 6H4v-1.5c0-1.2 2.1-2.5 5-2.5s5 1.3 5 2.5V19Zm3-5.8a1 1 0 0 0-.4 1.9c1.4.6 2.4 1.5 2.4 2.4V19h-1a1 1 0 0 0 0 2h2a1 1 0 0 0 1-1v-2.5c0-1.9-1.6-3.5-4-4.3Z',
};
const Icon = ({ name }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d={ICONS[name]} fill="currentColor" /></svg>
);

const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

function readTab() {
  const tab = location.hash.replace('#', '');
  if (tab === 'create') return store.get('gp_kind', 'image');
  return TABS.includes(tab) ? tab : store.get('gp_kind', 'image');
}

// A menu that closes on an outside click
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  return { open, setOpen, ref };
}

function AdminMenu({ tab, go, health }) {
  const { open, setOpen, ref } = useMenu();
  const active = ADMIN_TABS.some((x) => x.key === tab);
  return (
    <div className="usermenu" ref={ref}>
      <button className={`nav-link ${active ? 'on' : ''}`} onClick={() => setOpen((o) => !o)}>
        <Icon name="settings" /> <span>{t('Admin')}</span> ▾
        {health && health.status !== 'ok' && <span className={`nav-badge ${health.status}`} />}
      </button>
      {open && (
        <div className="menu">
          {ADMIN_TABS.map((x) => (
            <button key={x.key} onClick={() => { go(x.key); setOpen(false); }}>
              <span className="nav-tab-icon"><Icon name={x.icon} /> {t(x.label)}{x.key === 'system' && health && health.status !== 'ok' ? ' ●' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu({ user, onLogout }) {
  const { open, setOpen, ref } = useMenu();
  const [pwd, setPwd] = useState(false);
  return (
    <div className="usermenu" ref={ref}>
      <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
        {user.username}{user.role === 'admin' ? ' · admin' : ''} ▾
      </button>
      {open && (
        <div className="menu">
          <div className="menu-row">
            <span className="muted small">{t('Language')}</span>
            <LangSwitch />
          </div>
          <div className="menu-row">
            <span className="muted small">{t('Theme')}</span>
            <ThemeSwitch />
          </div>
          <div className="menu-sep" />
          <button onClick={() => { setPwd(true); setOpen(false); }}>{t('Change password')}</button>
          <button onClick={onLogout}>{t('Sign out')}</button>
        </div>
      )}
      {pwd && <ChangePassword onClose={() => setPwd(false)} />}
    </div>
  );
}

export default function App() {
  useLang(); // re-render the whole tree when the language changes
  const [user, setUser] = useState(undefined); // undefined — checking the session, null — signed out
  const [tab, setTab] = useState(readTab);
  const [jobs, setJobs] = useState([]);
  const [system, setSystem] = useState(null);
  const [presets, setPresets] = useState([]);
  const [templates, setTemplates] = useState(null);
  const [setup, setSetup] = useState(null); // first-run setup state (model packs)
  const [setupSkipped, setSetupSkipped] = useState(() => store.get('gp_setup_later', '') === '1');
  const [online, setOnline] = useState(true);
  const [health, setHealth] = useState(null);
  const [worker, setWorker] = useState(null); // generation engine (worker container) status
  const [reuse, setReuse] = useState(null); // job parameters to fill the form with ("repeat", follow-ups)
  const [queueOpen, setQueueOpen] = useState(false);
  const skew = useRef(0);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api('/api/auth/me').then(setUser).catch(() => setUser(null));
    const onHash = () => setTab(readTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // One state request at a time, with a timeout; an answer older than the latest applied one is
  // dropped (a refresh right after a delete must not be overwritten by a request sent before it)
  const polling = useRef({ inFlight: false, seq: 0, applied: 0 });
  const refresh = useCallback(async ({ force = false } = {}) => {
    const p = polling.current;
    if (p.inFlight && !force) return;
    const seq = ++p.seq;
    p.inFlight = true;
    try {
      const s = await api('/api/state', { signal: AbortSignal.timeout(10000) });
      if (seq < p.applied) return;
      p.applied = seq;
      skew.current = s.now - Date.now();
      setJobs(s.jobs);
      setSystem(s.system);
      setHealth(s.health);
      setWorker(s.worker);
      setOnline(true);
    } catch (e) {
      if (e.status !== 401 && seq >= p.applied) setOnline(false);
    } finally {
      if (seq === p.seq) p.inFlight = false;
    }
  }, []);
  const loadPresets = useCallback(() => {
    api('/api/presets').then(setPresets).catch(() => {});
    api('/api/packs').then(setSetup).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    refresh();
    loadPresets();
    api('/api/templates').then(setTemplates).catch(() => setTemplates({}));
    const a = setInterval(refresh, 2000);
    const b = setInterval(loadPresets, 15000);
    return () => [a, b].forEach(clearInterval);
  }, [user, refresh, loadPresets]);

  if (user === undefined) return <div className="login-wrap muted">{t('Loading…')}</div>;
  if (!user) return <Login onLogin={setUser} />;

  const admin = user.role === 'admin';
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  };
  const go = (key) => {
    if (CREATE_TABS.includes(key)) store.set('gp_kind', key);
    location.hash = key;
    setTab(key);
  };

  // Job actions shared by the studios and the library
  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      alert(e.message);
    }
    refresh({ force: true });
  };
  const actions = {
    canManage: (job) => admin || job.user === user.username,
    onCancel: (job) => act(() => api(`/api/jobs/${job.id}/cancel`, { method: 'POST' })),
    onDelete: (job) => act(() => api(`/api/jobs/${job.id}`, { method: 'DELETE' })),
    onRetry: (job) => act(() => api(`/api/jobs/${job.id}/retry`, { method: 'POST' })),
    // "Edit and run again" fills the form of the job's kind, switching to it from the library
    onReuse: (job) => {
      setReuse({ ...job.params, _t: Date.now() });
      if (tab !== jobKind(job)) go(jobKind(job));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    // What to do next with a finished image: the result becomes the photo of a new task
    onFollowUp: async (job, index, kind, task) => {
      try {
        const { image } = await api(`/api/jobs/${job.id}/as-input`, { method: 'POST', json: { index } });
        setReuse({ kind, task, image, prompt: '', _t: Date.now() });
        if (tab !== kind) go(kind);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (e) {
        alert(e.message);
      }
    },
    // An audio result becomes the soundtrack of the video form
    onSoundtrack: async (job, index) => {
      const { audio } = await api(`/api/jobs/${job.id}/as-input`, { method: 'POST', json: { index } });
      setReuse({ kind: 'video', soundOnly: true, audio, _t: Date.now() });
      if (tab !== 'video') go('video');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    onUpscale: async (job, index) => {
      await api(`/api/jobs/${job.id}/upscale`, { method: 'POST', json: { index } });
      refresh({ force: true });
    },
  };

  // One notice at a time, the most important first
  const banner = !online ? { cls: 'fail', text: t('no connection to the server') }
    : worker && !worker.online ? { cls: 'warn', text: t('The generation engine is restarting or unavailable. Queued jobs are kept and continue when it is back.') }
      : admin && health?.status === 'fail' && tab !== 'system' ? { cls: 'fail', text: t('The system check found problems — generation may not work.'), action: () => go('system'), label: t('Open the system check') }
        : worker?.draining ? { cls: 'info', text: t('The generation engine will be updated after the current job. New jobs wait in the queue.') }
          : null;
  const creating = CREATE_TABS.includes(tab);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo />
          <div className="brand-name">GenAI Platform</div>
        </div>
        <nav className="nav" aria-label={t('Sections')}>
          <button className={`nav-tab ${creating ? 'on' : ''}`} onClick={() => go(store.get('gp_kind', 'image'))}><Icon name="create" /> {t('Create')}</button>
          <button className={`nav-tab ${tab === 'gallery' ? 'on' : ''}`} onClick={() => go('gallery')}><Icon name="gallery" /> {t('Library')}</button>
        </nav>
        <div className="top-right">
          <StatusPill jobs={jobs} system={system} online={online} skew={skew.current} onOpen={() => setQueueOpen(true)} />
          {admin && <AdminMenu tab={tab} go={go} health={health} />}
          <UserMenu user={user} onLogout={logout} />
        </div>
      </header>

      {banner && (
        <div className={`banner ${banner.cls}`}>
          <span>{banner.text}</span>
          {banner.action && <button className="btn btn-small" onClick={banner.action}>{banner.label}</button>}
        </div>
      )}

      {setup?.needed && !setupSkipped && creating ? (
        <Setup
          user={user}
          info={setup}
          onStarted={() => { setSetupSkipped(true); loadPresets(); go('models'); }}
          onSkip={() => { setSetupSkipped(true); store.set('gp_setup_later', '1'); }}
        />
      ) : creating && (
        <Studio
          kind={tab}
          setKind={go}
          user={user}
          jobs={jobs}
          presets={presets.filter((p) => (p.kind || 'video') === tab)}
          templates={templates ? templates[tab] || [] : undefined}
          system={system}
          skew={skew.current}
          refresh={refresh}
          reloadPresets={loadPresets}
          goModels={() => go('models')}
          reuse={reuse}
          onReuseApplied={() => setReuse(null)}
          actions={actions}
          goGallery={() => go('gallery')}
          openQueue={() => setQueueOpen(true)}
        />
      )}
      {tab === 'gallery' && <GalleryPage user={user} jobs={jobs} {...actions} />}
      {tab === 'models' && admin && <Models user={user} onChange={loadPresets} />}
      {tab === 'users' && admin && <Users me={user} />}
      {tab === 'system' && admin && <System system={system} online={online} />}
      {tab === 'settings' && admin && <Settings />}

      {queueOpen && (
        <QueueDrawer jobs={jobs} skew={skew.current} system={system} onClose={() => setQueueOpen(false)} onCancel={actions.onCancel} canManage={actions.canManage} />
      )}
    </div>
  );
}
