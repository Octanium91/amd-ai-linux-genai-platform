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

const TABS = [
  { key: 'video', label: 'Video' },
  { key: 'image', label: 'Images' },
  { key: 'models', label: 'Models' },
  { key: 'users', label: 'Users', admin: true },
];

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
      <div className="sys-item" title={t('GPU memory (GTT), allocated from the shared system RAM')}>
        <span className="sys-label">GTT</span>
        <Meter value={gttPct} />
        <span className="sys-val">{fmtBytes(system.gttUsed)} / {fmtBytes(system.gttTotal)}</span>
      </div>
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
  const tabs = TABS.filter((x) => !x.admin || user.role === 'admin');

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
        <nav className="nav">
          {tabs.map((x) => (
            <button key={x.key} className={`nav-tab ${tab === x.key ? 'on' : ''}`} onClick={() => go(x.key)}>{t(x.label)}</button>
          ))}
        </nav>
        <div className="top-right">
          <SystemBar system={system} online={online} />
          <UserMenu user={user} onLogout={logout} />
        </div>
      </header>

      {setup?.needed && !setupSkipped && tab !== 'users' && tab !== 'models' ? (
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
          now={now + skew.current}
          refresh={refresh}
          reloadPresets={loadPresets}
          goModels={() => go('models')}
        />
      )}
      {tab === 'models' && <Models user={user} onChange={loadPresets} />}
      {tab === 'users' && user.role === 'admin' && <Users me={user} />}
    </div>
  );
}
