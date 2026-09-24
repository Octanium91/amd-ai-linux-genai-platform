import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtBytes, setUnauthorizedHandler } from './util.js';
import { Logo } from './Logo.jsx';
import Login from './Login.jsx';
import Studio from './Studio.jsx';
import Models from './Models.jsx';
import Users, { ChangePassword } from './Users.jsx';

export { Logo };

const TABS = [
  { key: 'video', label: 'Видео' },
  { key: 'image', label: 'Изображения' },
  { key: 'models', label: 'Модели' },
  { key: 'users', label: 'Пользователи', admin: true },
];

function readTab() {
  const t = location.hash.replace('#', '');
  return TABS.some((x) => x.key === t) ? t : 'video';
}

function SystemBar({ system, online }) {
  if (!online) return <div className="sys"><span className="dot bad" /> нет связи с сервером</div>;
  if (!system) return null;
  const pct = (a, b) => (b ? (a / b) * 100 : 0);
  const gttPct = pct(system.gttUsed, system.gttTotal);
  const ramPct = pct(system.memTotal - system.memAvailable, system.memTotal);
  const st = system.storage || {};
  const disk = st.models || st.data;
  const diskPct = disk ? pct(disk.total - disk.free, disk.total) : 0;
  const diskTitle = [
    st.models && `Диск с моделями: свободно ${fmtBytes(st.models.free)} из ${fmtBytes(st.models.total)}; модели занимают ${fmtBytes(st.models.used)}`,
    st.data && (st.data.sameDisk
      ? `Результаты на том же диске: ${fmtBytes(st.data.used)}`
      : `Диск с результатами: свободно ${fmtBytes(st.data.free)} из ${fmtBytes(st.data.total)}; результаты занимают ${fmtBytes(st.data.used)}`),
  ].filter(Boolean).join('\n');
  const hw = [system.family, system.gpu?.replace(/\s*\(RADV.*\)/, '')].filter(Boolean).join(' · ');
  const Meter = ({ value }) => (
    <div className="meter"><div style={{ width: value + '%' }} className={value > 90 ? 'hot' : ''} /></div>
  );
  return (
    <div className="sys">
      {hw && <div className="sys-item sys-hw" title={`${system.cpu || ''}\n${system.driver || ''}`}>{hw}</div>}
      <div className="sys-item" title={`Загрузка процессора${system.cpu ? `\n${system.cpu}` : ''}${system.threads ? `, ${system.threads} потоков` : ''}`}>
        <span className="sys-label">CPU</span><span className="sys-val">{system.cpuBusy ?? '—'}%</span>
      </div>
      <div className="sys-item" title="Загрузка iGPU"><span className="sys-label">GPU</span><span className="sys-val">{system.gpuBusy ?? '—'}%</span></div>
      <div className="sys-item" title="Память GPU (GTT) — выделяется из общей оперативной памяти">
        <span className="sys-label">GTT</span>
        <Meter value={gttPct} />
        <span className="sys-val">{fmtBytes(system.gttUsed)} / {fmtBytes(system.gttTotal)}</span>
      </div>
      <div className="sys-item" title={`Оперативная память: занято ${fmtBytes(system.memTotal - system.memAvailable)} из ${fmtBytes(system.memTotal)}`}>
        <span className="sys-label">RAM</span>
        <Meter value={ramPct} />
        <span className="sys-val">{fmtBytes(system.memAvailable)} своб.</span>
      </div>
      {disk && (
        <div className="sys-item" title={diskTitle}>
          <span className="sys-label">Диск</span>
          <Meter value={diskPct} />
          <span className="sys-val">{fmtBytes(disk.free)} своб.</span>
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
          <button onClick={() => { setPwd(true); setOpen(false); }}>Сменить пароль</button>
          <button onClick={onLogout}>Выйти</button>
        </div>
      )}
      {pwd && <ChangePassword onClose={() => setPwd(false)} />}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined — проверяем сессию, null — не вошли
  const [tab, setTab] = useState(readTab);
  const [jobs, setJobs] = useState([]);
  const [system, setSystem] = useState(null);
  const [presets, setPresets] = useState([]);
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
      if (!/Требуется вход/.test(e.message)) setOnline(false);
    }
  }, []);
  const loadPresets = useCallback(() => api('/api/presets').then(setPresets).catch(() => {}), []);

  useEffect(() => {
    if (!user) return;
    refresh();
    loadPresets();
    const a = setInterval(refresh, 2000);
    const b = setInterval(loadPresets, 15000);
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => [a, b, c].forEach(clearInterval);
  }, [user, refresh, loadPresets]);

  if (user === undefined) return <div className="login-wrap muted">Загрузка…</div>;
  if (!user) return <Login onLogin={setUser} />;

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  };
  const go = (key) => {
    location.hash = key;
    setTab(key);
  };
  const tabs = TABS.filter((t) => !t.admin || user.role === 'admin');

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
          {tabs.map((t) => (
            <button key={t.key} className={`nav-tab ${tab === t.key ? 'on' : ''}`} onClick={() => go(t.key)}>{t.label}</button>
          ))}
        </nav>
        <div className="top-right">
          <SystemBar system={system} online={online} />
          <UserMenu user={user} onLogout={logout} />
        </div>
      </header>

      {(tab === 'video' || tab === 'image') && (
        <Studio
          kind={tab}
          user={user}
          jobs={jobs}
          presets={presets.filter((p) => (p.kind || 'video') === tab)}
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
