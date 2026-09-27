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
import { loadPresets, loadTemplates, presetsWithAvailability, TASK_INPUTS } from './presets.js';
import { readJson } from '../common/store.js';
import { promptAdminRoutes, promptRoutes } from './prompt.js';
import { segmenterEntry, subjectMask } from './cutout.js';
import { settingsRoutes } from './settings.js';
import { callWorker, workerState } from './worker.js';

const { dirs } = config;
logStartupHint();

const app = express();
// Trust exactly one proxy hop: with `true` the client could set X-Forwarded-For and bypass the
// sign-in rate limit with a new "IP" on every attempt
if (config.trustProxy) app.set('trust proxy', 1);
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

// Uploads are named by the server; the extension comes from the file's content, not from the
// client, and only PNG, JPEG and WebP images and MP4, MOV and WebM videos are kept (an SVG or
// HTML "image" would run scripts in the platform's origin when opened). A job may carry a photo,
// a mask (white = repaint) and a video, depending on its task, and a video job a soundtrack (MP3,
// WAV, OGG, FLAC, M4A or the sound of a video).
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const upload = multer({
  storage: multer.diskStorage({
    destination: dirs.uploads,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.upload`),
  }),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 4, fields: 40, fieldSize: 64 * 1024, parts: 45 },
  fileFilter: (req, file, cb) => cb(null, {
    video: /^video\//,
    audio: /^(audio|video)\/|^application\/octet-stream$/,
  }[file.fieldname]?.test(file.mimetype) ?? /^image\//.test(file.mimetype)),
});
const jobFiles = upload.fields([{ name: 'image', maxCount: 1 }, { name: 'mask', maxCount: 1 }, { name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]);
const UPLOAD_NAME = /^\d+-[0-9a-f]{6}\.(png|jpg|webp|mp4|mov|webm|mp3|wav|ogg|flac|m4a)$/;

function imageType(file) {
  const b = Buffer.alloc(12);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, b, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function videoType(file) {
  const b = Buffer.alloc(12);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, b, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  // An ftyp box is also used by HEIC/AVIF images and M4A audio: only video brands pass
  if (b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand.startsWith('qt')) return 'mov';
    return /^(isom|iso[2-9]|mp4[12]|avc1|M4V |M4VH|3gp[4-9]|3g2[abc]|mmp4|MSNV|dash|f4v )$/.test(brand) ? 'mp4' : null;
  }
  if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  return null;
}

// A soundtrack: an audio file, or a video whose sound is used
function audioType(file) {
  const b = Buffer.alloc(12);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, b, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (b.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  // An MPEG audio frame header (11 sync bits, a layer other than the reserved 00, which ADTS uses)
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) return 'mp3';
  if (b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (b.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  if (b.toString('latin1', 4, 8) === 'ftyp' && /^M4[ABP] $/.test(b.toString('latin1', 8, 12))) return 'm4a';
  return videoType(file);
}

// Width and height from the image header (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X), or null
function imageSize(file) {
  const b = Buffer.alloc(Math.min(fs.statSync(file).size, 256 * 1024));
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, b, 0, b.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (b.length >= 24 && b.toString('latin1', 12, 16) === 'IHDR') return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
    return null;
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (chunk === 'VP8L') {
      const v = b.readUInt32LE(21);
      return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)];
    }
    if (chunk === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  return null;
}
// Photos above 50 megapixels are refused; the upscaler takes at most 2048 px on the long side
// (its result is 4× larger in each direction and must fit in memory)
const MAX_PIXELS = 50e6;
const MAX_UPSCALE_SIDE = 2048;

// Limits against oversized requests: prompts, and jobs one user may keep waiting in the queue
const MAX_PROMPT = 4000;
const MAX_QUEUED_PER_USER = 20;

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
  // A fresh run starts vulkaninfo, sd-cli and ffmpeg: only administrators may force it
  const refresh = req.query.refresh === '1' && req.user.role === 'admin';
  if (worker.online) d = await callWorker(`/v1/diagnostics${refresh ? '?refresh=1' : ''}`, { timeout: 90000 });
  const checks = [workerCheck(worker), ...d.checks];
  const status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  res.json({ ...d, checks, status });
});

api.get('/presets', (req, res) => res.json(presetsWithAvailability()));
api.get('/templates', (req, res) => res.json(loadTemplates()));

async function beforeUpload(req, res, next) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > MAX_VIDEO_BYTES + MAX_AUDIO_BYTES + 2 * MAX_IMAGE_BYTES + 1024 * 1024) return res.status(413).json({ error: 'The file is too large' });
  const { jobs } = await workerState();
  if (jobs.filter((j) => j.status === 'queued' && j.user === req.user.username).length >= MAX_QUEUED_PER_USER) {
    return res.status(400).json({ error: 'Too many jobs in the queue (at most 20 per user)' });
  }
  next();
}

api.post('/jobs', beforeUpload, jobFiles, async (req, res) => {
  const b = req.body || {};
  const uploaded = Object.values(req.files || {}).flat();
  const reject = (msg) => {
    for (const f of uploaded) fs.rmSync(f.path, { force: true });
    res.status(400).json({ error: msg });
  };
  const preset = presetsWithAvailability().find((p) => p.id === b.presetId);
  if (!preset) return reject('Unknown mode');
  if (!preset.available) return reject('Models not downloaded: ' + preset.missing.map((m) => m.name).join(', '));
  const task = b.task && TASK_INPUTS[b.task] ? b.task : preset.tasks[0];
  // An engine of an older version would ignore the photo, mask or video and silently do something else
  if (task !== 'create' && !(await workerState()).worker?.compatible) return reject('The generation engine is being updated, try again in a minute');
  if (!preset.tasks.includes(task)) return reject('This mode cannot do this task');
  const needs = TASK_INPUTS[task];
  if (needs.instant) return reject('This task runs without the queue');
  if (!needs.noPrompt && !String(b.prompt || '').trim()) return reject('Enter a prompt');
  if (String(b.prompt || '').length > MAX_PROMPT || String(b.negative ?? '').length > MAX_PROMPT) {
    return reject('The prompt is too long (at most 4000 characters)');
  }

  // Every file is renamed by its real content type; a file already uploaded earlier can be
  // referred to by name (repeating or restarting a job)
  const take = (field, typeOf, maxBytes, badType) => {
    const f = req.files?.[field]?.[0];
    if (f) {
      if (f.size > maxBytes) return { error: 'The file is too large' };
      const type = typeOf(f.path);
      if (!type) return { error: badType };
      const name = f.filename.replace(/\.upload$/, `.${type}`);
      fs.renameSync(f.path, path.join(dirs.uploads, name));
      f.path = path.join(dirs.uploads, name);
      return { name };
    }
    // A mask is always painted anew; photos and videos of earlier jobs can be reused by name
    const ref = field === 'mask' ? '' : String(b[`${field}Ref`] || '');
    if (UPLOAD_NAME.test(ref) && fs.statSync(path.join(dirs.uploads, ref), { throwIfNoEntry: false })?.isFile()) return { name: ref };
    return { name: null };
  };
  let img;
  let mask;
  let vid;
  let aud;
  try {
    img = take('image', imageType, MAX_IMAGE_BYTES, 'Only PNG, JPEG and WebP images are accepted');
    mask = take('mask', imageType, MAX_IMAGE_BYTES, 'Only PNG, JPEG and WebP images are accepted');
    vid = take('video', videoType, MAX_VIDEO_BYTES, 'Only MP4, MOV and WebM videos are accepted');
    aud = take('audio', audioType, MAX_AUDIO_BYTES, 'Only MP3, WAV, OGG, FLAC and M4A audio or a video with sound are accepted');
  } catch (e) {
    console.error(`[jobs] upload: ${e.message}`);
    return reject('The file could not be saved');
  }
  const error = img.error || mask.error || vid.error || aud.error;
  if (error) return reject(error);
  let size = null;
  if (img.name) {
    size = imageSize(path.join(dirs.uploads, img.name));
    if (size && size[0] * size[1] > MAX_PIXELS) return reject('The photo is too large (at most 50 megapixels)');
    if (task === 'upscale' && (!size || Math.max(...size) > MAX_UPSCALE_SIDE)) return reject('The photo is too large to upscale (at most 2048 px on the long side)');
  }
  // Inputs the task does not use are dropped: a text-to-image job never carries a photo
  const drop = (name) => name && uploaded.some((f) => f.path.endsWith(name)) && fs.rmSync(path.join(dirs.uploads, name), { force: true });
  const inputs = {
    image: needs.image || needs.imageOptional ? img.name : (drop(img.name), null),
    mask: needs.mask ? mask.name : (drop(mask.name), null),
    video: needs.video ? vid.name : (drop(vid.name), null),
    audio: preset.kind === 'video' ? aud.name : (drop(aud.name), null),
  };
  // An engine of an older version would drop the soundtrack
  if ((inputs.audio || b.audioSource === 'video') && !(await workerState()).worker?.compatible) return reject('The generation engine is being updated, try again in a minute');
  if (needs.image && !inputs.image) return reject('This task needs a photo');
  if (needs.mask && !inputs.mask) return reject('Paint the part of the photo to change');
  if (needs.video && !inputs.video) return reject('This task needs a video');
  // An upscale job's size is its result: the photo ×4
  if (task === 'upscale' && size) Object.assign(b, { width: size[0] * 4, height: size[1] * 4 });

  try {
    res.json(await callWorker('/v1/jobs', {
      method: 'POST',
      body: { user: req.user.username, params: jobParams(preset, b, inputs.image, { ...inputs, task }), spec: jobSpec(preset) },
    }));
  } catch (e) {
    for (const f of uploaded) fs.rmSync(f.path, { force: true });
    throw e;
  }
});

// Background removal: the subject mask of a photo as a grayscale PNG (white = keep). The photo is
// an upload in this request, an earlier upload by name, or an image of a finished job. One at a
// time: the model takes a few seconds of CPU and about 300 MB of memory.
let cutoutBusy = Promise.resolve();
api.post('/cutout', upload.single('image'), async (req, res) => {
  const tmp = req.file?.path;
  try {
    const entry = segmenterEntry();
    if (!entry) return res.status(409).json({ error: 'The background removal model is not downloaded: an administrator can download it in Models' });
    let file = null;
    if (tmp) file = tmp;
    else if (UPLOAD_NAME.test(String(req.body?.imageRef || ''))) file = path.join(dirs.uploads, req.body.imageRef);
    else if (req.body?.jobId) {
      const job = await findJob(String(req.body.jobId));
      const f = job.files?.[Number(req.body.index) || 0];
      if (f) file = path.join(dirs.output, path.basename(f));
    }
    if (!file || !fs.existsSync(file) || !imageType(file)) return res.status(400).json({ error: 'This task needs a photo' });
    const size = imageSize(file);
    if (size && size[0] * size[1] > MAX_PIXELS) return res.status(400).json({ error: 'The photo is too large (at most 50 megapixels)' });
    const run = cutoutBusy.then(() => subjectMask(fs.readFileSync(file), path.join(dirs.models, entry.file)));
    cutoutBusy = run.catch(() => {});
    const { png } = await run;
    res.set('Content-Type', 'image/png').set('Cache-Control', 'no-store').send(png);
  } catch (e) {
    console.error(`[cutout] ${e.message}`);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Background removal failed' });
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
});

// A finished image as the photo of a next task (change a part, rework, animate): the result file
// is copied into the uploads and its name returned for the form
api.post('/jobs/:id/as-input', async (req, res) => {
  const job = await findJob(req.params.id);
  const file = job.files?.[Number(req.body?.index) || 0];
  if (!file || !/\.(png|jpe?g|webp)$/i.test(file)) return res.status(400).json({ error: 'Only images can be used as a photo' });
  const src = path.join(dirs.output, path.basename(file));
  const type = fs.existsSync(src) && imageType(src);
  if (!type) return res.status(404).json({ error: 'The file of this job has been deleted' });
  const image = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${type}`;
  fs.copyFileSync(src, path.join(dirs.uploads, image));
  res.json({ image });
});

// Upscale a finished image ×4: the result file becomes the photo of a new upscale job
api.post('/jobs/:id/upscale', async (req, res) => {
  const job = await findJob(req.params.id);
  const file = job.files?.[Number(req.body?.index) || 0];
  if (!file || !/\.(png|jpe?g|webp)$/i.test(file)) return res.status(400).json({ error: 'Only images can be upscaled' });
  const preset = presetsWithAvailability().find((p) => p.tasks.includes('upscale') && p.available);
  if (!preset) return res.status(400).json({ error: 'The upscaler is not downloaded: an administrator can download it in Models' });
  const { jobs } = await workerState();
  if (jobs.filter((j) => j.status === 'queued' && j.user === req.user.username).length >= MAX_QUEUED_PER_USER) {
    return res.status(400).json({ error: 'Too many jobs in the queue (at most 20 per user)' });
  }
  const src = path.join(dirs.output, path.basename(file));
  const type = fs.existsSync(src) && imageType(src);
  if (!type) return res.status(404).json({ error: 'The file of this job has been deleted' });
  const size = imageSize(src);
  if (!size || Math.max(...size) > MAX_UPSCALE_SIDE) return res.status(400).json({ error: 'The photo is too large to upscale (at most 2048 px on the long side)' });
  const image = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${type}`;
  const dest = path.join(dirs.uploads, image);
  fs.copyFileSync(src, dest);
  const body = { presetId: preset.id, prompt: job.params.prompt || '', negative: '', width: size[0] * 4, height: size[1] * 4 };
  try {
    res.json(await callWorker('/v1/jobs', {
      method: 'POST',
      body: { user: req.user.username, params: jobParams(preset, body, image, { image, task: 'upscale' }), spec: jobSpec(preset) },
    }));
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
});

api.post('/jobs/:id/cancel', async (req, res) => {
  const job = await findJob(req.params.id);
  if (!canManage(req, job)) return res.status(403).json({ error: 'This job belongs to another user' });
  res.json(await callWorker(`/v1/jobs/${job.id}/cancel`, { method: 'POST' }));
});

// Restart a failed or cancelled job as it was: same parameters, seed and source image.
// The mode is resolved again from the current catalog, so its models must still be installed.
api.post('/jobs/:id/retry', async (req, res) => {
  const job = await findJob(req.params.id);
  if (!canManage(req, job)) return res.status(403).json({ error: 'This job belongs to another user' });
  if (!['failed', 'cancelled'].includes(job.status)) return res.status(409).json({ error: 'Only failed or cancelled jobs can be restarted' });
  const preset = presetsWithAvailability().find((p) => p.id === job.params?.presetId);
  if (!preset) return res.status(400).json({ error: 'The mode of this job no longer exists' });
  if (!preset.available) return res.status(400).json({ error: 'Models not downloaded: ' + preset.missing.map((m) => m.name).join(', ') });
  for (const k of ['image', 'mask', 'video', 'audio']) {
    if (job.params[k] && !fs.existsSync(path.join(dirs.uploads, path.basename(job.params[k])))) {
      return res.status(400).json({ error: 'The source file of this job has been deleted' });
    }
  }
  res.json(await callWorker(`/v1/jobs/${job.id}/retry`, { method: 'POST', body: { spec: jobSpec(preset) } }));
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

settingsRoutes(api, requireAdmin);
promptRoutes(api);
promptAdminRoutes(api, requireAdmin);

app.use('/api', api);

// Result files are for signed-in users only as well
const files = express.Router();
files.use(requireAuth);
// Files are data, never documents: even if one were opened directly, it could not run scripts
files.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  next();
});
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
  // Both containers start together: give the worker half a minute before reporting it missing
  (async () => {
    for (let i = 0; i < 15; i++) {
      const { worker } = await workerState();
      if (worker.online) {
        if (worker.compatible) console.log(`[web] connected to the worker (API v${worker.api})`);
        else console.warn(`[web] the worker speaks API v${worker.api}, expected v${WORKER_API}: update both containers`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.warn(`[web] the worker is not reachable at ${config.workerUrl}`);
  })();
});

function shutdown() {
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
