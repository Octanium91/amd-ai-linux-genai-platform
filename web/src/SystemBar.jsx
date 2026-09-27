import { fmtBytes } from './util.js';
import { t } from './i18n.js';

// Hardware at a glance: CPU, GPU, memory and storage with load, clocks and temperatures, as the
// worker samples them. Shown on the System page; the header only carries a compact status pill.
export default function SystemBar({ system, online }) {
  if (!online) return <div className="sysbar"><div className="sys-offline"><span className="dot bad" /> {t('no connection to the server')}</div></div>;
  if (!system) return null;
  const pct = (a, b) => (b ? (a / b) * 100 : 0);
  const ghz = (mhz) => (mhz ? t('{n} GHz', { n: (mhz / 1000).toFixed(2) }) : null);
  const st = system.storage || {};
  // Full memory or disk is a warning; a fully loaded CPU or GPU is simply working
  const Meter = ({ value, load }) => (
    <div className="meter"><div style={{ width: Math.min(100, value) + '%' }} className={load ? '' : value >= 98 ? 'crit' : value > 90 ? 'hot' : ''} /></div>
  );
  const Temp = ({ value, title }) => (value == null ? null : (
    <span className={`sys-temp ${value >= 90 ? 'bad' : value >= 80 ? 'warn' : ''}`} title={title}>{Math.round(value)} °C</span>
  ));
  const Row = ({ label, meter, load, children, title }) => (
    // Three grid cells per row, so the labels, meters and values line up within a block
    <div className="sys-row" title={title}>
      <span className="sys-label">{label}</span>
      {meter != null ? <Meter value={meter} load={load} /> : <span />}
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
      <div className="sys-rows">{children}</div>
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
      label={label || t('Used')}
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
          label={t('Load')}
          meter={system.cpuBusy ?? 0}
          load
          title={join(t('CPU load'), system.cpuMaxMhz && t('average core clock; up to {max}', { max: ghz(system.cpuMaxMhz) }),
            system.cpuLimitMhz && t('clock limit set by the firmware now: {limit}', { limit: ghz(system.cpuLimitMhz) }))}
        >
          {join(`${system.cpuBusy ?? '—'}%`, ghz(system.cpuMhz))}
        </Row>
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
          label={t('Load')}
          meter={system.gpuBusy ?? 0}
          load
          title={join(t('iGPU load'), system.gpuMaxMhz && t('shader clock; up to {max}', { max: ghz(system.gpuMaxMhz) }),
            system.powerW != null && t('power of the whole APU package'),
            system.gpuLimitMhz && t('clock limit set by the firmware now: {limit}', { limit: ghz(system.gpuLimitMhz) }))}
        >
          {join(`${system.gpuBusy ?? '—'}%`, ghz(system.gpuMhz), system.powerW != null && `${system.powerW} W`)}
          {capped(system.gpuLimitMhz, system.gpuMaxMhz) && <span className="warn"> · {t('limit {v}', { v: ghz(system.gpuLimitMhz) })}</span>}
        </Row>
        {system.vramTotal > 0 && (
          <Row label="VRAM" meter={pct(system.vramUsed, system.vramTotal)} title={t('Dedicated GPU memory (VRAM): the UMA carve-out reserved in the BIOS')}>
            {fmtBytes(system.vramUsed)} / {fmtBytes(system.vramTotal)}
          </Row>
        )}
        {system.gttTotal > 0 && (
          <Row
            label="GTT"
            meter={pct(system.gttUsed, system.gttTotal)}
            title={t('GPU memory (GTT), allocated from the shared system RAM')}
          >
            {fmtBytes(system.gttUsed)} / {fmtBytes(system.gttTotal)}
          </Row>
        )}
      </Block>
      <Block name="RAM" temp={system.memTemp} tempTitle={t('Memory module temperature (the hottest one)')}>
        <Row
          label={t('Used')}
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
