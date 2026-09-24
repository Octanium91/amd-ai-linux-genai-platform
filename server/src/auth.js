// Авторизация: пользователи с scrypt-хешами, сессии в HttpOnly-cookie,
// защита от перебора и от CSRF (SameSite=Lax + обязательный заголовок на изменяющих запросах).
import crypto from 'node:crypto';
import { config } from './config.js';
import { readJson, statePath, writeJson } from './store.js';

const USERS_FILE = statePath('users.json');
const SESSIONS_FILE = statePath('sessions.json');
const COOKIE = 'gp_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'genai-platform';

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;
const MIN_PASSWORD = 8;

let users = readJson(USERS_FILE, []);
let sessions = readJson(SESSIONS_FILE, {}); // sha256(token) -> { username, expires }

const saveUsers = () => writeJson(USERS_FILE, users, 0o600);
const saveSessions = () => writeJson(SESSIONS_FILE, sessions, 0o600);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function verifyPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('hex');
const publicUser = (u) => ({ username: u.username, role: u.role, createdAt: u.createdAt });

export function validateCredentials(username, password) {
  if (!USERNAME_RE.test(username || '')) return 'Имя: 2–32 символа, латиница, цифры, . _ -';
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `Пароль должен быть не короче ${MIN_PASSWORD} символов`;
  }
  return null;
}

// Пока пользователей нет, платформа предлагает создать первого администратора
export const needsSetup = () => users.length === 0;

export function logStartupHint() {
  if (needsSetup()) console.log('[auth] пользователей нет — откройте интерфейс и создайте администратора');
}

// --- защита от перебора: 10 неудачных попыток за 15 минут с одного IP ---
const failures = new Map();
const WINDOW = 15 * 60 * 1000;
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW) return false;
  return f.count >= 10;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(value, maxAgeSec) {
  return [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`,
    ...(config.cookieSecure ? ['Secure'] : []),
  ].join('; ');
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = sessions[tokenKey(token)];
  if (!s || s.expires < Date.now()) return null;
  return users.find((u) => u.username === s.username) || null;
}

// Middleware: пускает только авторизованных, для изменяющих запросов требует CSRF-заголовок
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Требуется вход' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get(CSRF_HEADER) !== CSRF_VALUE) {
    return res.status(403).json({ error: 'Запрос отклонён (CSRF)' });
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' });
  next();
}

export function authRoutes(app) {
  const startSession = (res, user) => {
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAge = config.sessionDays * 86400;
    for (const [k, s] of Object.entries(sessions)) if (s.expires < Date.now()) delete sessions[k];
    sessions[tokenKey(token)] = { username: user.username, expires: Date.now() + maxAge * 1000 };
    saveSessions();
    res.setHeader('Set-Cookie', sessionCookie(token, maxAge));
  };

  // Нужна ли регистрация первого администратора
  app.get('/api/auth/status', (req, res) => res.json({ setup: needsSetup() }));

  // Первый администратор: разрешено, только пока в системе нет ни одного пользователя
  app.post('/api/auth/setup', (req, res) => {
    if (req.get(CSRF_HEADER) !== CSRF_VALUE) return res.status(403).json({ error: 'Запрос отклонён (CSRF)' });
    if (!needsSetup()) return res.status(409).json({ error: 'Администратор уже создан — войдите' });
    const { username, password } = req.body || {};
    const err = validateCredentials(username, password);
    if (err) return res.status(400).json({ error: err });
    const user = { username, role: 'admin', createdAt: Date.now(), ...hashPassword(password) };
    users.push(user);
    saveUsers();
    console.log(`[auth] создан администратор "${username}"`);
    startSession(res, user);
    res.json(publicUser(user));
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip;
    if (req.get(CSRF_HEADER) !== CSRF_VALUE) return res.status(403).json({ error: 'Запрос отклонён (CSRF)' });
    if (tooManyFailures(ip)) return res.status(429).json({ error: 'Слишком много попыток, подождите 15 минут' });
    const { username, password } = req.body || {};
    const user = users.find((u) => u.username === username);
    if (!user || typeof password !== 'string' || !verifyPassword(user, password)) {
      noteFailure(ip);
      return res.status(401).json({ error: 'Неверное имя или пароль' });
    }
    failures.delete(ip);
    startSession(res, user);
    res.json(publicUser(user));
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      delete sessions[tokenKey(token)];
      saveSessions();
    }
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    res.json(publicUser(user));
  });

  app.post('/api/auth/password', requireAuth, (req, res) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(req.user, String(current || ''))) return res.status(400).json({ error: 'Текущий пароль неверен' });
    const err = validateCredentials(req.user.username, next);
    if (err) return res.status(400).json({ error: err });
    Object.assign(req.user, hashPassword(next));
    saveUsers();
    dropSessionsExcept(req.user.username, parseCookies(req.headers.cookie)[COOKIE]);
    res.json({ ok: true });
  });

  // --- управление пользователями (только admin) ---
  app.get('/api/users', requireAuth, requireAdmin, (req, res) => res.json(users.map(publicUser)));

  app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    const { username, password, role } = req.body || {};
    const err = validateCredentials(username, password);
    if (err) return res.status(400).json({ error: err });
    if (users.some((u) => u.username === username)) return res.status(400).json({ error: 'Такой пользователь уже есть' });
    const user = { username, role: role === 'admin' ? 'admin' : 'user', createdAt: Date.now(), ...hashPassword(password) };
    users.push(user);
    saveUsers();
    res.json(publicUser(user));
  });

  app.post('/api/users/:username/password', requireAuth, requireAdmin, (req, res) => {
    const user = users.find((u) => u.username === req.params.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const err = validateCredentials(user.username, req.body?.password);
    if (err) return res.status(400).json({ error: err });
    Object.assign(user, hashPassword(req.body.password));
    saveUsers();
    dropSessionsExcept(user.username, user === req.user ? parseCookies(req.headers.cookie)[COOKIE] : null);
    res.json({ ok: true });
  });

  app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
    const user = users.find((u) => u.username === req.params.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user === req.user) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    if (user.role === 'admin' && users.filter((u) => u.role === 'admin').length === 1) {
      return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
    }
    users = users.filter((u) => u !== user);
    saveUsers();
    dropSessionsExcept(user.username, null);
    res.json({ ok: true });
  });
}

function dropSessionsExcept(username, keepToken) {
  const keep = keepToken ? tokenKey(keepToken) : null;
  for (const [k, s] of Object.entries(sessions)) if (s.username === username && k !== keep) delete sessions[k];
  saveSessions();
}
