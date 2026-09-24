// Очередь генераций поверх sd-cli: строго одна задача на GPU, прогресс парсится из вывода,
// история хранится в /data/state/jobs.json и переживает пересоздание контейнера.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { loadCatalog, modelPath } from './models.js';
import { loadPresets, presetModels } from './presets.js';
import { debouncedWriter, readJson, statePath } from './store.js';

const { dirs } = config;
const JOBS_FILE = statePath('jobs.json');

export let jobs = readJson(JOBS_FILE, []);
for (const j of jobs) {
  if (j.status === 'running') {
    j.status = 'failed';
    j.error = 'Прервано перезапуском контейнера';
    j.finishedAt ??= Date.now();
  }
}
export const save = debouncedWriter(JOBS_FILE, () => jobs);

let current = null; // { job, proc }
export const runningJob = () => current?.job || null;

// ---------- разбор вывода sd-cli ----------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STEP_BAR = /\|[=>\s]*\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+)\s*(s\/it|it\/s)/;
const LOAD_BAR = /\|[#\s]*\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*[KMG]?B\/s/;

function setStage(job, stage) {
  const pr = job.progress;
  if (pr.stage === stage) return;
  const now = Date.now();
  if (pr.stages[pr.stage]) pr.stages[pr.stage].endedAt = now;
  pr.stage = stage;
  pr.stages[stage] = { startedAt: now };
  pr.loading = null;
}

function parseLine(job, line) {
  const pr = job.progress;
  if (!line.trim()) return;
  let m;
  if (/\[ERROR/.test(line) && !/gguf_init_from_reader|failed to read tensor info/.test(line)) {
    job.lastErrors = [...(job.lastErrors || []).slice(-4), line.trim()];
  }
  if ((m = line.match(/save result image \d+ to '([^']+)'/))) {
    job._saved = [...(job._saved || []), m[1]];
    return;
  }
  // Wan идёт через video.cpp, SD 1.5 / AnimateDiff — через image.cpp
  if (/generate_video \d+x\d+x\d+|generating image: \d+\/\d+/.test(line)) return setStage(job, 'sampling');
  if (/sampling completed|generating \d+ latent images completed/.test(line)) return setStage(job, 'decoding');
  if (/decode_first_stage completed/.test(line)) return setStage(job, 'saving');
  if ((m = line.match(STEP_BAR))) {
    let sit = Number(m[3]);
    if (m[4] === 'it/s') sit = sit > 0 ? 1 / sit : 0;
    Object.assign(pr.stages[pr.stage], { cur: Number(m[1]), total: Number(m[2]), sit });
    return;
  }
  if ((m = line.match(LOAD_BAR))) {
    pr.loading = { cur: Number(m[1]), total: Number(m[2]) };
    return;
  }
  if (/loading tensors completed/.test(line)) pr.loading = null;
}

// ---------- вспомогательное ----------

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, err: e.message }));
    p.on('close', (code) => resolve({ code, err }));
  });
}

function slug(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'gen';
}

function stamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function finish(job, status, error) {
  job.status = status;
  job.finishedAt = Date.now();
  if (error) job.error = error;
  const pr = job.progress;
  if (pr?.stages?.[pr.stage] && !pr.stages[pr.stage].endedAt) pr.stages[pr.stage].endedAt = job.finishedAt;
}

const baseName = (job) => `${stamp(job.createdAt)}_${slug(job.params.prompt)}_${job.params.seed}`;

async function makeThumb(job, src) {
  const thumb = path.join(dirs.thumbs, job.id + '.jpg');
  const t = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-i', src,
    '-vf', 'thumbnail,scale=480:-2', '-frames:v', '1', '-q:v', '4', thumb]);
  if (t.code === 0) job.thumb = job.id + '.jpg';
}

// segments — AVI сегментов по порядку; начиная со второго, первый кадр сегмента совпадает
// с последним кадром предыдущего (он был стартовой картинкой) и выбрасывается при склейке
async function finalizeVideo(job, segments) {
  const base = baseName(job);
  const mp4 = path.join(dirs.output, base + '.mp4');
  const { fps, outFps } = job.params;
  const interp = outFps && outFps !== fps
    ? `minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : null;
  const encode = (withInterp) => {
    const inputs = segments.flatMap((f) => ['-i', f]);
    const parts = segments.map((f, i) => (i === 0
      ? '[0:v]setpts=PTS-STARTPTS[s0]'
      : `[${i}:v]trim=start_frame=1,setpts=PTS-STARTPTS[s${i}]`));
    const chain = segments.length > 1
      ? `${parts.join(';')};${segments.map((f, i) => `[s${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[c]`
      : '[0:v]null[c]';
    const graph = `${chain};[c]${withInterp && interp ? interp : 'null'}[out]`;
    return runCmd('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[out]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', mp4]);
  };
  let conv = await encode(true);
  if (conv.code !== 0 && interp) {
    job.warning = `Интерполяция до ${outFps} fps не удалась, сохранено с ${fps} fps`;
    conv = await encode(false);
  }
  if (conv.code === 0) {
    for (const f of segments) fs.rmSync(f, { force: true });
    job.files = [base + '.mp4'];
  } else {
    // Без ffmpeg оставляем хотя бы первый сегмент как есть
    fs.renameSync(segments[0], path.join(dirs.output, base + '.avi'));
    for (const f of segments.slice(1)) fs.rmSync(f, { force: true });
    job.files = [base + '.avi'];
    job.warning = 'Не удалось собрать mp4: ' + conv.err.trim().slice(0, 300);
  }
  await makeThumb(job, path.join(dirs.output, job.files[0]));
}

async function finalizeImages(job) {
  const base = baseName(job);
  const saved = (job._saved || []).filter((f) => fs.existsSync(f));
  delete job._saved;
  if (!saved.length) throw new Error('sd-cli не сохранил ни одного изображения');
  job.files = saved.map((src, i) => {
    const name = saved.length > 1 ? `${base}_${i + 1}.png` : `${base}.png`;
    fs.renameSync(src, path.join(dirs.output, name));
    return name;
  });
  await makeThumb(job, path.join(dirs.output, job.files[0]));
}

// ---------- сборка команды ----------

const ROLE_FLAGS = {
  model: '--model',
  diffusion: '--diffusion-model',
  high_noise: '--high-noise-diffusion-model',
  vae: '--vae',
  t5xxl: '--t5xxl',
  clip_vision: '--clip_vision',
  motion_module: '--motion-module',
};

function buildArgs(job, preset, outBase, initImage) {
  const p = job.params;
  const catalog = loadCatalog();
  const args = ['-M', preset.kind === 'image' ? 'img_gen' : 'vid_gen'];
  for (const { role, id, entry } of presetModels(preset, catalog)) {
    if (!entry) throw new Error(`В каталоге нет модели ${id}`);
    if (!fs.existsSync(modelPath(entry))) throw new Error(`Модель не скачана: ${entry.name}`);
    if (ROLE_FLAGS[role]) args.push(ROLE_FLAGS[role], modelPath(entry));
  }
  if (preset.loraDir) args.push('--lora-model-dir', path.join(dirs.models, preset.loraDir));
  args.push('-p', p.prompt + (preset.promptSuffix || ''));
  if (p.negative) args.push('-n', p.negative);
  args.push('-W', String(p.width), '-H', String(p.height), '--steps', String(p.steps),
    '--cfg-scale', String(p.cfg), '--sampling-method', p.sampler, '-s', String(p.seed));
  if (preset.kind === 'image') {
    if (p.count > 1) args.push('-b', String(p.count));
  } else {
    args.push('--video-frames', String(p.frames), '--fps', String(p.fps));
  }
  if (p.flowShift != null) args.push('--flow-shift', String(p.flowShift));
  // Продолжение сегмента держится ближе к последнему кадру (continueArgs), чем обычное «картинка → видео»
  if (initImage) args.push('-i', initImage, ...(preset.continueArgs || preset.imageArgs || []));
  else if (p.image) args.push('-i', path.join(dirs.uploads, p.image), ...(preset.imageArgs || []));
  if (preset.preview && preset.preview !== 'none') {
    args.push('--preview', preset.preview, '--preview-path', path.join(dirs.previews, job.id + (preset.kind === 'image' ? '.png' : '.webp')),
      '--preview-interval', '1');
  }
  args.push(...(preset.extraArgs || []));
  args.push('-o', preset.kind === 'image' ? `${outBase}.png` : `${outBase}.avi`);
  return args;
}

// ---------- исполнение ----------

// Один запуск sd-cli: вывод пишется в лог и разбирается на прогресс
function runSd(job, args, log) {
  return new Promise((resolve) => {
    log.write('$ ' + [config.sdCli, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ') + '\n');
    const proc = spawn(config.sdCli, args, { env: process.env });
    current.proc = proc;
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      log.write(s);
      buf += s;
      const parts = buf.split(/[\r\n]+/);
      buf = parts.pop();
      for (const line of parts) parseLine(job, line.replace(ANSI, ''));
      const tail = buf.replace(ANSI, '');
      if (STEP_BAR.test(tail) || LOAD_BAR.test(tail)) parseLine(job, tail);
      save();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    let spawnError = null;
    proc.on('error', (e) => (spawnError = e));
    proc.on('close', (code, signal) => {
      if (buf) parseLine(job, buf.replace(ANSI, ''));
      resolve({ code, signal, spawnError });
    });
  });
}

function newProgress(segment, segments, doneSegments = []) {
  return { stage: 'prepare', stages: { prepare: { startedAt: Date.now() } }, loading: null, segment, segments, doneSegments };
}

async function run(job) {
  const preset = loadPresets().find((p) => p.id === job.params.presetId);
  const segments = job.params.segments || 1;
  const tmpBase = path.join(dirs.output, `.${job.id}`);
  const outputs = [];
  job.startedAt = Date.now();
  job.progress = newProgress(1, segments);
  current = { job, proc: null };
  const log = fs.createWriteStream(path.join(dirs.logs, job.id + '.log'));
  const cleanup = () => {
    for (let i = 0; i < segments; i++) {
      fs.rmSync(`${tmpBase}_s${i}.avi`, { force: true });
      fs.rmSync(`${tmpBase}_s${i}_last.png`, { force: true });
    }
    for (const f of job._saved || []) fs.rmSync(f, { force: true });
    delete job._saved;
  };

  try {
    if (!preset) throw new Error('Пресет не найден: ' + job.params.presetId);
    job.status = 'running';
    save(true);
    for (let i = 0; i < segments && job.status === 'running'; i++) {
      let init = null;
      if (i > 0) {
        // Продолжение: последний кадр предыдущего сегмента становится стартовым кадром следующего
        init = `${tmpBase}_s${i - 1}_last.png`;
        const r = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-sseof', '-0.5', '-i', outputs[i - 1],
          '-update', '1', '-q:v', '1', init]);
        if (r.code !== 0 || !fs.existsSync(init)) throw new Error('Не удалось взять последний кадр сегмента: ' + r.err.trim());
        const prev = job.progress;
        job.progress = newProgress(i + 1, segments,
          [...prev.doneSegments, { startedAt: prev.stages.prepare.startedAt, endedAt: Date.now() }]);
      }
      const outBase = `${tmpBase}_s${i}`;
      const args = buildArgs(job, preset, outBase, init);
      if (i === 0) job.cmd = [config.sdCli, ...args].join(' ');
      const { code, signal, spawnError } = await runSd(job, args, log);
      if (job.status !== 'running') break;
      if (code !== 0) {
        throw new Error(spawnError?.message || job.lastErrors?.at(-1)
          || `sd-cli завершился с кодом ${code}${signal ? ` (${signal})` : ''}`);
      }
      if (preset.kind !== 'image') {
        if (!fs.existsSync(`${outBase}.avi`)) throw new Error('sd-cli не сохранил видео');
        outputs.push(`${outBase}.avi`);
      }
    }
    if (job.status === 'cancelled') {
      cleanup();
    } else {
      setStage(job, 'saving');
      if (preset.kind === 'image') await finalizeImages(job);
      else await finalizeVideo(job, outputs);
      cleanup();
      finish(job, 'done');
    }
  } catch (e) {
    cleanup();
    if (job.status !== 'cancelled') finish(job, 'failed', e.message);
  }
  log.end();
  job.durationSec = Math.round((job.finishedAt - job.startedAt) / 1000);
  current = null;
  save(true);
  nextJob();
}

export function nextJob() {
  if (current) return;
  const job = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
  if (job) run(job);
}

// ---------- создание, отмена, удаление ----------

const OUT_FPS = [24, 30, 50, 60, 120];

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

// Wan требует 4n+1 кадров; AnimateDiff — ровно duration × fps (лучше всего 16)
function planFrames(d, duration) {
  const nativeFps = d.nativeFps ?? 24;
  const raw = duration * nativeFps;
  const frames = d.frameRule === 'exact' ? Math.round(raw) : Math.round(raw / 4) * 4 + 1;
  return Math.min(d.maxFrames ?? 121, Math.max(d.minFrames ?? 5, frames));
}

// «Экстра» — вдвое больше шагов, чем «Высокое», если режим не задал своё значение
export function qualitySteps(d, quality) {
  const q = d.quality || {};
  if (quality === 'extra') return q.extra ?? (q.high ? q.high * 2 : null);
  return q[quality] ?? null;
}

// Предел модели за один проход и экстра-предел (склейка двух сегментов через «картинка → видео»)
export function durationLimits(preset) {
  const d = preset.defaults || {};
  const nativeFps = d.nativeFps ?? 24;
  const maxFrames = d.maxFrames ?? 121;
  const base = (d.frameRule === 'exact' ? maxFrames : maxFrames - 1) / nativeFps;
  const extendable = preset.kind === 'video' && preset.image !== 'none';
  return { base, max: extendable ? base * 2 : base, extendable };
}

export function createJob(preset, body, user, image) {
  const d = preset.defaults || {};
  const round16 = (v) => Math.round(v / 16) * 16;
  const quality = qualitySteps(d, body.quality) != null ? body.quality : 'normal';
  let seed = Math.trunc(Number(body.seed));
  if (!Number.isFinite(seed) || seed < 0) seed = crypto.randomInt(0, 2 ** 31 - 1);

  const params = {
    kind: preset.kind,
    presetId: preset.id,
    presetName: preset.name,
    prompt: String(body.prompt || '').trim(),
    negative: String(body.negative ?? '').trim(),
    width: round16(clamp(body.width, 128, 2048, d.width ?? 512)),
    height: round16(clamp(body.height, 128, 2048, d.height ?? 512)),
    quality,
    steps: qualitySteps(d, quality) ?? d.steps ?? 20,
    cfg: clamp(body.cfg, 0, 30, d.cfg ?? 7),
    flowShift: d.flowShift == null ? null : clamp(body.flowShift, 0, 30, d.flowShift),
    sampler: /^[a-z0-9_+]+$/.test(body.sampler || '') ? body.sampler : d.sampler || 'euler',
    seed,
    image,
  };
  if (preset.kind === 'image') {
    params.count = Math.round(clamp(body.count, 1, 8, 1));
  } else {
    const nativeFps = d.nativeFps ?? 24;
    const exact = d.frameRule === 'exact';
    const lim = durationLimits(preset);
    const duration = clamp(body.duration, 0.5, lim.max, d.duration ?? 2);
    // Длиннее предела модели — два сегмента, второй продолжает последний кадр первого
    const segments = duration > lim.base + 1e-6 ? 2 : 1;
    const frames = planFrames(d, duration / segments);
    const segSeconds = (exact ? frames : frames - 1) / nativeFps;
    Object.assign(params, {
      frames,
      segments,
      fps: nativeFps,
      duration: segSeconds * segments,
      outFps: OUT_FPS.includes(Number(body.outFps)) ? Number(body.outFps) : d.outFps ?? nativeFps,
    });
  }
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    status: 'queued',
    createdAt: Date.now(),
    user: user.username,
    params,
  };
  jobs.push(job);
  save(true);
  nextJob();
  return job;
}

export function cancelJob(job) {
  if (job.status === 'queued') {
    finish(job, 'cancelled');
  } else if (job.status === 'running' && current?.job === job) {
    finish(job, 'cancelled');
    // Между сегментами sd-cli не запущен: цикл сам увидит статус cancelled и остановится
    const { proc } = current;
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      }, 10000);
    }
  }
  save(true);
}

export function deleteJob(job) {
  cancelJob(job);
  jobs = jobs.filter((j) => j !== job);
  const rm = (p) => fs.rmSync(p, { force: true });
  for (const f of job.files || []) rm(path.join(dirs.output, f));
  rm(path.join(dirs.thumbs, job.id + '.jpg'));
  for (const ext of ['.webp', '.png']) rm(path.join(dirs.previews, job.id + ext));
  rm(path.join(dirs.logs, job.id + '.log'));
  const img = job.params?.image;
  if (img && !jobs.some((j) => j.params?.image === img)) rm(path.join(dirs.uploads, img));
  save(true);
}

export function jobSummary(j) {
  const { cmd, ...out } = j;
  if (j.status === 'running') {
    for (const ext of ['.webp', '.png']) {
      try {
        out.previewAt = fs.statSync(path.join(dirs.previews, j.id + ext)).mtimeMs;
        out.previewExt = ext;
        break;
      } catch {}
    }
  }
  return out;
}

export function jobLog(job, tail) {
  const file = path.join(dirs.logs, job.id + '.log');
  let text = '';
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, st.size - len);
    fs.closeSync(fd);
    text = b.toString('utf8');
  } catch {}
  return text.replace(ANSI, '').split(/[\r\n]+/).filter((l) => l.trim()).slice(-tail);
}

// Модели, занятые текущей генерацией, удалять нельзя
export function modelsInUse() {
  const job = runningJob();
  if (!job) return new Set();
  const preset = loadPresets().find((p) => p.id === job.params.presetId);
  return new Set(Object.values(preset?.models || {}));
}

export function shutdownJobs() {
  if (current) {
    finish(current.job, 'failed', 'Контейнер остановлен во время генерации');
    current.proc?.kill('SIGTERM');
  }
  save(true);
}
