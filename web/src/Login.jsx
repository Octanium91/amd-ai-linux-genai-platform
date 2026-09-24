import { useEffect, useState } from 'react';
import { api } from './util.js';
import { Logo } from './Logo.jsx';

// Вход. Если в системе ещё нет пользователей — регистрация первого администратора.
export default function Login({ onLogin }) {
  const [setup, setSetup] = useState(null); // null — узнаём, true — нужен первый администратор
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
    if (setup && password !== password2) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      const path = setup ? '/api/auth/setup' : '/api/auth/login';
      onLogin(await api(path, { method: 'POST', json: { username, password } }));
    } catch (err) {
      setError(err.message);
      // Кто-то успел создать администратора раньше — переключаемся на обычный вход
      if (setup && /уже создан/.test(err.message)) setSetup(false);
    } finally {
      setBusy(false);
    }
  };

  if (setup === null) return <div className="login-wrap muted">Загрузка…</div>;

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <div className="brand login-brand">
          <Logo />
          <div>
            <div className="brand-name">GenAI Platform</div>
            <div className="brand-sub">AMD Ryzen AI · Linux · Vulkan</div>
          </div>
        </div>
        {setup && (
          <div className="setup-note">
            <b>Первый запуск.</b> Создайте администратора платформы: он сможет скачивать модели и добавлять других пользователей.
          </div>
        )}
        <label className="field">
          <span className="field-label">{setup ? 'Имя администратора' : 'Пользователь'}</span>
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          {setup && <span className="field-hint">2–32 символа: латиница, цифры, . _ -</span>}
        </label>
        <label className="field">
          <span className="field-label">Пароль{setup ? ' (от 8 символов)' : ''}</span>
          <input type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {setup && (
          <label className="field">
            <span className="field-label">Повторите пароль</span>
            <input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy || !username || !password || (setup && !password2)}>
          {busy ? (setup ? 'Создание…' : 'Вход…') : setup ? 'Создать администратора и войти' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
