// Auth: users with scrypt hashes, HttpOnly session cookies,
// brute-force protection and CSRF protection (SameSite=Lax + a required header on mutating requests).
import crypto from 'node:crypto';
import { config } from '../common/config.js';
import { readJson, statePath, writeJson } from '../common/store.js';

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
  if (!USERNAME_RE.test(username || '')) return 'Username: 2–32 characters, Latin letters, digits, . _ -';
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters`;
  }
  return null;
}

// While there are no users, the platform offers to create the first administrator
export const needsSetup = () => users.length === 0;

export function logStartupHint() {
  if (needsSetup()) console.log('[auth] no users yet — open the web UI and create the administrator');
}

// --- brute-force protection: 10 failed attempts per 15 minutes per IP ---
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

// Middleware: signed-in users only; mutating requests must carry the CSRF header
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign-in required' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get(CSRF_HEADER) !== CSRF_VALUE) {
    return res.status(403).json({ error: 'Request rejected (CSRF)' });
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator rights required' });
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

  // Whether the first administrator still has to be created
  app.get('/api/auth/status', (req, res) => res.json({ setup: needsSetup() }));

  // First administrator: allowed only while there are no users at all
  app.post('/api/auth/setup', (req, res) => {
    if (req.get(CSRF_HEADER) !== CSRF_VALUE) return res.status(403).json({ error: 'Request rejected (CSRF)' });
    if (!needsSetup()) return res.status(409).json({ error: 'The administrator already exists — sign in' });
    const { username, password } = req.body || {};
    const err = validateCredentials(username, password);
    if (err) return res.status(400).json({ error: err });
    const user = { username, role: 'admin', createdAt: Date.now(), ...hashPassword(password) };
    users.push(user);
    saveUsers();
    console.log(`[auth] administrator "${username}" created`);
    startSession(res, user);
    res.json(publicUser(user));
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip;
    if (req.get(CSRF_HEADER) !== CSRF_VALUE) return res.status(403).json({ error: 'Request rejected (CSRF)' });
    if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many attempts, wait 15 minutes' });
    const { username, password } = req.body || {};
    const user = users.find((u) => u.username === username);
    if (!user || typeof password !== 'string' || !verifyPassword(user, password)) {
      noteFailure(ip);
      return res.status(401).json({ error: 'Invalid username or password' });
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
    if (!user) return res.status(401).json({ error: 'Sign-in required' });
    res.json(publicUser(user));
  });

  app.post('/api/auth/password', requireAuth, (req, res) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(req.user, String(current || ''))) return res.status(400).json({ error: 'Current password is incorrect' });
    const err = validateCredentials(req.user.username, next);
    if (err) return res.status(400).json({ error: err });
    Object.assign(req.user, hashPassword(next));
    saveUsers();
    dropSessionsExcept(req.user.username, parseCookies(req.headers.cookie)[COOKIE]);
    res.json({ ok: true });
  });

  // --- user management (admin only) ---
  app.get('/api/users', requireAuth, requireAdmin, (req, res) => res.json(users.map(publicUser)));

  app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    const { username, password, role } = req.body || {};
    const err = validateCredentials(username, password);
    if (err) return res.status(400).json({ error: err });
    if (users.some((u) => u.username === username)) return res.status(400).json({ error: 'This user already exists' });
    const user = { username, role: role === 'admin' ? 'admin' : 'user', createdAt: Date.now(), ...hashPassword(password) };
    users.push(user);
    saveUsers();
    res.json(publicUser(user));
  });

  app.post('/api/users/:username/password', requireAuth, requireAdmin, (req, res) => {
    const user = users.find((u) => u.username === req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const err = validateCredentials(user.username, req.body?.password);
    if (err) return res.status(400).json({ error: err });
    Object.assign(user, hashPassword(req.body.password));
    saveUsers();
    dropSessionsExcept(user.username, user === req.user ? parseCookies(req.headers.cookie)[COOKIE] : null);
    res.json({ ok: true });
  });

  app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
    const user = users.find((u) => u.username === req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user === req.user) return res.status(400).json({ error: 'You cannot delete yourself' });
    if (user.role === 'admin' && users.filter((u) => u.role === 'admin').length === 1) {
      return res.status(400).json({ error: 'You cannot delete the last administrator' });
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
