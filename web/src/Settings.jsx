import { useCallback, useEffect, useState } from 'react';
import { api, fmtBytes, fmtDate } from './util.js';
import { t } from './i18n.js';

// Platform settings (administrators): the prompt assistant (an Ollama server) and generation
// telemetry — a JSON document per job written by the worker to data/telemetry; see docs/telemetry.md.
export default function Settings() {
  const [info, setInfo] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [anonymize, setAnonymize] = useState(true);
  const q = anonymize ? '?anonymize=1' : '';

  const load = useCallback(async () => {
    try {
      const d = await api('/api/telemetry');
      setInfo(d);
      setForm((f) => f || { enabled: d.settings.enabled, maxMb: d.settings.maxMb });
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setMsg('');
    setError('');
    try {
      const s = await api('/api/settings', { method: 'PUT', json: { telemetry: { enabled: form.enabled, maxMb: Number(form.maxMb) } } });
      setForm({ enabled: s.telemetry.enabled, maxMb: s.telemetry.maxMb });
      setMsg(t('Saved. The change applies from the next generation.'));
      load();
    } catch (err) {
      setError(err.message);
    }
  };
  const clear = async () => {
    if (!confirm(t('Delete all telemetry documents?'))) return;
    try {
      await api('/api/telemetry', { method: 'DELETE' });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!info || !form) return <main className="page"><div className="card muted">{error || t('Loading…')}</div></main>;
  const limit = info.settings.maxMb * 1024 * 1024;
  const pct = limit ? Math.min(100, (info.bytes / limit) * 100) : 0;

  return (
    <main className="page">
      <PromptAssistantSettings />
      <form className="card form" onSubmit={save}>
        <h3>{t('Generation telemetry')}</h3>
        <p className="muted">
          {t('When enabled, every generation writes a JSON document: the system at the start (OS, kernel, runtime, Docker or native, CPU, GPU, memory, board, drivers, clocks), the job with all its parameters, and hardware metrics during the run (CPU, GPU, memory, swap, clocks, power, temperatures) as averages per command and stage plus a compact time series.')}
        </p>
        <p className="muted">{t('The documents stay on this server in data/telemetry; nothing is sent anywhere. When the size limit is reached, the oldest documents are deleted.')}</p>
        <label className="checkbox">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          <span>{t('Collect generation telemetry')}</span>
        </label>
        <label className="field field-narrow">
          <span className="field-label">{t('Size limit, MB')}</span>
          <input type="number" min={10} max={100000} step={10} value={form.maxMb} onChange={(e) => setForm({ ...form, maxMb: e.target.value })} />
        </label>
        {error && <div className="error">{error}</div>}
        {msg && <div className="muted small">{msg}</div>}
        <div className="modal-actions">
          <button className="btn primary">{t('Save')}</button>
        </div>
      </form>

      <div className="card">
        <div className="gal-head">
          <h3>{t('Collected documents')} · {info.count}</h3>
          <div className="modal-actions">
            <a className={`btn ${info.count ? '' : 'disabled'}`} href={`/api/telemetry/export${q}`}>{t('Download all (JSON)')}</a>
            <button className="btn ghost danger" disabled={!info.count} onClick={clear}>{t('Delete all')}</button>
          </div>
        </div>
        <label className="checkbox checkbox-sm">
          <input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} />
          <span>{t('Anonymize downloads: remove prompts, user names, file names and disk IDs')}</span>
        </label>
        <div className="usage-row">
          <div className="meter meter-wide"><div style={{ width: pct + '%' }} className={pct > 90 ? 'hot' : ''} /></div>
          <span className="muted small">{t('{used} of {limit}', { used: fmtBytes(info.bytes), limit: fmtBytes(limit) })}</span>
        </div>
        {!info.count ? (
          <div className="muted empty">{info.settings.enabled ? t('Documents appear after the next generation.') : t('Telemetry is off.')}</div>
        ) : (
          <table className="users">
            <thead>
              <tr><th>{t('Document')}</th><th>{t('Size')}</th><th>{t('Updated')}</th><th /></tr>
            </thead>
            <tbody>
              {info.documents.map((d) => (
                <tr key={d.name}>
                  <td><code>{d.name}</code></td>
                  <td>{fmtBytes(d.size)}</td>
                  <td>{fmtDate(d.modifiedAt)}</td>
                  <td className="users-actions"><a className="btn" href={`/api/telemetry/${encodeURIComponent(d.name)}${q}`}>{t('Download')}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {info.count > info.documents.length && <div className="muted small">{t('The latest {n} are shown; "Download all" includes every document.', { n: info.documents.length })}</div>}
      </div>
    </main>
  );
}

// The prompt assistant ("Improve with AI"): an Ollama server and model that rewrite descriptions into prompts
const RECOMMENDED_MODELS = ['dolphin-llama3', 'huihui_ai/qwen2.5-abliterate:3b'];
// Where the model runs: the NPU through a FastFlowLM server, or the GPU / the processor through Ollama
const DEVICES = [
  { id: 'auto', label: 'Automatic' },
  { id: 'npu', label: 'NPU' },
  { id: 'gpu', label: 'GPU' },
  { id: 'cpu', label: 'CPU' },
];

function PromptAssistantSettings() {
  const [form, setForm] = useState(null);
  const [models, setModels] = useState(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  // The FastFlowLM server's models, and what the machine's NPU can do (from the system info)
  const [npuModels, setNpuModels] = useState(null);
  const [npuChecking, setNpuChecking] = useState(false);
  const [npu, setNpu] = useState(null);

  useEffect(() => {
    api('/api/settings').then((s) => setForm(s.promptAssistant)).catch((e) => setError(e.message));
    api('/api/state').then((s) => setNpu(s.system?.npu || { present: false })).catch(() => {});
  }, []);

  const checkNpu = async (url = form?.npuUrl) => {
    setNpuChecking(true);
    setError('');
    try {
      setNpuModels((await api(`/api/settings/npu?url=${encodeURIComponent(url)}`)).models);
    } catch (err) {
      setNpuModels(null);
      setError(err.message);
    } finally {
      setNpuChecking(false);
    }
  };

  const check = async (url = form?.url) => {
    setChecking(true);
    setError('');
    try {
      setModels(await api(`/api/settings/ollama?url=${encodeURIComponent(url)}`));
    } catch (err) {
      setModels(null);
      setError(err.message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (form?.enabled && form.device !== 'npu') check(form.url);
    if (form?.enabled && ['auto', 'npu'].includes(form.device || 'auto')) checkNpu(form.npuUrl);
  }, [form === null]);

  const save = async (e) => {
    e.preventDefault();
    setMsg('');
    setError('');
    try {
      const s = await api('/api/settings', { method: 'PUT', json: { promptAssistant: form } });
      setForm(s.promptAssistant);
      setMsg(t('Saved.'));
    } catch (err) {
      setError(err.message);
    }
  };

  if (!form) return <div className="card muted">{error || t('Loading…')}</div>;
  const installed = models?.models?.map((m) => m.name) || [];
  const has = (name) => installed.some((n) => n === name || n === `${name}:latest`);
  const missing = models && !has(form.model);
  const device = form.device || 'auto';
  const useNpu = device === 'auto' || device === 'npu';
  const useOllama = device !== 'npu';
  const npuUnusable = npu && !npu.llm;

  return (
    <form className="card form" onSubmit={save}>
      <h3>{t('Prompt assistant')}</h3>
      <p className="muted">
        {t('Adds an "Improve with AI" button to the prompt box: a language model on an Ollama server turns a short description in any language into a detailed English prompt written for the selected mode: tags for Stable Diffusion, sentences with motion and camera for Wan, a style caption for music and a sound description for effects.')}
      </p>
      <p className="muted">
        {t('Recommended: dolphin-llama3 (8B, 4.7 GB, the most accurate, 5–15 s per prompt) or huihui_ai/qwen2.5-abliterate:3b (1.9 GB, fast, 3–7 s, understands other languages, simpler wording). dolphin-phi often loses the meaning of non-English descriptions. Install on the Ollama server with:')}{' '}
        <code>ollama pull dolphin-llama3</code>
      </p>
      <p className="muted small">{t('If Ollama uses the same GPU, it takes GPU memory while it answers; the platform asks it to unload the model a minute after each request.')}</p>
      <label className="checkbox">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <span>{t('Enable the prompt assistant')}</span>
      </label>
      <div className="field">
        <span className="field-label">{t('Where the language model runs')}</span>
        <div className="seg" role="radiogroup" aria-label={t('Where the language model runs')}>
          {DEVICES.map((d) => (
            <button key={d.id} type="button" role="radio" aria-checked={device === d.id} className={`seg-item ${device === d.id ? 'on' : ''}`}
              style={{ flex: 1, justifyContent: 'center' }} onClick={() => setForm({ ...form, device: d.id })}>
              {t(d.label)}{d.id === 'npu' && <span className="muted small"> · {t('recommended')}</span>}{d.id === 'cpu' && <span className="muted small"> · {t('not recommended')}</span>}
            </button>
          ))}
        </div>
        <span className="field-hint">
          {device === 'npu' ? t('Recommended. The model runs on the NPU through a FastFlowLM server: it takes no GPU memory, keeps its speed while a generation runs and slows that generation the least.')
            : device === 'gpu' ? t('The model runs on the GPU through Ollama: the fastest answers, but it shares the GPU and its memory with the generations.')
              : device === 'cpu' ? t('Not recommended: the model runs on the processor through Ollama, slower than the GPU, and takes the processor from a running generation. Prefer the NPU.')
                : t('The NPU when its FastFlowLM server answers, the GPU (Ollama) otherwise.')}
        </span>
        {useNpu && npuUnusable && (
          <span className="field-hint warn">
            {device === 'npu' ? t('This machine has no NPU that can run language models now (see System): the assistant will not work on this setting.')
              : t('This machine has no NPU that can run language models now (see System): the GPU is used instead.')}
          </span>
        )}
      </div>
      {useNpu && (
        <>
          <label className="field">
            <span className="field-label">{t('FastFlowLM server address (NPU)')}</span>
            <div className="model-pick">
              <input value={form.npuUrl || ''} onChange={(e) => setForm({ ...form, npuUrl: e.target.value })} placeholder="http://host.docker.internal:52625" />
              <button type="button" className="btn" disabled={npuChecking} onClick={() => checkNpu()}>{npuChecking ? t('Checking…') : t('Check')}</button>
            </div>
            <span className="field-hint">{t('host.docker.internal is the machine the platform runs on (FastFlowLM on its default port 52625).')}</span>
          </label>
          {npuModels && <div className="muted small">{t('FastFlowLM answers: {n} models available.', { n: npuModels.length })}</div>}
          <label className="field">
            <span className="field-label">{t('Model on the NPU')}</span>
            <div className="model-pick">
              <input list="npu-models" value={form.npuModel || ''} onChange={(e) => setForm({ ...form, npuModel: e.target.value })} />
              <datalist id="npu-models">
                {(npuModels || []).map((n) => <option key={n} value={n} />)}
              </datalist>
            </div>
            <span className="field-hint">{t('A light model is enough and answers faster: qwen3:4b (3.1 GB, about 20 tokens per second on a Ryzen AI 9 HX 370). It writes both prompts and the scenes of long videos. FastFlowLM downloads a model on first use.')}</span>
            {npuModels && form.npuModel && !npuModels.includes(form.npuModel) && <span className="field-hint warn">{t('The FastFlowLM server does not list this model.')}</span>}
          </label>
        </>
      )}
      {useOllama && (
      <>
      <label className="field">
        <span className="field-label">{t('Ollama server address')}</span>
        <div className="model-pick">
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://host.docker.internal:11434" />
          <button type="button" className="btn" disabled={checking} onClick={() => check()}>{checking ? t('Checking…') : t('Check')}</button>
        </div>
        <span className="field-hint">{t('host.docker.internal is the machine the platform runs on (Ollama on its default port 11434).')}</span>
      </label>
      {models && (
        <div className="muted small">
          {t('Ollama {version}: {n} models installed.', { version: models.version || '?', n: installed.length })}
        </div>
      )}
      <label className="field">
        <span className="field-label">{t('Model')}</span>
        <div className="model-pick">
          <input list="ollama-models" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          <datalist id="ollama-models">
            {[...new Set([...RECOMMENDED_MODELS, ...installed])].map((n) => <option key={n} value={n} />)}
          </datalist>
        </div>
        <span className="field-hint">
          {RECOMMENDED_MODELS.map((n) => (
            <button key={n} type="button" className="chip-inline" onClick={() => setForm({ ...form, model: n })}>
              {n}{models ? (has(n) ? ' ✓' : ` · ${t('not installed')}`) : ''}
            </button>
          ))}
        </span>
        {missing && <span className="field-hint warn">{t('This model is not installed on the Ollama server: run "ollama pull {model}" there.', { model: form.model })}</span>}
      </label>
      <label className="field">
        <span className="field-label">{t('Model for the scenes of long videos')}</span>
        <div className="model-pick">
          <input list="ollama-models" value={form.storyboardModel || ''} placeholder={form.model} onChange={(e) => setForm({ ...form, storyboardModel: e.target.value })} />
        </div>
        <span className="field-hint">{t('A storyboard of dozens of parts needs a larger model: dolphin-llama3 (8B) writes a real story in 1–3 minutes, 3B models repeat themselves. Empty: the model above.')}</span>
        {models && form.storyboardModel && !has(form.storyboardModel) && <span className="field-hint warn">{t('This model is not installed on the Ollama server: run "ollama pull {model}" there.', { model: form.storyboardModel })}</span>}
      </label>
      </>
      )}
      {error && <div className="error">{error}</div>}
      {msg && <div className="muted small">{msg}</div>}
      <div className="modal-actions">
        <button className="btn primary">{t('Save')}</button>
      </div>
    </form>
  );
}
