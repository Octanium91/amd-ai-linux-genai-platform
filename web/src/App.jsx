import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtBytes, setUnauthorizedHandler } from './util.js';
import { t, useLang } from './i18n.js';
import { LangSwitch } from './LangSwitch.jsx';
import { Logo } from './Logo.jsx';
import Login from './Login.jsx';
import Studio from './Studio.jsx';
import Models from './Models.jsx';
import Users, { ChangePassword } from './Users.jsx';
import Setup from './Setup.jsx';
import System from './System.jsx';

// Content generation sections (one per content kind) and platform management sections are separate groups
const GEN_TABS = [
  { key: 'video', label: 'Video' },
  { key: 'image', label: 'Images' },
];
const ADMIN_TABS = [
  { key: 'models', label: 'Models', icon: 'models' },
  { key: 'users', label: 'Users', icon: 'users', admin: true },
  { key: 'system', label: 'System', icon: 'system', admin: true },
];
const TABS = [...GEN_TABS, ...ADMIN_TABS];

const ICONS = {
  models: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3L18.7 8 12 11.7 5.3 8 12 4.3ZM5 9.7l6 3.3v6.7l-6-3.3V9.7Zm8 10V13l6-3.3v6.7l-6 3.3Z',
  system: 'M3 12h4l2-6 4 12 2-6h6v-2h-4.6L15 4.5 11 16.8 9 10.5 8.3 10H3v2Z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7.5 6a3.5 3.5 0 1 0 0-7 1 1 0 0 0 0 2 1.5 1.5 0 1 1 0 3 1 1 0 0 0 0 2ZM9 13c-3.9 0-7 2-7 4.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5C16 15 12.9 13 9 13Zm5 6H4v-1.5c0-1.2 2.1-2.5 5-2.5s5 1.3 5 2.5V19Zm3-5.8a1 1 0 0 0-.4 1.9c1.4.6 2.4 1.5 2.4 2.4V19h-1a1 1 0 0 0 0 2h2a1 1 0 0 0 1-1v-2.5c0-1.9-1.6-3.5-4-4.3Z',
};
const Icon = ({ name }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d={ICONS[name]} fill="currentColor" /></svg>
);

function readTab() {
  const tab = location.hash.replace('#', '');
  return TABS.some((x) => x.key === tab) ? tab : 'video';
}

function SystemBar({ system, online }) {
  if (!online) return <div className="sys"><span className="dot bad" /> {t('no connection to the server')}</div>;
  if (!system) return null;
  const pct = (a, b) => (b ? (a / b) * 100 : 0);
  const gttPct = pct(system.gttUsed, system.gttTotal);
  const ramPct = pct(system.memTotal - system.memAvailable, system.memTotal);
  const st = system.storage || {};
  const disk = st.models || st.data;
  const diskPct = disk ? pct(disk.total - disk.free, disk.total) : 0;
  const diskTitle = [
    st.models && t('Models disk: {free} free of {total}; models take {used}', {
      free: fmtBytes(st.models.free), total: fmtBytes(st.models.total), used: fmtBytes(st.models.used),
    }),
    st.data && (st.data.sameDisk
      ? t('Results on the same disk: {used}', { used: fmtBytes(st.data.used) })
      : t('Results disk: {free} free of {total}; results take {used}', {
        free: fmtBytes(st.data.free), total: fmtBytes(st.data.total), used: fmtBytes(st.data.used),
      })),
  ].filter(Boolean).join('\n');
  const hw = [system.family, system.gpu?.replace(/\s*\(RADV.*\)/, '')].filter(Boolean).join(' · ');
  const Meter = ({ value }) => (
    <div className="meter"><div style={{ width: value + '%' }} className={value > 90 ? 'hot' : ''} /></div>
  );
  return (
    <div className="sys">
      {hw && <div className="sys-item sys-hw" title={`${system.cpu || ''}\n${system.driver || ''}`}>{hw}</div>}
      <div className="sys-item" title={[t('CPU load'), system.cpu, system.threads && t('{n} threads', { n: system.threads })].filter(Boolean).join('\n')}>
        <span className="sys-label">CPU</span><span className="sys-val">{system.cpuBusy ?? '—'}%</span>
      </div>
      <div className="sys-item" title={t('iGPU load')}><span className="sys-label">GPU</span><span className="sys-val">{system.gpuBusy ?? '—'}%</span></div>
      {system.vramTotal > 0 && (
        <div className="sys-item" title={t('Dedicated GPU memory (VRAM): the UMA carve-out reserved in the BIOS')}>
          <span className="sys-label">VRAM</span>
          <Meter value={pct(system.vramUsed, system.vramTotal)} />
          <span className="sys-val">{fmtBytes(system.vramUsed)} / {fmtBytes(system.vramTotal)}</span>
        </div>
      )}
      {system.gttTotal > 0 && (
        <div className="sys-item" title={t('GPU memory (GTT), allocated from the shared system RAM')}>
          <span className="sys-label">GTT</span>
          <Meter value={gttPct} />
          <span className="sys-val">{fmtBytes(system.gttUsed)} / {fmtBytes(system.gttTotal)}</span>
        </div>
      )}
      <div className="sys-item" title={t('RAM: {used} used of {total}', { used: fmtBytes(system.memTotal - system.memAvailable), total: fmtBytes(system.memTotal) })}>
        <span className="sys-label">RAM</span>
        <Meter value={ramPct} />
        <span className="sys-val">{t('{size} free', { size: fmtBytes(system.memAvailable) })}</span>
      </div>
      {disk && (
        <div className="sys-item" title={diskTitle}>
          <span className="sys-label">{t('Disk')}</span>
          <Meter value={diskPct} />
          <span className="sys-val">{t('{size} free', { size: fmtBytes(disk.free) })}</span>
        </div>
      )}
    </div>
  );
}

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const [pwd, setPwd] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
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
  const [setupSkipped, setSetupSkipped] = useState(false);
  const [online, setOnline] = useState(true);
  const [health, setHealth] = useState(null);
  const [worker, setWorker] = useState(null); // generation engine (worker container) status
  const [now, setNow] = useState(Date.now());
  const skew = useRef(0);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api('/api/auth/me').then(setUser).catch(() => setUser(null));
    const onHash = () => setTab(readTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api('/api/state');
      skew.current = s.now - Date.now();
      setJobs(s.jobs);
      setSystem(s.system);
      setHealth(s.health);
      setWorker(s.worker);
      setOnline(true);
    } catch (e) {
      if (e.status !== 401) setOnline(false);
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
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => [a, b, c].forEach(clearInterval);
  }, [user, refresh, loadPresets]);

  if (user === undefined) return <div className="login-wrap muted">{t('Loading…')}</div>;
  if (!user) return <Login onLogin={setUser} />;

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  };
  const go = (key) => {
    location.hash = key;
    setTab(key);
  };
  const adminTabs = ADMIN_TABS.filter((x) => !x.admin || user.role === 'admin');

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">GenAI Platform</div>
            <div className="brand-sub">AMD Ryzen AI · Linux · Vulkan</div>
          </div>
        </div>
        <nav className="nav" aria-label={t('Generation')}>
          {GEN_TABS.map((x) => (
            <button key={x.key} className={`nav-tab ${tab === x.key ? 'on' : ''}`} onClick={() => go(x.key)}>{t(x.label)}</button>
          ))}
        </nav>
        <nav className="nav-admin" aria-label={t('Management')}>
          {adminTabs.map((x) => (
            <button key={x.key} className={`nav-link ${tab === x.key ? 'on' : ''}`} onClick={() => go(x.key)} title={t(x.label)}>
              <Icon name={x.icon} /> <span>{t(x.label)}</span>
              {x.key === 'system' && health && health.status !== 'ok' && <span className={`nav-badge ${health.status}`} />}
            </button>
          ))}
        </nav>
        <div className="top-right">
          <SystemBar system={system} online={online} />
          <UserMenu user={user} onLogout={logout} />
        </div>
      </header>

      {online && worker && !worker.online && (
        <div className="banner warn">
          <span>{t('The generation engine is restarting or unavailable. Queued jobs are kept and continue when it is back.')}</span>
        </div>
      )}
      {worker?.online && worker.draining && (
        <div className="banner info">
          <span>{t('The generation engine will be updated after the current job. New jobs wait in the queue.')}</span>
        </div>
      )}

      {user.role === 'admin' && health?.status === 'fail' && worker?.online !== false && tab !== 'system' && (
        <div className="banner fail">
          <span>{t('The system check found problems — generation may not work.')}</span>
          <button className="btn" onClick={() => go('system')}>{t('Open the system check')}</button>
        </div>
      )}

      {setup?.needed && !setupSkipped && (tab === 'video' || tab === 'image') ? (
        <Setup
          user={user}
          info={setup}
          onStarted={() => { setSetupSkipped(true); loadPresets(); go('models'); }}
          onSkip={() => setSetupSkipped(true)}
        />
      ) : (tab === 'video' || tab === 'image') && (
        <Studio
          kind={tab}
          user={user}
          jobs={jobs}
          presets={presets.filter((p) => (p.kind || 'video') === tab)}
          templates={templates ? templates[tab] || [] : undefined}
          system={system}
          now={now + skew.current}
          refresh={refresh}
          reloadPresets={loadPresets}
          goModels={() => go('models')}
        />
      )}
      {tab === 'models' && <Models user={user} onChange={loadPresets} />}
      {tab === 'users' && user.role === 'admin' && <Users me={user} />}
      {tab === 'system' && user.role === 'admin' && <System />}
    </div>
  );
}
