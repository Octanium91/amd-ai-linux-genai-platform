// AMD AI Linux GenAI Platform — web container: UI, API, auth, model catalog and downloads.
// Generation runs in the worker container (src/worker); this server talks to it over an internal
// API, so it can be restarted or updated at any time without touching a running job.
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { authRoutes, logStartupHint, requireAdmin, requireAuth } from './auth.js';
import { config, WORKER_API } from '../common/config.js';
import { jobLog } from './joblog.js';
import {
  cancelDownload, deleteModel, diskUsage, enqueueDownloads, loadCatalog, modelStatus,
} from './models.js';
import { jobParams, jobSpec } from './params.js';
import { loadPresets, loadTemplates, presetsWithAvailability } from './presets.js';
import { readJson } from '../common/store.js';
import { callWorker, workerState } from './worker.js';

const { dirs } = config;
logStartupHint();

const app = express();
if (config.trustProxy) app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

authRoutes(app);

// Everything below requires a signed-in user
const api = express.Router();
api.use(requireAuth);

const upload = multer({
  storage: multer.diskStorage({
    destination: dirs.uploads,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Express 5 passes rejected promises to the error handler; worker errors keep their HTTP status
const findJob = (id) => callWorker(`/v1/jobs/${encodeURIComponent(id)}`);
const canManage = (req, job) => req.user.role === 'admin' || job.user === req.user.username;

// The web ↔ worker link is one more system check
function workerCheck(w) {
  if (!w.online) return { id: 'worker', status: 'fail', params: {} };
  if (!w.compatible) return { id: 'worker', status: 'warn', params: { api: w.api, expected: WORKER_API } };
  return { id: 'worker', status: 'ok', params: { api: w.api } };
}

api.get('/state', async (req, res) => {
  const { jobs, system, health, worker } = await workerState();
  const check = workerCheck(worker);
  const summary = check.status === 'ok' ? health : {
    status: check.status === 'fail' || health?.status === 'fail' ? 'fail' : 'warn',
    problems: [{ id: check.id, status: check.status }, ...(health?.problems || [])],
  };
  res.json({ jobs, system, health: summary, worker, now: Date.now() });
});

api.get('/diagnostics', async (req, res) => {
  const { worker } = await workerState();
  let d = { checks: [], at: Date.now() };
  if (worker.online) d = await callWorker(`/v1/diagnostics${req.query.refresh === '1' ? '?refresh=1' : ''}`, { timeout: 90000 });
  const checks = [workerCheck(worker), ...d.checks];
  const status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  res.json({ ...d, checks, status });
});

api.get('/presets', (req, res) => res.json(presetsWithAvailability()));
api.get('/templates', (req, res) => res.json(loadTemplates()));

api.post('/jobs', upload.single('image'), async (req, res) => {
  const b = req.body || {};
  const reject = (msg) => {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    res.status(400).json({ error: msg });
  };
  const preset = presetsWithAvailability().find((p) => p.id === b.presetId);
  if (!preset) return reject('Unknown mode');
  if (!preset.available) return reject('Models not downloaded: ' + preset.missing.map((m) => m.name).join(', '));
  if (!String(b.prompt || '').trim()) return reject('Enter a prompt');

  let image = null;
  if (req.file) image = req.file.filename;
  else if (b.imageRef && fs.existsSync(path.join(dirs.uploads, path.basename(b.imageRef)))) image = path.basename(b.imageRef);
  if (preset.image === 'none') image = null;
  if (preset.image === 'required' && !image) return reject('This mode requires an image');

  try {
    res.json(await callWorker('/v1/jobs', {
      method: 'POST',
      body: { user: req.user.username, params: jobParams(preset, b, image), spec: jobSpec(preset) },
    }));
  } catch (e) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    throw e;
  }
});

api.post('/jobs/:id/cancel', async (req, res) => {
  const job = await findJob(req.params.id);
  if (!canManage(req, job)) return res.status(403).json({ error: 'This job belongs to another user' });
  res.json(await callWorker(`/v1/jobs/${job.id}/cancel`, { method: 'POST' }));
});

api.delete('/jobs/:id', async (req, res) => {
  const job = await findJob(req.params.id);
  if (!canManage(req, job)) return res.status(403).json({ error: 'This job belongs to another user' });
  res.json(await callWorker(`/v1/jobs/${job.id}`, { method: 'DELETE' }));
});

// Logs are read straight from /data/state/logs: they stay viewable while the worker restarts
api.get('/jobs/:id/log', (req, res) => {
  const tail = Math.min(2000, Math.max(10, Number(req.query.tail) || 200));
  res.json({ lines: jobLog(req.params.id, tail) });
});

api.get('/jobs/:id/download/:n', async (req, res) => {
  const job = await findJob(req.params.id);
  const file = job?.files?.[Number(req.params.n) || 0];
  if (!file) return res.status(404).json({ error: 'No such file' });
  res.download(path.join(dirs.output, file), file);
});

// ---------- models ----------

api.get('/models', async (req, res) => {
  const presets = loadPresets();
  const inUse = new Set((await workerState()).inUse || []);
  const models = loadCatalog().map((m) => ({
    ...m,
    ...modelStatus(m),
    inUse: inUse.has(m.id),
    usedBy: presets.filter((p) => Object.values(p.models || {}).includes(m.id)).map((p) => ({ name: p.name, i18n: p.i18n })),
  }));
  res.json({ models, disk: diskUsage() });
});

// Model packs for first-run setup: what a pack enables, what is already downloaded, what is recommended for this hardware
api.get('/packs', async (req, res) => {
  const catalog = loadCatalog();
  const status = new Map(catalog.map((m) => [m.id, modelStatus(m)]));
  const presets = presetsWithAvailability();
  const family = (await workerState()).system?.family || null;
  const packs = readJson(path.join(config.catalogDir, 'packs.json'), []).map((p) => {
    const models = p.models.map((id) => {
      const m = catalog.find((x) => x.id === id);
      return { id, name: m?.name || id, size: m?.size || 0, status: status.get(id)?.status || 'missing' };
    });
    return {
      ...p,
      models,
      installed: models.every((m) => m.status === 'installed'),
      remaining: models.filter((m) => m.status !== 'installed').reduce((s, m) => s + m.size, 0),
      recommended: !!p.recommended || (p.recommendedFamilies || []).includes(family),
      presetInfo: (p.presets || []).map((id) => {
        const x = presets.find((y) => y.id === id);
        return x ? { name: x.name, i18n: x.i18n } : { name: id };
      }),
    };
  });
  const downloading = [...status.values()].some((s) => ['queued', 'downloading', 'processing'].includes(s.status));
  res.json({
    packs,
    family,
    disk: diskUsage(),
    downloading,
    // First-run setup is needed while no mode is usable and nothing is downloading
    needed: !presets.some((p) => p.available) && !downloading,
  });
});

api.post('/models/download', requireAdmin, (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json({ queued: enqueueDownloads(ids) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

api.post('/models/:id/cancel', requireAdmin, (req, res) => {
  res.json({ ok: cancelDownload(req.params.id) });
});

api.delete('/models/:id', requireAdmin, async (req, res) => {
  const entry = loadCatalog().find((m) => m.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'No such model' });
  // Without the worker it is unknown whether a generation uses the model right now
  const { worker, inUse } = await workerState();
  if (!worker.online) return res.status(503).json({ error: 'The generation engine is not available, try again in a minute' });
  if (inUse.includes(entry.id)) return res.status(409).json({ error: 'The model is in use by the current generation' });
  deleteModel(entry);
  res.json({ ok: true });
});

app.use('/api', api);

// Result files are for signed-in users only as well
const files = express.Router();
files.use(requireAuth);
files.use('/output', express.static(dirs.output, { index: false, dotfiles: 'ignore' }));
files.use('/thumbs', express.static(dirs.thumbs, { maxAge: '7d' }));
files.use('/uploads', express.static(dirs.uploads, { maxAge: '7d' }));
files.use('/previews', express.static(dirs.previews, { etag: false, lastModified: false, cacheControl: false }));
app.use('/files', files);

// The SPA is public: without a session it only shows the sign-in form
app.use(express.static(config.publicDir));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/files/')) {
    return res.sendFile(path.join(config.publicDir, 'index.html'));
  }
  next();
});

app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error(err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

const server = app.listen(config.port, () => {
  console.log(`GenAI Platform: http://0.0.0.0:${config.port}`);
  workerState().then(({ worker }) => {
    if (!worker.online) console.warn(`[web] the worker is not reachable at ${config.workerUrl} yet`);
    else if (!worker.compatible) console.warn(`[web] the worker speaks API v${worker.api}, expected v${WORKER_API}: update both containers`);
  });
});

function shutdown() {
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
