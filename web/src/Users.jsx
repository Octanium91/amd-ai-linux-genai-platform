import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate } from './util.js';
import { t } from './i18n.js';

export function ChangePassword({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/password', { method: 'POST', json: { current, next } });
      setOk(true);
      setMsg(t('Password changed. Other sessions of this user have been signed out.'));
    } catch (err) {
      setMsg(err.message);
    }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal modal-sm" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-info">
          <h3>{t('Change password')}</h3>
          <label className="field"><span className="field-label">{t('Current password')}</span>
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
          <label className="field"><span className="field-label">{t('New password (at least 8 characters)')}</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
          {msg && <div className={ok ? 'muted small' : 'error'}>{msg}</div>}
          <div className="modal-actions">
            {!ok && <button className="btn primary" disabled={!current || next.length < 8}>{t('Save')}</button>}
            <button type="button" className="btn ghost" onClick={onClose}>{t('Close')}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default function Users({ me }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', role: 'user' });
  const [error, setError] = useState('');
  const load = useCallback(() => api('/api/users').then(setUsers).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    }
    load();
  };
  const add = (e) => {
    e.preventDefault();
    act(async () => {
      await api('/api/users', { method: 'POST', json: form });
      setForm({ username: '', password: '', role: 'user' });
    });
  };

  return (
    <main className="page">
      <div className="card">
        <h2>{t('Users')}</h2>
        <p className="muted small">
          {t('Users generate content and manage their own jobs. Administrators also download and delete models, manage users and other users\' jobs.')}
        </p>
        <table className="users">
          <thead><tr><th>{t('Username')}</th><th>{t('Role')}</th><th>{t('Created')}</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.username}>
                <td>{u.username}{u.username === me.username ? ` (${t('you')})` : ''}</td>
                <td>{u.role === 'admin' ? t('administrator') : t('user')}</td>
                <td className="muted">{fmtDate(u.createdAt)}</td>
                <td className="users-actions">
                  <button className="btn ghost" onClick={() => {
                    const password = prompt(t('New password for {name} (at least 8 characters):', { name: u.username }));
                    if (password) act(() => api(`/api/users/${encodeURIComponent(u.username)}/password`, { method: 'POST', json: { password } }));
                  }}>{t('Change password')}</button>
                  {u.username !== me.username && (
                    <button className="btn ghost danger" onClick={() => confirm(t('Delete the user {name}?', { name: u.username }))
                      && act(() => api(`/api/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' }))}>{t('Delete')}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="card form" onSubmit={add}>
        <h3>{t('New user')}</h3>
        <div className="grid3">
          <label className="field"><span className="field-label">{t('Username')}</span>
            <input value={form.username} autoComplete="off" onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label className="field"><span className="field-label">{t('Password (at least 8 characters)')}</span>
            <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label className="field"><span className="field-label">{t('Role')}</span>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">{t('user')}</option>
              <option value="admin">{t('administrator')}</option>
            </select></label>
        </div>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={!form.username || form.password.length < 8}>{t('Add')}</button></div>
      </form>
    </main>
  );
}
