import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtBytes, jobKind, setUnauthorizedHandler } from './util.js';
import { t, useLang } from './i18n.js';
import { LangSwitch } from './LangSwitch.jsx';
import { Logo } from './Logo.jsx';
import Login from './Login.jsx';
import Studio from './Studio.jsx';
import GalleryPage from './GalleryPage.jsx';
import Models from './Models.jsx';
import Users, { ChangePassword } from './Users.jsx';
import Setup from './Setup.jsx';
import System from './System.jsx';
import Settings from './Settings.jsx';

// Three separate groups: what can be generated (one section per content kind), the gallery of
// everything generated, and platform management
const GEN_TABS = [
  { key: 'video', label: 'Video' },
  { key: 'image', label: 'Images' },
];
const LIBRARY_TABS = [{ key: 'gallery', label: 'Gallery', icon: 'gallery' }];
const ADMIN_TABS = [
  { key: 'models', label: 'Models', icon: 'models' },
  { key: 'users', label: 'Users', icon: 'users', admin: true },
  { key: 'system', label: 'System', icon: 'system', admin: true },
  { key: 'settings', label: 'Settings', icon: 'settings', admin: true },
];
const TABS = [...GEN_TABS, ...LIBRARY_TABS, ...ADMIN_TABS];

const ICONS = {
  settings: 'M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.4 2.5h4l.4-2.5c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6ZM13 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z',
  gallery: 'M4 4h7v7H4V4Zm2 2v3h3V6H6Zm7-2h7v7h-7V4Zm2 2v3h3V6h-3ZM4 13h7v7H4v-7Zm2 2v3h3v-3H6Zm7-2h7v7h-7v-7Zm2 2v3h3v-3h-3Z',
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
  if (!online) return <div className="sysbar"><div className="sys-offline"><span className="dot bad" /> {t('no connection to the server')}</div></div>;
  if (!system) return null;
  const pct = (a, b) => (b ? (a / b) * 100 : 0);
  const ghz = (mhz) => (mhz ? t('{n} GHz', { n: (mhz / 1000).toFixed(2) }) : null);
  const st = system.storage || {};
  const Meter = ({ value }) => (
    <div className="meter"><div style={{ width: Math.min(100, value) + '%' }} className={value > 90 ? 'hot' : ''} /></div>
  );
  const Temp = ({ value, title }) => (value == null ? null : (
    <span className={`sys-temp ${value >= 90 ? 'bad' : value >= 80 ? 'warn' : ''}`} title={title}>{Math.round(value)} °C</span>
  ));
  const Row = ({ label, meter, children, title }) => (
    <div className="sys-row" title={title}>
      {label && <span className="sys-label">{label}</span>}
      {meter != null && <Meter value={meter} />}
      <span className="sys-val">{children}</span>
    </div>
  );
  const Block = ({ name, sub, temp, tempTitle, title, badge, children }) => (
    <div className={`sys-block ${badge?.hot ? 'throttled' : ''}`} title={title}>
      <div className="sys-head">
        <span className="sys-name">{name}</span>
        {sub && <span className="sys-sub">{sub}</span>}
        {badge && <span className={`sys-badge ${badge.hot ? 'bad' : ''}`} title={badge.title}>{badge.text}</span>}
        <Temp value={temp} title={tempTitle} />
      </div>
      {children}
    </div>
  );
  const join = (...parts) => parts.filter(Boolean).join(' · ');
  // Both names come from the hardware: the GPU's from the driver (libdrm or Vulkan) with the CU count
  // from the KFD topology, the CPU's from its brand string in /proc/cpuinfo
  const gpuName = join((system.gpuName || system.gpu?.replace(/\s*\(RADV.*\)/, ''))?.replace(/^AMD\s+/, ''),
    system.gpuCu && t('{n} CU', { n: system.gpuCu }));
  const cpuName = system.cpu?.replace(/^AMD\s+/, '').replace(/\s+w\/\s+Radeon.*$/i, '').replace(/\s+\S+-Core Processor$/i, '');
  // Throttling as the SMU firmware reports it (the last 30 s). Thermal reasons are overheating;
  // a power limit is the normal ceiling of a small machine and is shown quietly.
  const thermal = system.throttle?.thermal || [];
  const power = system.throttle?.power || [];
  const REASON = {
    prochot: t('PROCHOT (the platform asked the chip to slow down)'), thm_core: t('CPU cores too hot'), thm_gfx: t('GPU too hot'),
    thm_soc: t('SoC too hot'), spl: t('sustained power limit'), fppt: t('fast power limit'), sppt: t('slow power limit'),
  };
  const badgeFor = (hot) => {
    if (hot.length) return { hot: true, text: t('Throttling'), title: [t('Overheating: the firmware lowered the clocks.'), ...hot.map((r) => REASON[r])].join('\n') };
    return null;
  };
  const cpuBadge = badgeFor(thermal.filter((r) => ['prochot', 'thm_core', 'thm_soc'].includes(r)));
  const gpuBadge = badgeFor(thermal.filter((r) => ['prochot', 'thm_gfx', 'thm_soc'].includes(r)))
    || (power.length ? { text: t('Power limit'), title: [t('The clocks are capped by a power limit: normal for a small machine, not overheating.'), ...power.map((r) => REASON[r])].join('\n') } : null);
  // A GPU clock limit the firmware enforces below the maximum. Not shown for the CPU: on hybrid
  // Zen 5 / Zen 5c chips the core limit sits below the boost clock even at idle.
  const capped = (limit, max) => limit && max && limit < max * 0.97;
  const diskRow = (d, label, results) => d && (
    <Row
      label={label}
      meter={pct(d.total - d.free, d.total)}
      title={t(results ? 'Results disk: {free} free of {total}; results take {used}' : 'Models disk: {free} free of {total}; models take {used}', {
        free: fmtBytes(d.free), total: fmtBytes(d.total), used: fmtBytes(d.used),
      })}
    >
      {t('{size} free', { size: fmtBytes(d.free) })}
      {d.temp != null && st.data && !st.data.sameDisk && <> · <Temp value={d.temp} title={t('Disk temperature')} /></>}
    </Row>
  );
  const splitDisks = st.models && st.data && !st.data.sameDisk;
  return (
    <div className="sysbar">
      <Block
        name="CPU"
        sub={cpuName || system.family}
        badge={cpuBadge}
        temp={system.cpuTemp}
        tempTitle={t('CPU temperature (Tctl)')}
        title={join(system.cpu, system.family, system.threads && t('{n} threads', { n: system.threads }))}
      >
        <Row
          meter={system.cpuBusy ?? 0}
          title={join(t('CPU load'), system.cpuMaxMhz && t('average core clock; up to {max}', { max: ghz(system.cpuMaxMhz) }),
            system.cpuLimitMhz && t('clock limit set by the firmware now: {limit}', { limit: ghz(system.cpuLimitMhz) }))}
        >
          {join(`${system.cpuBusy ?? '—'}%`, ghz(system.cpuMhz))}        </Row>
      </Block>
      <Block
        name="GPU"
        sub={gpuName}
        badge={gpuBadge}
        temp={system.gpuTemp}
        tempTitle={join(t('GPU temperature (edge)'), system.socTemp != null && t('SoC {v} °C', { v: Math.round(system.socTemp) }))}
        title={join(system.gpu, system.gpuArch, system.driver)}
      >
        <Row
          meter={system.gpuBusy ?? 0}
          title={join(t('iGPU load'), system.gpuMaxMhz && t('shader clock; up to {max}', { max: ghz(system.gpuMaxMhz) }),
            system.powerW != null && t('power of the whole APU package'),
            system.gpuLimitMhz && t('clock limit set by the firmware now: {limit}', { limit: ghz(system.gpuLimitMhz) }))}
        >
          {join(`${system.gpuBusy ?? '—'}%`, ghz(system.gpuMhz), system.powerW != null && `${system.powerW} W`)}
          {capped(system.gpuLimitMhz, system.gpuMaxMhz) && <span className="warn"> · {t('limit {v}', { v: ghz(system.gpuLimitMhz) })}</span>}
        </Row>
        {system.gttTotal > 0 && (
          <Row
            label="GTT"
            meter={pct(system.gttUsed, system.gttTotal)}
            title={join(t('GPU memory (GTT), allocated from the shared system RAM'),
              system.vramTotal > 0 && `VRAM ${fmtBytes(system.vramUsed)} / ${fmtBytes(system.vramTotal)}: ${t('Dedicated GPU memory (VRAM): the UMA carve-out reserved in the BIOS')}`)}
          >
            {fmtBytes(system.gttUsed)} / {fmtBytes(system.gttTotal)}
          </Row>
        )}
        {!(system.gttTotal > 0) && system.vramTotal > 0 && (
          <Row label="VRAM" meter={pct(system.vramUsed, system.vramTotal)} title={t('Dedicated GPU memory (VRAM): the UMA carve-out reserved in the BIOS')}>
            {fmtBytes(system.vramUsed)} / {fmtBytes(system.vramTotal)}
          </Row>
        )}
      </Block>
      <Block name="RAM" temp={system.memTemp} tempTitle={t('Memory module temperature (the hottest one)')}>
        <Row
          meter={pct(system.memTotal - system.memAvailable, system.memTotal)}
          title={join(t('RAM: {used} used of {total}', { used: fmtBytes(system.memTotal - system.memAvailable), total: fmtBytes(system.memTotal) }),
            system.memMhz && t('memory clock {mclk} MHz, fabric clock {fclk} MHz (as reported by the GPU driver)', { mclk: system.memMhz, fclk: system.fabricMhz ?? '—' }))}
        >
          {join(t('{size} free', { size: fmtBytes(system.memAvailable) }), system.memMhz && `${system.memMhz} MHz`)}
        </Row>
      </Block>
      {(st.models || st.data) && (
        <Block
          name={t('Storage')}
          temp={splitDisks ? null : (st.models || st.data).temp}
          tempTitle={t('Disk temperature')}
        >
          {diskRow(st.models, splitDisks ? t('Models') : null, false)}
          {splitDisks && diskRow(st.data, t('Results'), true)}
          {!st.models && diskRow(st.data, null, true)}
        </Block>
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
  const [reuse, setReuse] = useState(null); // job parameters to fill the form with ("repeat")
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

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  };
  const go = (key) => {
    location.hash = key;
    setTab(key);
  };

  // Job actions shared by the studios and the gallery page
  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      alert(e.message);
    }
    refresh({ force: true });
  };
  const actions = {
    canManage: (job) => user.role === 'admin' || job.user === user.username,
    onCancel: (job) => act(() => api(`/api/jobs/${job.id}/cancel`, { method: 'POST' })),
    onDelete: (job) => act(() => api(`/api/jobs/${job.id}`, { method: 'DELETE' })),
    onRetry: (job) => act(() => api(`/api/jobs/${job.id}/retry`, { method: 'POST' })),
    // "Repeat" fills the form of the job's studio, switching to it from the gallery
    onReuse: (job) => {
      setReuse({ ...job.params, _t: Date.now() });
      if (tab !== jobKind(job)) go(jobKind(job));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  };
  const adminTabs = ADMIN_TABS.filter((x) => !x.admin || user.role === 'admin');
  const doneCount = jobs.filter((j) => j.status === 'done').length;

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
        <div className="nav-main">
          <nav className="nav" aria-label={t('Generation')}>
            {GEN_TABS.map((x) => (
              <button key={x.key} className={`nav-tab ${tab === x.key ? 'on' : ''}`} onClick={() => go(x.key)}>{t(x.label)}</button>
            ))}
          </nav>
          <nav className="nav" aria-label={t('Gallery')}>
            {LIBRARY_TABS.map((x) => (
              <button key={x.key} className={`nav-tab nav-tab-icon ${tab === x.key ? 'on' : ''}`} onClick={() => go(x.key)}>
                <Icon name={x.icon} /> {t(x.label)}
                {doneCount > 0 && <span className="nav-count">{doneCount}</span>}
              </button>
            ))}
          </nav>
        </div>
        <nav className="nav-admin" aria-label={t('Management')}>
          {adminTabs.map((x) => (
            <button key={x.key} className={`nav-link ${tab === x.key ? 'on' : ''}`} onClick={() => go(x.key)} title={t(x.label)}>
              <Icon name={x.icon} /> <span>{t(x.label)}</span>
              {x.key === 'system' && health && health.status !== 'ok' && <span className={`nav-badge ${health.status}`} />}
            </button>
          ))}
        </nav>
        <div className="top-right">
          <UserMenu user={user} onLogout={logout} />
        </div>
        <SystemBar system={system} online={online} />
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
          skew={skew.current}
          refresh={refresh}
          reloadPresets={loadPresets}
          goModels={() => go('models')}
          reuse={reuse}
          onReuseApplied={() => setReuse(null)}
          actions={actions}
          goGallery={() => go('gallery')}
        />
      )}
      {tab === 'gallery' && <GalleryPage user={user} jobs={jobs} {...actions} />}
      {tab === 'models' && <Models user={user} onChange={loadPresets} />}
      {tab === 'users' && user.role === 'admin' && <Users me={user} />}
      {tab === 'system' && user.role === 'admin' && <System />}
      {tab === 'settings' && user.role === 'admin' && <Settings />}
    </div>
  );
}
