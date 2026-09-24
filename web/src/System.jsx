import { useCallback, useEffect, useState } from 'react';
import { api, fmtBytes, fmtDate } from './util.js';
import { t } from './i18n.js';

// Texts and advice for every server-side check (server/src/diagnostics.js reports only ids, statuses and values)
const CHECKS = {
  worker: {
    title: 'Generation engine link',
    text: (s, p) => {
      if (s === 'ok') return t('The web server is connected to the generation engine (worker API v{api}).', p);
      if (s === 'warn') return t('The generation engine speaks API v{api}, the web server expects v{expected}.', p);
      return t('The generation engine (the worker container) is not reachable. The checks below need it.');
    },
    advice: (p, s) => (s === 'warn'
      ? { text: t('Update both containers:'), commands: ['./scripts/update.sh'] }
      : { text: t('Check that the worker container is running and look at its log:'), commands: ['docker compose ps', 'docker compose logs --tail 50 worker', 'docker compose up -d worker'] }),
  },
  gpu: {
    title: 'GPU (Vulkan)',
    text: (s, p) => {
      if (s === 'ok') return t('Vulkan uses {gpu} ({driver}).', p);
      if (s === 'warn') return t('Vulkan uses {gpu} with the {driver} driver, not RADV. The platform is tested with Mesa RADV only.', p);
      if (p.reason === 'llvmpipe') return t('Vulkan only sees the software renderer (llvmpipe): generation cannot use the GPU.');
      return t('Vulkan does not work in the container.');
    },
    advice: () => ({
      text: t('Check that /dev/dri is passed to the container and that RENDER_GID/VIDEO_GID in .env match the host groups (setup.sh fills them in). On the host, install mesa-vulkan-drivers and firmware-amd-graphics, then recreate the container.'),
      commands: ['./scripts/setup.sh --install', 'getent group render video', 'docker compose up -d --force-recreate worker'],
    }),
  },
  'render-node': {
    title: 'Render node',
    text: (s, p) => (s === 'ok'
      ? t('{node} is accessible.', p)
      : p.reason === 'missing' ? t('{node} is not present in the container.', p) : t('No permission to open {node}.', p)),
    advice: (p) => (p.reason === 'missing'
      ? {
        text: t('The amdgpu driver is not loaded on the host, or /dev/dri is not passed through (devices: in docker-compose.yml).'),
        commands: ['ls -l /dev/dri', 'lsmod | grep amdgpu'],
      }
      : {
        text: t('RENDER_GID in .env must be the numeric GID of the host render group.'),
        commands: ['getent group render', './scripts/setup.sh', 'docker compose up -d --force-recreate worker'],
      }),
  },
  cpu: {
    title: 'Processor',
    text: (s, p) => {
      if (s === 'ok') return t('{cpu} — {family}.', p);
      if (p.reason === 'amd-other') return t('{cpu} is not a Ryzen AI APU. The platform may work, but it is tuned and measured for Ryzen AI.', p);
      return t('{cpu} is not an AMD processor. The platform targets AMD Ryzen AI with Radeon graphics; other hardware is untested.', p);
    },
  },
  'gpu-arch': {
    title: 'GPU architecture',
    text: (s, p) => (s === 'ok'
      ? t('{arch} (RDNA 3.5).', p)
      : t('{arch} is not RDNA 3.5 (gfx115x). It may work, but modes and timings are tuned for Ryzen AI graphics.', p)),
  },
  kernel: {
    title: 'Kernel',
    text: (s, p) => (s === 'ok' ? t('Kernel {kernel}.', p) : t('Kernel {kernel} is older than 6.10; RDNA 3.5 graphics may be unstable.', p)),
    advice: () => ({ text: t('Update the kernel to 6.12 or newer (on Debian 12 — from backports).') }),
  },
  gtt: {
    title: 'GPU memory (GTT)',
    text: (s, p) => {
      if (p.reason === 'unknown') return t('Could not read the GTT size (no amdgpu sysfs).');
      const v = { gtt: fmtBytes(p.gtt), ram: fmtBytes(p.ram), rec: p.recommendedGb };
      return s === 'ok'
        ? t('{gtt} of {ram} RAM is available to the GPU.', v)
        : t('Only {gtt} of {ram} RAM is available to the GPU; video models need more. Recommended: about {rec} GB (¾ of RAM).', v);
    },
    advice: (p) => (p.reason === 'unknown' ? null : {
      text: t('Add one of these kernel parameters to GRUB_CMDLINE_LINUX_DEFAULT in /etc/default/grub, then update GRUB and reboot:'),
      commands: [`amdgpu.gttsize=${p.gttsizeMiB}`, `ttm.pages_limit=${p.ttmPages} ttm.page_pool_size=${p.ttmPages}`, 'sudo update-grub && sudo reboot'],
    }),
  },
  'vulkan-heap': {
    title: 'Vulkan memory heap',
    text: (s, p) => {
      if (p.reason === 'unknown') return t('Could not read the Vulkan memory heaps.');
      return s === 'ok'
        ? t('The unified heap is active: {heap} available to Vulkan.', { heap: fmtBytes(p.heap) })
        : t('Vulkan offers only {heap} of the {gtt} GTT: the unified heap is not active, large models will run out of memory.', { heap: fmtBytes(p.heap), gtt: fmtBytes(p.gtt) });
    },
    advice: () => ({
      text: t('Make sure docker-compose.yml sets radv_enable_unified_heap_on_apu=true and mounts config/drirc, then recreate the container.'),
      commands: ['docker compose up -d --force-recreate worker', './scripts/check-gpu.sh'],
    }),
  },
  'video-memory': {
    title: 'Memory for heavy video models',
    text: (s, p) => (s === 'ok'
      ? t('Enough GTT for every mode, including Wan 2.2 (~{need} GB).', { need: p.needGb })
      : t('Wan 2.2 needs about {need} GB of GTT; this system has {gtt}. AnimateLCM, AnimateDiff and images work fine.', { need: p.needGb, gtt: fmtBytes(p.gtt) })),
  },
  swap: {
    title: 'Swap',
    text: (s, p) => (s === 'ok'
      ? t('{swap} of swap.', { swap: fmtBytes(p.swap) })
      : t('No swap. GTT and RAM are the same memory, so swap or zram protects against the OOM killer during heavy generations.')),
    advice: () => ({ text: t('For example, enable zram:'), commands: ['sudo apt install zram-tools'] }),
  },
  disk: {
    title: 'Disk space for models',
    text: (s, p) => {
      if (p.reason === 'unknown') return t('Could not read the free space of the models directory.');
      const v = { free: fmtBytes(p.free), total: fmtBytes(p.total) };
      if (s === 'ok') return t('{free} free of {total}.', v);
      if (s === 'warn') return t('{free} free — enough for a few models only.', v);
      return t('Only {free} free — model downloads will fail.', v);
    },
    advice: () => ({ text: t('Free up space or point MODELS_PATH in .env to a larger disk.') }),
  },
  engine: {
    title: 'Generation engine',
    text: (s, p) => (s === 'ok' ? p.version : t('sd-cli does not start in the container.')),
    advice: () => ({ text: t('Rebuild the image:'), commands: ['docker compose build --no-cache worker && ./scripts/update.sh'] }),
  },
  ffmpeg: {
    title: 'ffmpeg',
    text: (s, p) => (s === 'ok' ? p.version : t('ffmpeg is missing: videos cannot be assembled.')),
    advice: () => ({ text: t('Rebuild the image:'), commands: ['docker compose build --no-cache worker && ./scripts/update.sh'] }),
  },
  npu: {
    title: 'NPU (XDNA)',
    text: (s, p) => {
      if (!p.present) return t('No XDNA NPU detected.');
      if (p.driver) return t('An XDNA NPU and its driver are present; the platform does not use the NPU yet.');
      return t('An XDNA NPU is present but not used: Linux has no NPU runtime for diffusion video models yet (see docs/hardware.md).');
    },
  },
};

const STATUS = { ok: 'OK', warn: 'Warning', fail: 'Problem', info: 'Info' };

function CopyCommand({ cmd }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(cmd).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="cmd">
      <code>{cmd}</code>
      <button type="button" className="btn-icon" title={t('Copy')} onClick={copy}>{done ? '✓' : '⧉'}</button>
    </div>
  );
}

export default function System() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (refresh) => {
    setBusy(true);
    try {
      setData(await api(`/api/diagnostics${refresh ? '?refresh=1' : ''}`));
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { load(false); }, [load]);

  const summary = data && {
    ok: t('Everything is fine.'),
    warn: t('There are warnings — the platform works, but not at its best.'),
    fail: t('There are problems — generation may not work.'),
  }[data.status];

  return (
    <main className="page">
      <div className="card">
        <div className="gal-head">
          <h2>{t('System check')}</h2>
          <button className="btn" disabled={busy} onClick={() => load(true)}>{busy ? t('Checking…') : t('Check again')}</button>
        </div>
        {data && (
          <p className={`sys-summary ${data.status}`}>
            <span className={`pill ${data.status === 'ok' ? 'installed' : data.status === 'warn' ? 'queued' : 'error'}`}>{t(STATUS[data.status])}</span>{' '}
            {summary} <span className="muted small">{t('Checked at {time}', { time: fmtDate(data.at) })}</span>
          </p>
        )}
        {error && <div className="error">{error}</div>}
      </div>
      {data && (
        <div className="card">
          <div className="checks">
            {data.checks.map((c) => {
              const def = CHECKS[c.id];
              if (!def) return null;
              const advice = c.status !== 'ok' && def.advice ? def.advice(c.params, c.status) : null;
              return (
                <div key={c.id} className={`check ${c.status}`}>
                  <span className={`check-dot ${c.status}`} aria-hidden="true" />
                  <div className="check-body">
                    <div className="check-head">
                      <span className="check-title">{t(def.title)}</span>
                      <span className={`pill ${c.status === 'ok' ? 'installed' : c.status === 'fail' ? 'error' : c.status === 'warn' ? 'queued' : ''}`}>{t(STATUS[c.status])}</span>
                    </div>
                    <div className="small">{def.text(c.status, c.params)}</div>
                    {advice && (
                      <div className="advice">
                        <div className="small">{advice.text}</div>
                        {advice.commands?.map((cmd) => <CopyCommand key={cmd} cmd={cmd} />)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </main>
  );
}
