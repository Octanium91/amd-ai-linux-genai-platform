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
        <label className="check">
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
        <label className="check check-sm">
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

// The "To prompt" assistant: an Ollama server and model that rewrite descriptions into prompts
const RECOMMENDED_MODELS = ['dolphin-phi', 'dolphin-llama3'];

function PromptAssistantSettings() {
  const [form, setForm] = useState(null);
  const [models, setModels] = useState(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/settings').then((s) => setForm(s.promptAssistant)).catch((e) => setError(e.message));
  }, []);

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
    if (form?.enabled) check(form.url);
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

  return (
    <form className="card form" onSubmit={save}>
      <h3>{t('Prompt assistant')}</h3>
      <p className="muted">
        {t('Adds a "To prompt" button to the generation form: a language model on an Ollama server turns a short description in any language into a detailed English prompt written for the selected mode (tags for Stable Diffusion 1.5, sentences with motion and camera for Wan).')}
      </p>
      <p className="muted">
        {t('Recommended models: dolphin-phi (small and fast) or dolphin-llama3 (better wording). Install one on the Ollama server with:')}{' '}
        <code>ollama pull dolphin-phi</code>
      </p>
      <p className="muted small">{t('If Ollama uses the same GPU, it takes GPU memory while it answers; the platform asks it to unload the model a minute after each request.')}</p>
      <label className="check">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <span>{t('Enable the prompt assistant')}</span>
      </label>
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
      {error && <div className="error">{error}</div>}
      {msg && <div className="muted small">{msg}</div>}
      <div className="modal-actions">
        <button className="btn primary">{t('Save')}</button>
      </div>
    </form>
  );
}
