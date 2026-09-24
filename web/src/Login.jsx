import { useEffect, useState } from 'react';
import { api } from './util.js';
import { t } from './i18n.js';
import { Logo } from './Logo.jsx';
import { LangSwitch } from './LangSwitch.jsx';

// Sign-in. When there are no users yet — registration of the first administrator.
export default function Login({ onLogin }) {
  const [setup, setSetup] = useState(null); // null — checking, true — the first administrator is needed
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/auth/status').then((s) => setSetup(!!s.setup)).catch(() => setSetup(false));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (setup && password !== password2) return setError(t('Passwords do not match'));
    setBusy(true);
    try {
      const path = setup ? '/api/auth/setup' : '/api/auth/login';
      onLogin(await api(path, { method: 'POST', json: { username, password } }));
    } catch (err) {
      setError(err.message);
      // Someone created the administrator first — switch to the regular sign-in
      if (setup && err.status === 409) setSetup(false);
    } finally {
      setBusy(false);
    }
  };

  if (setup === null) return <div className="login-wrap muted">{t('Loading…')}</div>;

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <div className="login-top">
          <div className="brand login-brand">
            <Logo />
            <div>
              <div className="brand-name">GenAI Platform</div>
              <div className="brand-sub">AMD Ryzen AI · Linux · Vulkan</div>
            </div>
          </div>
          <LangSwitch />
        </div>
        {setup && (
          <div className="setup-note">
            <b>{t('First start.')}</b> {t('Create the platform administrator: they can download models and add other users.')}
          </div>
        )}
        <label className="field">
          <span className="field-label">{setup ? t('Administrator username') : t('Username')}</span>
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          {setup && <span className="field-hint">{t('2–32 characters: Latin letters, digits, . _ -')}</span>}
        </label>
        <label className="field">
          <span className="field-label">{setup ? t('Password (at least 8 characters)') : t('Password')}</span>
          <input type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {setup && (
          <label className="field">
            <span className="field-label">{t('Repeat the password')}</span>
            <input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy || !username || !password || (setup && !password2)}>
          {busy ? (setup ? t('Creating…') : t('Signing in…')) : setup ? t('Create administrator and sign in') : t('Sign in')}
        </button>
      </form>
    </div>
  );
}
