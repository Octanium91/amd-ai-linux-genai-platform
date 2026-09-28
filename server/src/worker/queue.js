// Generation queue on top of sd-cli (images, video) and audio.cpp (music, sound effects, speech):
// strictly one job on the GPU, progress parsed from the engine's output,
// history kept in /data/state/jobs.json so it survives container re-creation.
// Jobs arrive from the web container already validated, with a snapshot of the mode (`spec`):
// the worker does not read the catalog, so catalog and UI updates never require restarting it.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../common/config.js';
import { debouncedWriter, readJson, statePath } from '../common/store.js';
import { colorMatchFilter, frameStats } from './color.js';
import { closeInterrupted, startTelemetry } from './telemetry.js';

const { dirs } = config;
const JOBS_FILE = statePath('jobs.json');

export let jobs = readJson(JOBS_FILE, []);
export const save = debouncedWriter(JOBS_FILE, () => jobs);

// A job that was running when the container stopped (restart, power loss) cannot resume.
// Persist the change right away so the state file never keeps a stale "running" job.
const interrupted = [];
for (const j of jobs) {
  if (j.status === 'running') {
    j.status = 'failed';
    j.error = 'Interrupted by a container restart';
    j.finishedAt ??= Date.now();
    if (j.startedAt) j.durationSec = Math.round((j.finishedAt - j.startedAt) / 1000);
    interrupted.push(j);
  }
}
if (interrupted.length) save(true);
closeInterrupted(interrupted);

// Temporary files of jobs interrupted by a restart (.<job id>_s<n>… segments, _ctrl control frame
// directories, _ref prepared references, _snd soundtracks, _audio.wav engine output) are useless: remove them
try {
  for (const f of fs.readdirSync(dirs.output)) {
    if (/^\.[0-9a-f]{12}_(s\d+|ctrl|ref|snd|audio)/.test(f)) fs.rmSync(path.join(dirs.output, f), { recursive: true, force: true });
  }
} catch {}

let current = null; // { job, proc }
export const runningJob = () => current?.job || null;

// ---------- sd-cli output parsing ----------

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
  if (current?.job === job) current.tel?.phase(stage, { segment: pr.segment, ...(pr.image ? { image: pr.image } : {}) });
}

// audio.cpp with --log prints one timing or trace line per phase ("ace_step.planner.…",
// "stable_audio.…"), not per step: the stage follows the phase, the time comes from the estimate
function parseAudioLine(job, line) {
  if (!line.trim()) return;
  if (/failed|error/i.test(line) && !/^\[(TIMING|TRACE)/.test(line)) {
    job.lastErrors = [...(job.lastErrors || []).slice(-4), line.trim()];
    return;
  }
  const m = line.match(/^\[(?:TIMING|TRACE)[^\]]*\]\s+(\S+)/);
  if (m) {
    const key = m[1];
    if (/\.weights\.|\.load|runtime\.model/.test(key)) return;
    if (/(^|\.)(vae|autoencoder|vocoder|codec)\.(decode|run|compute|total)|decode_ms|vae_decode/.test(key)) return setStage(job, 'decoding');
    if (/(planner|diffusion|dit|sampl|flow|generate|encode|synth|acoustic|duration|text)/.test(key) && job.progress.stage === 'prepare') return setStage(job, 'sampling');
    return;
  }
  if (/^audio_out=/.test(line)) setStage(job, 'saving');
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
  // Wan goes through video.cpp, SD 1.5 / AnimateDiff through image.cpp
  // A batch of images is sampled one image after another and decoded together at the end
  if ((m = line.match(/generating image: (\d+)\/(\d+)/))) {
    const again = pr.stage === 'sampling';
    pr.image = Number(m[1]);
    pr.images = Number(m[2]);
    if (again && current?.job === job) current.tel?.phase('sampling', { segment: pr.segment, image: pr.image });
    return setStage(job, 'sampling');
  }
  if (/generate_video \d+x\d+x\d+/.test(line)) return setStage(job, 'sampling');
  if (/generating \d+ latent images completed/.test(line)) return setStage(job, 'decoding');
  if (/sampling completed/.test(line)) {
    if (pr.images && pr.image < pr.images) return;
    return setStage(job, 'decoding');
  }
  if (/decode_first_stage completed/.test(line)) return setStage(job, 'saving');
  if ((m = line.match(STEP_BAR))) {
    let sit = Number(m[3]);
    if (m[4] === 'it/s') sit = sit > 0 ? 1 / sit : 0;
    Object.assign(pr.stages[pr.stage], { cur: Number(m[1]), total: Number(m[2]), sit });
    if (current?.job === job) current.tel?.step(pr.segment, pr.image || 1, pr.stage, Number(m[1]), Number(m[2]), sit);
    return;
  }
  if ((m = line.match(LOAD_BAR))) {
    pr.loading = { cur: Number(m[1]), total: Number(m[2]) };
    return;
  }
  if (/loading tensors completed/.test(line)) pr.loading = null;
}

// ---------- helpers ----------

// Helper commands (ffmpeg); with telemetry on, each one is a phase of its own and is recorded
function runCmd(cmd, args, phase, timeoutMs = 30 * 60 * 1000, withOut = false) {
  const tel = current?.tel;
  if (tel && phase) tel.phase(phase, { segment: current.job.progress?.segment });
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', withOut ? 'pipe' : 'ignore', 'pipe'] });
    // A cancel kills the job's current process: during ffmpeg that is this one
    const owner = current;
    if (owner) owner.proc = p;
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    if (tel) tel.pid = p.pid;
    let err = '';
    let out = '';
    p.stderr.on('data', (d) => (err += d));
    if (withOut) p.stdout.on('data', (d) => (out += d));
    const done = (r) => {
      clearTimeout(timer);
      if (owner?.proc === p) owner.proc = null;
      if (tel) {
        tel.pid = null;
        tel.command({ program: cmd, phase: phase || null, args, exitCode: r.code, startedAt, endedAt: Date.now(), error: r.code ? r.err.trim().slice(-500) : null });
      }
      resolve(r);
    };
    p.on('error', (e) => done({ code: -1, err: e.message }));
    p.on('close', (code) => done({ code, err, out }));
  });
}

function slug(text, fallback = 'gen') {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || fallback;
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

// The job id keeps names unique: two jobs queued in the same second with the same prompt and seed
// (for example the same scene at two sizes) would otherwise write the same file
const baseName = (job) => `${stamp(job.createdAt)}_${job.params.task === 'upscale' ? 'upscale-x4_' : ''}${slug(job.params.prompt, job.params.kind === 'audio' ? job.params.task : 'gen')}_${job.params.seed}_${job.id.slice(0, 6)}`;

async function makeThumb(job, src) {
  const thumb = path.join(dirs.thumbs, job.id + '.jpg');
  const t = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-i', src,
    '-vf', 'thumbnail,scale=480:-2', '-frames:v', '1', '-q:v', '4', thumb], 'ffmpeg.thumbnail');
  if (t.code === 0) job.thumb = job.id + '.jpg';
}

// segments are the segment AVIs in order; from the second one on, the first frame of a segment
// duplicates the last frame of the previous one (it was the init image) and is dropped when joining
async function finalizeVideo(job, segments, luts = [], shots = false) {
  const base = baseName(job);
  const mp4 = path.join(dirs.output, base + '.mp4');
  const { fps, outFps } = job.params;
  // Every segment after the first drops its first frame (it repeats the previous segment's last one)
  // Shots are separate takes joined whole; continued parts share their seam frame
  const totalFrames = segments.length * job.params.frames - (shots ? 0 : segments.length - 1);
  const seconds = totalFrames / fps;
  const interp = outFps && outFps !== fps
    ? `minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : null;
  const encode = (withInterp) => {
    const inputs = segments.flatMap((f) => ['-i', f]);
    const parts = segments.map((f, i) => (i === 0
      ? '[0:v]setpts=PTS-STARTPTS[s0]'
      : shots ? `[${i}:v]setpts=PTS-STARTPTS[s${i}]`
        : `[${i}:v]trim=start_frame=1,setpts=PTS-STARTPTS${luts[i] ? `,${luts[i]}` : ''}[s${i}]`));
    const chain = segments.length > 1
      ? `${parts.join(';')};${segments.map((f, i) => `[s${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[c]`
      : '[0:v]null[c]';
    // Exact length: setpts drops the frame rate, so the last frame lost its duration (2 s became
    // 1.79 s); fps= restores it. minterpolate needs frames beyond the end to reach it, so the last
    // frame is repeated (tpad) and the output is cut to the exact number of frames.
    const useInterp = withInterp && interp;
    const graph = `${chain};[c]fps=${fps}${useInterp ? `,tpad=stop_mode=clone:stop=3,${interp}` : ''}[out]`;
    const outFrames = useInterp ? Math.round(seconds * outFps) : totalFrames;
    return runCmd('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[out]', '-frames:v', String(outFrames),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', mp4], withInterp && interp ? 'ffmpeg.encode+interpolate' : 'ffmpeg.encode');
  };
  let conv = await encode(true);
  if (conv.code !== 0 && interp) {
    job.warning = `Interpolation to ${outFps} fps failed, saved at ${fps} fps`;
    conv = await encode(false);
  }
  if (conv.code === 0) {
    for (const f of segments) fs.rmSync(f, { force: true });
    if (job.params.audio) await addSoundtrack(job, mp4, seconds);
    job.files = [base + '.mp4'];
  } else {
    // Without an mp4 keep every segment as is: they may be hours of GPU work
    fs.rmSync(mp4, { force: true });
    job.files = segments.map((f, i) => {
      const name = segments.length > 1 ? `${base}_${i + 1}.avi` : `${base}.avi`;
      fs.renameSync(f, path.join(dirs.output, name));
      return name;
    });
    job.warning = 'Could not build the mp4: ' + conv.err.trim().slice(0, 300);
  }
  await makeThumb(job, path.join(dirs.output, job.files[0]));
}

// The soundtrack: the chosen audio (or the sound of a video) from audioStart, cut or padded with
// silence to the clip's exact length, with a short fade-in against a click and, unless turned off,
// a fade-out at the end. If it fails, the clip stays silent: the GPU work is not lost over the sound.
async function addSoundtrack(job, mp4, seconds) {
  const p = job.params;
  const tmp = path.join(dirs.output, `.${job.id}_snd.mp4`);
  const fadeOut = Math.min(1.5, seconds / 4);
  const filters = ['asetpts=PTS-STARTPTS', 'apad', `atrim=end=${seconds.toFixed(3)}`, 'afade=t=in:d=0.05'];
  if (p.audioFade !== false) filters.push(`afade=t=out:st=${(seconds - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  const r = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-i', mp4, '-ss', String(p.audioStart || 0), '-i', path.join(dirs.uploads, p.audio),
    '-filter_complex', `[1:a:0]${filters.join(',')}[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', tmp], 'ffmpeg.soundtrack');
  if (r.code === 0) return fs.renameSync(tmp, mp4);
  fs.rmSync(tmp, { force: true });
  console.error(`[worker] ${job.id}: soundtrack: ${r.err.trim().slice(-300)}`);
  job.warning = 'The sound could not be added; the video was saved without it';
}

// Inpainting repaints the masked part, but sd-cli returns the whole image through the VAE, which
// softens the rest and leaves a seam at the latent grid. The original photo is pasted back outside
// the mask, widened and feathered, as sd-cli framed it (scaled and centre-cropped to the job size).
async function compositeInpaint(job, file) {
  const p = job.params;
  const fit = `scale=${p.width}:${p.height}:force_original_aspect_ratio=increase,crop=${p.width}:${p.height}`;
  const graph = `[0]${fit},format=gbrp[o];[1]scale=${p.width}:${p.height},format=gbrp[g];`
    + `[2]${fit},format=gray,dilation,dilation,dilation,dilation,gblur=sigma=6,format=gbrp[m];[o][g][m]maskedmerge,format=rgb24`;
  const tmp = `${file}.comp.png`;
  const r = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dirs.uploads, p.image), '-i', file,
    '-i', path.join(dirs.uploads, p.mask), '-filter_complex', graph, '-frames:v', '1', tmp], 'ffmpeg.composite');
  if (r.code === 0 && fs.existsSync(tmp)) fs.renameSync(tmp, file);
  else {
    fs.rmSync(tmp, { force: true });
    job.warning = 'The repainted part could not be blended into the original photo; the whole image is from the model';
  }
}

async function finalizeImages(job) {
  const base = baseName(job);
  const saved = (job._saved || []).filter((f) => fs.existsSync(f));
  delete job._saved;
  if (!saved.length) throw new Error('sd-cli did not save any image');
  if (job.params.task === 'inpaint' && job.params.mask) for (const f of saved) await compositeInpaint(job, f);
  job.files = saved.map((src, i) => {
    const name = saved.length > 1 ? `${base}_${i + 1}.png` : `${base}.png`;
    fs.renameSync(src, path.join(dirs.output, name));
    return name;
  });
  await makeThumb(job, path.join(dirs.output, job.files[0]));
}

// ---------- command line (from the job's spec) ----------

const ROLE_FLAGS = {
  model: '--model',
  diffusion: '--diffusion-model',
  high_noise: '--high-noise-diffusion-model',
  vae: '--vae',
  // A tiny autoencoder (TAEHV) instead of the VAE: decodes a Wan clip in seconds
  tae: '--tae',
  t5xxl: '--t5xxl',
  clip_vision: '--clip_vision',
  motion_module: '--motion-module',
  // A language model as the text encoder (Z-Image: Qwen3)
  llm: '--llm',
  // An ESRGAN upscaler (the upscale task)
  upscaler: '--upscale-model',
};

// The mode's image arguments with the job's own strength instead of the mode's, when it has one
function imageArgs(preset, p) {
  const a = [...(preset.imageArgs || [])];
  const i = a.indexOf('--strength');
  if (p.strength != null) {
    if (i >= 0) a.splice(i, 2);
    a.push('--strength', String(p.strength));
  }
  return a;
}

function modelArgs(preset) {
  const args = [];
  for (const { role, name, file } of preset.models) {
    const full = path.join(dirs.models, file);
    if (!fs.existsSync(full)) throw new Error(`Model not downloaded: ${name}`);
    if (ROLE_FLAGS[role]) args.push(ROLE_FLAGS[role], full);
  }
  return args;
}

// seg is the part of a long video: each part has its own prompt (a storyboard) and its own seed,
// since the same seed tends to repeat the same motion
function buildArgs(job, preset, outBase, initImage, controlDir, refImage, seg = 0, keyImage = null) {
  const p = job.params;
  // Upscaling runs the ESRGAN model alone: no prompt, no sampling
  if (p.task === 'upscale') {
    return ['-M', 'upscale', ...modelArgs(preset), '-i', path.join(dirs.uploads, p.image), ...(preset.extraArgs || []), '-o', `${outBase}.png`];
  }
  const args = ['-M', preset.kind === 'image' ? 'img_gen' : 'vid_gen', ...modelArgs(preset)];
  if (preset.loraDir) args.push('--lora-model-dir', path.join(dirs.models, preset.loraDir));
  args.push('-p', (p.prompts?.[seg] || p.prompt) + (preset.promptSuffix || ''));
  if (p.negative) args.push('-n', p.negative);
  args.push('-W', String(p.width), '-H', String(p.height), '--steps', String(p.steps),
    '--cfg-scale', String(p.cfg), '--sampling-method', p.sampler, '-s', String(p.seed + seg));
  if (preset.kind === 'image') {
    if (p.count > 1) args.push('-b', String(p.count));
  } else {
    args.push('--video-frames', String(p.frames), '--fps', String(p.fps));
  }
  if (p.flowShift != null) args.push('--flow-shift', String(p.flowShift));
  // A continuation segment stays closer to the last frame (continueArgs) than regular image-to-video
  if (keyImage) args.push('-i', keyImage, ...imageArgs(preset, p));
  else if (initImage) args.push('-i', initImage, ...(preset.continueArgs || preset.imageArgs || []));
  else if (refImage) args.push('-i', refImage);
  else if (p.image) args.push('-i', path.join(dirs.uploads, p.image), ...imageArgs(preset, p));
  // Inpainting: white in the mask is repainted, black is kept
  if (p.mask && !initImage) args.push('--mask', path.join(dirs.uploads, p.mask));
  // Video to video (VACE): the frames that carry the motion of the uploaded video
  if (controlDir) args.push('--control-video', controlDir);
  if (preset.preview && preset.preview !== 'none') {
    args.push('--preview', preset.preview, '--preview-path', path.join(dirs.previews, job.id + (preset.kind === 'image' ? '.png' : '.webp')),
      '--preview-interval', '1');
  }
  args.push(...(preset.extraArgs || []));
  args.push('-o', preset.kind === 'image' ? `${outBase}.png` : `${outBase}.avi`);
  return args;
}

// ---------- execution ----------

// One sd-cli run: output goes to the log and is parsed into progress
function runSd(job, args, log, program = config.sdCli, parse = parseLine) {
  return new Promise((resolve) => {
    log.write('$ ' + [program, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ') + '\n');
    const proc = spawn(program, args, { env: process.env });
    current.proc = proc;
    const tel = current.tel;
    const startedAt = Date.now();
    if (tel) tel.pid = proc.pid;
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      log.write(s);
      buf += s;
      const parts = buf.split(/[\r\n]+/);
      buf = parts.pop();
      for (const line of parts) parse(job, line.replace(ANSI, ''));
      const tail = buf.replace(ANSI, '');
      if (STEP_BAR.test(tail) || LOAD_BAR.test(tail)) parse(job, tail);
      save();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    let spawnError = null;
    proc.on('error', (e) => (spawnError = e));
    proc.on('close', (code, signal) => {
      if (buf) parse(job, buf.replace(ANSI, ''));
      if (tel) {
        tel.pid = null;
        tel.command({ program: path.basename(program), segment: job.progress?.segment, args, exitCode: code, signal, startedAt, endedAt: Date.now(),
          error: code ? spawnError?.message || job.lastErrors?.at(-1) || null : null });
      }
      resolve({ code, signal, spawnError });
    });
  });
}

// The control video for video to video (VACE): the uploaded video at the job's fps and size,
// cut to its frame count, as contours (edges: keeps the motion and shapes, the look comes from the
// prompt and the reference) or in grayscale (gray: keeps more of the original). Frames go to a
// directory, as sd-cli expects; a shorter video gives fewer frames, and the job follows it (4n+1).
async function controlFrames(job, tmpBase) {
  const p = job.params;
  const dir = `${tmpBase}_ctrl`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Denoising and a light blur first: per-frame edges of noise and texture flicker, and VACE reads flicker as motion
  const look = p.control === 'gray' ? 'format=gray' : 'hqdn3d=4:3:6:4,gblur=sigma=1.2,edgedetect=low=0.1:high=0.25';
  // sd-cli loads only RGB frames: contours and grayscale are written with three channels
  const vf = `fps=${p.fps},scale=${p.width}:${p.height}:force_original_aspect_ratio=increase,crop=${p.width}:${p.height},${look},format=rgb24`;
  const r = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dirs.uploads, p.video), '-vf', vf,
    '-frames:v', String(p.frames), path.join(dir, 'frame_%04d.png')], 'ffmpeg.control_video');
  const n = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length : 0;
  if (job.status !== 'running') return null;
  // A damaged end of the file still leaves usable frames: only too few of them fail the job
  if (n < 5) throw new Error('Could not read the video: ' + (r.err.trim().slice(-300) || 'too few frames'));
  if (r.code !== 0) job.warning = 'The video could not be read to the end; its readable part was used';
  const frames = Math.floor((n - 1) / 4) * 4 + 1;
  if (frames < p.frames) {
    for (const f of fs.readdirSync(dir).sort().slice(frames)) fs.rmSync(path.join(dir, f), { force: true });
    p.frames = frames;
    p.duration = (frames - 1) / p.fps;
  }
  return dir;
}

// The reference photo for VACE, prepared the way VACE itself does it: scaled to fit the frame and
// centred on a white canvas. sd-cli would crop it to the frame and could cut off a head or legs.
// audio.cpp arguments: the mode names the engine family and task (spec.engine), the job the text,
// the length, the lyrics or the voice. The model is one self-contained GGUF file.
function buildAudioArgs(job, spec, outWav) {
  const p = job.params;
  const e = spec.engine || {};
  const model = spec.models.find((m) => m.role === 'model') || spec.models[0];
  const full = model && path.join(dirs.models, model.file);
  if (!full || !fs.existsSync(full)) throw new Error(`Model not downloaded: ${model?.name || 'audio model'}`);
  const threads = Math.max(2, Math.min(8, os.availableParallelism?.() || os.cpus().length));
  const args = ['--log', '--threads', String(threads), '--task', e.task || 'gen', '--family', e.family, '--model', full,
    '--backend', 'vulkan', '--text', p.prompt, '--seed', String(p.seed), '--out', outWav];
  if (e.route) args.push('--task-route', e.route);
  if ((e.task || 'gen') === 'gen' && p.duration) args.push('--duration-seconds', String(p.duration));
  if (p.steps && e.steps !== false) args.push('--num-inference-steps', String(p.steps));
  if (p.task === 'music') args.push('--lyrics', p.lyrics ?? '');
  if (p.task === 'speech') {
    if (p.language) args.push('--language', p.language);
    if (p.voice) args.push('--voice-id', p.voice);
    if (p.speed) args.push('--request-option', `speed=${p.speed}`);
  }
  return [...args, ...(spec.extraArgs || [])];
}

// The engine writes a WAV; the library keeps an MP3 (a tenth of the size, plays everywhere) and a
// waveform picture as the thumbnail
async function finalizeAudio(job, wav) {
  const base = baseName(job);
  const mp3 = path.join(dirs.output, base + '.mp3');
  const conv = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '256k', mp3], 'ffmpeg.encode');
  if (conv.code === 0) {
    fs.rmSync(wav, { force: true });
    job.files = [base + '.mp3'];
  } else {
    fs.rmSync(mp3, { force: true });
    fs.renameSync(wav, path.join(dirs.output, base + '.wav'));
    job.files = [base + '.wav'];
    job.warning = 'Could not build the mp3: ' + conv.err.trim().slice(0, 300);
  }
  const src = path.join(dirs.output, job.files[0]);
  const probe = await runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], null, 30000, true);
  const sec = Number(probe.out?.trim());
  if (Number.isFinite(sec) && sec > 0) job.audioSec = Math.round(sec * 10) / 10;
  const thumb = path.join(dirs.thumbs, job.id + '.jpg');
  const t = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-filter_complex',
    'color=c=0x17181f:s=640x360[bg];[0:a]aformat=channel_layouts=mono,showwavespic=s=640x220:colors=0x8b7cf6[w];[bg][w]overlay=0:70,format=yuvj420p',
    '-frames:v', '1', '-q:v', '4', thumb], 'ffmpeg.thumbnail');
  if (t.code === 0) job.thumb = job.id + '.jpg';
}

// A shot of a long video starts from its own keyframe: the image model of spec.keyframe draws the
// part's scene (at its own size, of the video's shape), and ffmpeg fits it to the video size. The
// video model then animates it like a photo, so the action of every part really changes.
function quietParse(job, line) {
  if (/\[ERROR/.test(line) && !/gguf_init_from_reader|failed to read tensor info/.test(line)) {
    job.lastErrors = [...(job.lastErrors || []).slice(-4), line.trim()];
  }
}

// From the second shot on, the keyframe is redrawn from the last frame of the previous shot with the
// next action (image to image at strength 0.65): the new shot starts where the last one ended, with
// the same place, light and characters, instead of a brand-new picture.
async function keyframe(job, i, tmpBase, log, prevShot = null) {
  const k = job.spec.keyframe;
  const p = job.params;
  const outBase = `${tmpBase}_s${i}_key`;
  let from = null;
  if (prevShot) {
    from = `${tmpBase}_s${i}_from.png`;
    const r = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-sseof', '-0.3', '-i', prevShot, '-update', '1', '-q:v', '1', from], 'ffmpeg.last_frame');
    if (job.status !== 'running') return null;
    if (r.code !== 0 || !fs.existsSync(from)) from = null;
  }
  const kp = { ...p, ...k.params, prompt: p.prompts?.[i] || p.prompt, prompts: null, seed: p.seed + i, count: 1, task: 'create', image: null, mask: null, strength: from ? 0.65 : null, flowShift: null };
  const args = buildArgs({ ...job, params: kp }, { ...k, kind: 'image', preview: null }, outBase, null, null, null, 0, from);
  const { code, signal, spawnError } = await runSd(job, args, log, config.sdCli, quietParse);
  if (job.status !== 'running') return null;
  if (code !== 0 || !fs.existsSync(`${outBase}.png`)) {
    throw new Error(spawnError?.message || job.lastErrors?.at(-1) || `The keyframe could not be drawn (sd-cli exited with code ${code}${signal ? `, ${signal}` : ''})`);
  }
  const init = `${tmpBase}_s${i}_init.png`;
  const vf = `scale=${p.width}:${p.height}:force_original_aspect_ratio=increase,crop=${p.width}:${p.height}`;
  const r = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-i', `${outBase}.png`, '-vf', vf, '-frames:v', '1', init], 'ffmpeg.keyframe');
  if (job.status !== 'running') return null;
  if (r.code !== 0 || !fs.existsSync(init)) throw new Error('Could not prepare the keyframe: ' + r.err.trim().slice(-300));
  return init;
}

async function referenceImage(job, tmpBase) {
  const p = job.params;
  const out = `${tmpBase}_ref.png`;
  const vf = `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2:color=white,format=rgb24`;
  const r = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dirs.uploads, p.image), '-vf', vf, '-frames:v', '1', out], 'ffmpeg.reference');
  if (job.status !== 'running') return null;
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Could not prepare the reference photo: ' + r.err.trim().slice(-300));
  return out;
}

function newProgress(segment, segments, doneSegments = []) {
  return { stage: 'prepare', stages: { prepare: { startedAt: Date.now() } }, loading: null, segment, segments, doneSegments };
}

async function run(job) {
  const preset = job.spec;
  const segments = job.params.segments || 1;
  const tmpBase = path.join(dirs.output, `.${job.id}`);
  const outputs = [];
  const luts = [];
  job.startedAt = Date.now();
  job.progress = newProgress(1, segments);
  current = { job, proc: null, tel: null };
  const previewTimer = setInterval(() => watchPreview(job), 2000);
  const log = fs.createWriteStream(path.join(dirs.logs, job.id + '.log'));
  // A full or read-only disk must fail the job, not crash the worker with an unhandled error
  log.on('error', (e) => console.error(`[worker] log of ${job.id}: ${e.message}`));
  const cleanup = () => {
    for (let i = 0; i < segments; i++) {
      fs.rmSync(`${tmpBase}_s${i}.avi`, { force: true });
      fs.rmSync(`${tmpBase}_s${i}_last.png`, { force: true });
      fs.rmSync(`${tmpBase}_s${i}_key.png`, { force: true });
      fs.rmSync(`${tmpBase}_s${i}_init.png`, { force: true });
      fs.rmSync(`${tmpBase}_s${i}_from.png`, { force: true });
    }
    for (const f of job._saved || []) fs.rmSync(f, { force: true });
    delete job._saved;
    fs.rmSync(`${tmpBase}_ctrl`, { recursive: true, force: true });
    fs.rmSync(`${tmpBase}_ref.png`, { force: true });
    fs.rmSync(`${tmpBase}_audio.wav`, { force: true });
  };

  try {
    // Telemetry never breaks a job: a failure to start it is only logged
    current.tel = await startTelemetry(job).catch((e) => {
      console.error(`[telemetry] not started: ${e.message}`);
      return null;
    });
    if (!preset) throw new Error('Queued by an older version of the platform, submit it again');
    job.status = 'running';
    save(true);
    // Audio: one run of audio.cpp, no segments
    if (preset.kind === 'audio') {
      const wav = `${tmpBase}_audio.wav`;
      const args = buildAudioArgs(job, preset, wav);
      job.cmd = [config.audioCli, ...args].join(' ');
      const { code, signal, spawnError } = await runSd(job, args, log, config.audioCli, parseAudioLine);
      if (job.status === 'running' && code !== 0) {
        throw new Error(spawnError?.message || job.lastErrors?.at(-1) || `audio.cpp exited with code ${code}${signal ? ` (${signal})` : ''}`);
      }
      if (job.status === 'running' && !fs.existsSync(wav)) throw new Error('The engine did not save the audio');
      outputs.push(wav);
    }
    for (let i = 0; i < segments && job.status === 'running' && preset.kind !== 'audio'; i++) {
      let init = null;
      let key = null;
      if (job.params.shots && job.spec.keyframe) {
        // A new shot: its own keyframe (the user's photo, if any, starts the first one)
        if (i > 0) {
          const prev = job.progress;
          job.progress = newProgress(i + 1, segments, [...prev.doneSegments, { startedAt: prev.stages.prepare.startedAt, endedAt: Date.now() }]);
          current.tel?.phase('prepare', { segment: i + 1 });
        }
        key = i === 0 && job.params.image ? null : await keyframe(job, i, tmpBase, log, outputs[i - 1] || null);
        if (job.status !== 'running') break;
        current.tel?.phase('prepare', { segment: i + 1 });
      } else if (i > 0) {
        // Continuation: the last frame of the previous segment becomes the init image of the next one
        init = `${tmpBase}_s${i - 1}_last.png`;
        const r = await runCmd('ffmpeg', ['-loglevel', 'error', '-y', '-sseof', '-0.5', '-i', outputs[i - 1],
          ...(luts[i - 1] ? ['-vf', luts[i - 1]] : []), '-update', '1', '-q:v', '1', init], 'ffmpeg.last_frame');
        if (job.status !== 'running') break;
        if (r.code !== 0 || !fs.existsSync(init)) throw new Error('Could not extract the last frame of the segment: ' + r.err.trim());
        const prev = job.progress;
        job.progress = newProgress(i + 1, segments,
          [...prev.doneSegments, { startedAt: prev.stages.prepare.startedAt, endedAt: Date.now() }]);
        current.tel?.phase('prepare', { segment: i + 1 });
      }
      const outBase = `${tmpBase}_s${i}`;
      const controlDir = job.params.video && i === 0 ? await controlFrames(job, tmpBase) : null;
      const refImage = job.params.image && ['reference', 'restyle'].includes(job.params.task) && i === 0 ? await referenceImage(job, tmpBase) : null;
      if (job.status !== 'running') break;
      // Loading the models after the helper commands is preparation again, not ffmpeg
      if (controlDir || refImage) current.tel?.phase('prepare', { segment: i + 1 });
      const args = buildArgs(job, preset, outBase, init, controlDir, refImage, i, key);
      if (i === 0) job.cmd = [config.sdCli, ...args].join(' ');
      const { code, signal, spawnError } = await runSd(job, args, log);
      if (job.status !== 'running') break;
      if (code !== 0) {
        throw new Error(spawnError?.message || job.lastErrors?.at(-1)
          || `sd-cli exited with code ${code}${signal ? ` (${signal})` : ''}`);
      }
      if (preset.kind !== 'image') {
        if (!fs.existsSync(`${outBase}.avi`)) throw new Error('sd-cli did not save the video');
        outputs.push(`${outBase}.avi`);
        if (init) luts[i] = colorMatchFilter(await frameStats(init), await frameStats(`${outBase}.avi`));
      } else if (!job._saved?.length && fs.existsSync(`${outBase}.png`)) {
        // The upscale mode saves its result without the "save result image" line
        job._saved = [`${outBase}.png`];
      }
    }
    if (job.status !== 'running') {
      cleanup();
    } else {
      setStage(job, 'saving');
      if (preset.kind === 'image') await finalizeImages(job);
      else if (preset.kind === 'audio') await finalizeAudio(job, outputs[0]);
      else await finalizeVideo(job, outputs, luts, !!job.params.shots);
      cleanup();
      if (job.status === 'running' && jobs.includes(job)) {
        finish(job, 'done');
      } else {
        // Cancelled or deleted while the result was being assembled: nothing may be left behind
        for (const f of job.files || []) fs.rmSync(path.join(dirs.output, f), { force: true });
        if (job.thumb) fs.rmSync(path.join(dirs.thumbs, job.thumb), { force: true });
        delete job.files;
        delete job.thumb;
      }
    }
  } catch (e) {
    cleanup();
    if (job.status === 'running') finish(job, 'failed', e.message);
  } finally {
    // Whatever happened above (even a full disk), the queue must move on
    log.end();
    if (job.finishedAt && job.startedAt) job.durationSec = Math.round((job.finishedAt - job.startedAt) / 1000);
    clearInterval(previewTimer);
    delete job.previewAt;
    delete job.previewExt;
    await current.tel?.finish().catch((e) => console.error(`[telemetry] ${e.message}`));
    current = null;
    try {
      save(true);
    } catch (e) {
      console.error(`[worker] could not save jobs.json: ${e.message}`);
    }
    nextJob();
  }
}

// ---------- drain: finish the current job, start nothing new (engine updates) ----------
// A drain is a lease: scripts/update.sh keeps renewing it while it waits, so if the script dies
// the worker resumes the queue by itself when the lease runs out.
let drainUntil = 0;
export const draining = () => Date.now() < drainUntil;

export function setDrain(seconds) {
  drainUntil = seconds > 0 ? Date.now() + Math.min(seconds, 3600) * 1000 : 0;
  if (!draining()) nextJob();
}
setInterval(() => nextJob(), 5000).unref();

// A restarted job keeps its createdAt (history, file names) but joins the end of the queue
const queuedAt = (j) => j.queuedAt ?? j.createdAt;

export function nextJob() {
  if (current || draining()) return;
  const job = jobs.filter((j) => j.status === 'queued').sort((a, b) => queuedAt(a) - queuedAt(b))[0];
  if (job) run(job);
}

// ---------- create, cancel, delete ----------

// Uploaded files a job refers to: plain names inside the uploads directory, nothing else
const UPLOAD_FIELDS = ['image', 'mask', 'video', 'audio'];
const UPLOAD_NAME = /^[\w.-]+\.(png|jpg|webp|mp4|mov|webm|mp3|wav|ogg|flac|m4a)$/;
export function validUploads(params) {
  return UPLOAD_FIELDS.every((k) => params?.[k] == null || (UPLOAD_NAME.test(params[k]) && !params[k].startsWith('.')));
}

export function enqueueJob({ user, params, spec }) {
  if (!validUploads(params)) throw Object.assign(new Error('Invalid file name'), { status: 400 });
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    status: 'queued',
    createdAt: Date.now(),
    user,
    params,
    spec,
  };
  jobs.push(job);
  save(true);
  nextJob();
  return job;
}

// Puts a failed or cancelled job back into the queue with the same parameters and seed.
// The web container passes a fresh spec, so jobs from older versions can be restarted too.
export function retryJob(job, spec) {
  if (!['failed', 'cancelled'].includes(job.status)) throw new Error('Only failed or cancelled jobs can be restarted');
  // A cancelled job may still be stopping (sd-cli exiting, ffmpeg running): wait for it
  if (current?.job === job) throw new Error('The job is still stopping, try again in a few seconds');
  for (const ext of ['.webp', '.png']) fs.rmSync(path.join(dirs.previews, job.id + ext), { force: true });
  for (const k of ['error', 'warning', 'lastErrors', 'progress', 'startedAt', 'finishedAt', 'durationSec', 'cmd', 'files', 'thumb', '_saved']) {
    delete job[k];
  }
  Object.assign(job, { status: 'queued', queuedAt: Date.now(), retries: (job.retries || 0) + 1, spec });
  save(true);
  nextJob();
  return job;
}

export function cancelJob(job) {
  if (job.status === 'queued') {
    finish(job, 'cancelled');
  } else if (current?.job === job) {
    if (job.status === 'running') finish(job, 'cancelled');
    // Between segments sd-cli is not running: the loop sees the status and stops by itself.
    // A repeated cancel still stops a process that is running for this job.
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
  // A file another job also points to (older versions could give two jobs one name) is kept
  for (const f of job.files || []) if (!jobs.some((j) => j.files?.includes(f))) rm(path.join(dirs.output, f));
  rm(path.join(dirs.thumbs, job.id + '.jpg'));
  for (const ext of ['.webp', '.png']) rm(path.join(dirs.previews, job.id + ext));
  rm(path.join(dirs.logs, job.id + '.log'));
  for (const k of UPLOAD_FIELDS) {
    const f = job.params?.[k];
    if (f && !jobs.some((j) => UPLOAD_FIELDS.some((x) => j.params?.[x] === f))) rm(path.join(dirs.uploads, path.basename(f)));
  }
  save(true);
}

export function jobSummary(j) {
  const { cmd, spec, ...out } = j;
  return out;
}

// The latent preview's timestamp is polled in the background, not on every state request
async function watchPreview(job) {
  for (const ext of ['.webp', '.png']) {
    try {
      const st = await fs.promises.stat(path.join(dirs.previews, job.id + ext));
      job.previewAt = st.mtimeMs;
      job.previewExt = ext;
      return;
    } catch {}
  }
}

// Models used by the current generation cannot be deleted
export function modelsInUse() {
  return [...new Set((runningJob()?.spec?.models || []).map((m) => m.id))];
}

export function shutdownJobs() {
  if (current) {
    finish(current.job, 'failed', 'The container was stopped during generation');
    current.proc?.kill('SIGTERM');
  }
  save(true);
}
