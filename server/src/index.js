// AMD AI Linux GenAI Platform — HTTP-сервер: авторизация, очередь генераций, каталог моделей.
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { authRoutes, logStartupHint, requireAdmin, requireAuth } from './auth.js';
import { config } from './config.js';
import {
  cancelJob, createJob, deleteJob, jobLog, jobs, jobSummary, modelsInUse, nextJob, shutdownJobs,
} from './jobs.js';
import {
  cancelDownload, deleteModel, diskUsage, enqueueDownloads, loadCatalog, modelStatus,
} from './models.js';
import { loadPresets, loadTemplates, presetsWithAvailability } from './presets.js';
import { readJson } from './store.js';
import { systemInfo } from './system.js';

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

// Всё ниже — только для вошедших пользователей
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

const findJob = (id) => jobs.find((j) => j.id === id);
const canManage = (req, job) => req.user.role === 'admin' || job.user === req.user.username;

api.get('/state', (req, res) => {
  res.json({ jobs: jobs.map(jobSummary), system: systemInfo(), now: Date.now() });
});

api.get('/presets', (req, res) => res.json(presetsWithAvailability()));
api.get('/templates', (req, res) => res.json(loadTemplates()));

api.post('/jobs', upload.single('image'), (req, res) => {
  const b = req.body || {};
  const reject = (msg) => {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    res.status(400).json({ error: msg });
  };
  const preset = presetsWithAvailability().find((p) => p.id === b.presetId);
  if (!preset) return reject('Неизвестный режим');
  if (!preset.available) return reject('Не скачаны модели: ' + preset.missing.map((m) => m.name).join(', '));
  if (!String(b.prompt || '').trim()) return reject('Введите описание');

  let image = null;
  if (req.file) image = req.file.filename;
  else if (b.imageRef && fs.existsSync(path.join(dirs.uploads, path.basename(b.imageRef)))) image = path.basename(b.imageRef);
  if (preset.image === 'none') image = null;
  if (preset.image === 'required' && !image) return reject('Для этого режима нужна картинка');

  res.json(jobSummary(createJob(preset, b, req.user, image)));
});

api.post('/jobs/:id/cancel', (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Не найдено' });
  if (!canManage(req, job)) return res.status(403).json({ error: 'Это чужая задача' });
  cancelJob(job);
  res.json(jobSummary(job));
});

api.delete('/jobs/:id', (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Не найдено' });
  if (!canManage(req, job)) return res.status(403).json({ error: 'Это чужая задача' });
  deleteJob(job);
  res.json({ ok: true });
});

api.get('/jobs/:id/log', (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Не найдено' });
  const tail = Math.min(2000, Math.max(10, Number(req.query.tail) || 200));
  res.json({ lines: jobLog(job, tail) });
});

api.get('/jobs/:id/download/:n', (req, res) => {
  const job = findJob(req.params.id);
  const file = job?.files?.[Number(req.params.n) || 0];
  if (!file) return res.status(404).json({ error: 'Файла нет' });
  res.download(path.join(dirs.output, file), file);
});

// ---------- модели ----------

api.get('/models', (req, res) => {
  const presets = loadPresets();
  const inUse = modelsInUse();
  const models = loadCatalog().map((m) => ({
    ...m,
    ...modelStatus(m),
    inUse: inUse.has(m.id),
    usedBy: presets.filter((p) => Object.values(p.models || {}).includes(m.id)).map((p) => p.name),
  }));
  res.json({ models, disk: diskUsage() });
});

// Наборы моделей для первичной настройки: что даёт набор, что уже скачано, что рекомендуется под это железо
api.get('/packs', (req, res) => {
  const catalog = loadCatalog();
  const status = new Map(catalog.map((m) => [m.id, modelStatus(m)]));
  const presets = presetsWithAvailability();
  const family = systemInfo().family;
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
      presetNames: (p.presets || []).map((id) => presets.find((x) => x.id === id)?.name || id),
    };
  });
  const downloading = [...status.values()].some((s) => ['queued', 'downloading', 'processing'].includes(s.status));
  res.json({
    packs,
    family,
    disk: diskUsage(),
    downloading,
    // Первичная настройка нужна, пока нет ни одного рабочего режима и ничего не качается
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

api.delete('/models/:id', requireAdmin, (req, res) => {
  const entry = loadCatalog().find((m) => m.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Нет такой модели' });
  if (modelsInUse().has(entry.id)) return res.status(409).json({ error: 'Модель сейчас используется генерацией' });
  deleteModel(entry);
  res.json({ ok: true });
});

app.use('/api', api);

// Файлы результатов тоже только для вошедших
const files = express.Router();
files.use(requireAuth);
files.use('/output', express.static(dirs.output, { index: false, dotfiles: 'ignore' }));
files.use('/thumbs', express.static(dirs.thumbs, { maxAge: '7d' }));
files.use('/uploads', express.static(dirs.uploads, { maxAge: '7d' }));
files.use('/previews', express.static(dirs.previews, { etag: false, lastModified: false, cacheControl: false }));
app.use('/files', files);

// Интерфейс (SPA) отдаётся всем: без сессии он показывает только форму входа
app.use(express.static(config.publicDir));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/files/')) {
    return res.sendFile(path.join(config.publicDir, 'index.html'));
  }
  next();
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Внутренняя ошибка' });
});

const server = app.listen(config.port, () => {
  console.log(`GenAI Platform: http://0.0.0.0:${config.port}`);
  nextJob();
});

function shutdown() {
  shutdownJobs();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
