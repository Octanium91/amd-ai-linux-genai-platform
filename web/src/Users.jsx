import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate } from './util.js';

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
      setMsg('Пароль изменён. Другие сессии этого пользователя завершены.');
    } catch (err) {
      setMsg(err.message);
    }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal modal-sm" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-info">
          <h3>Смена пароля</h3>
          <label className="field"><span className="field-label">Текущий пароль</span>
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
          <label className="field"><span className="field-label">Новый пароль (от 8 символов)</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
          {msg && <div className={ok ? 'muted small' : 'error'}>{msg}</div>}
          <div className="modal-actions">
            {!ok && <button className="btn primary" disabled={!current || next.length < 8}>Сохранить</button>}
            <button type="button" className="btn ghost" onClick={onClose}>Закрыть</button>
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
        <h2>Пользователи</h2>
        <p className="muted small">
          Пользователи генерируют и управляют своими задачами. Администраторы также скачивают и удаляют модели,
          управляют пользователями и чужими задачами.
        </p>
        <table className="users">
          <thead><tr><th>Имя</th><th>Роль</th><th>Создан</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.username}>
                <td>{u.username}{u.username === me.username ? ' (вы)' : ''}</td>
                <td>{u.role === 'admin' ? 'администратор' : 'пользователь'}</td>
                <td className="muted">{fmtDate(u.createdAt)}</td>
                <td className="users-actions">
                  <button className="btn ghost" onClick={() => {
                    const password = prompt(`Новый пароль для ${u.username} (от 8 символов):`);
                    if (password) act(() => api(`/api/users/${encodeURIComponent(u.username)}/password`, { method: 'POST', json: { password } }));
                  }}>Сменить пароль</button>
                  {u.username !== me.username && (
                    <button className="btn ghost danger" onClick={() => confirm(`Удалить пользователя ${u.username}?`)
                      && act(() => api(`/api/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' }))}>Удалить</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="card form" onSubmit={add}>
        <h3>Новый пользователь</h3>
        <div className="grid3">
          <label className="field"><span className="field-label">Имя</span>
            <input value={form.username} autoComplete="off" onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label className="field"><span className="field-label">Пароль (от 8 символов)</span>
            <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label className="field"><span className="field-label">Роль</span>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">пользователь</option>
              <option value="admin">администратор</option>
            </select></label>
        </div>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={!form.username || form.password.length < 8}>Добавить</button></div>
      </form>
    </main>
  );
}
