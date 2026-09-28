#!/usr/bin/env node
// Measures every installed mode on this machine: each size it offers, its quality levels and the
// parameters that change time or result (prompt strictness, length, frame rate), one parameter at a
// time, with the same prompt and seed per kind so the results can be compared side by side.
// Runs inside the web container (it uses the platform's own parameter and catalog code):
//   docker cp scripts/benchmark.mjs genai-web:/tmp/benchmark.mjs
//   docker exec genai-web node /tmp/benchmark.mjs plan              — list the jobs and the rough total
//   docker exec genai-web node /tmp/benchmark.mjs run [filter]      — queue them (filter: a mode id substring)
//   docker exec genai-web node /tmp/benchmark.mjs report <run id>   — timings from the jobs and their telemetry
// The run manifest and the report go to /data/state/benchmarks/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { jobParams, jobSpec } from '/app/server/src/web/params.js';
import { presetsWithAvailability } from '/app/server/src/web/presets.js';

const DATA = process.env.DATA_DIR || '/data';
const OUT = path.join(DATA, 'state', 'benchmarks');
const WORKER = process.env.WORKER_URL || 'http://worker:7861';
const token = () => fs.readFileSync(path.join(DATA, 'state', 'worker.token'), 'utf8').trim();
const SEED = 42;

// One prompt per kind, used for every measurement of that kind
const PROMPTS = {
  image: 'portrait photo of an old fisherman in a knitted sweater on a harbor pier, overcast light, detailed skin, 85mm',
  video: 'an old fisherman in a knitted sweater turns his head and smiles on a windy harbor pier, waves and boats behind him, overcast light, cinematic',
  music: 'warm acoustic folk, fingerpicked guitar, soft piano, light percussion, nostalgic, 90 BPM',
  sfx: 'waves crashing on a rocky shore with seagulls and wind',
  speech: 'The old fisherman looked at the sea and smiled. The wind was calm, and the boats were ready for the morning.',
};

// Modes whose passes take tens of minutes get a shorter list; frame interpolation is ffmpeg's work,
// the same for every mode, and is measured on the fast ones only
const SLOW = { 'vid-animatediff-v3': ['size', 'quality'], 'vid-wan21-1.3b': ['size', 'quality draft', '17 frames'], 'vid-wan22-5b': ['17 frames', '49 frames'] };
const FPS_ON = ['vid-animatelcm', 'vid-wan22-turbo'];

function plan(presets) {
  const jobs = [];
  const add = (p, label, body) => {
    const only = SLOW[p.id];
    if (only && !only.some((x) => label.startsWith(x))) return;
    if (/fps output/.test(label) && !FPS_ON.includes(p.id)) return;
    jobs.push({ presetId: p.id, kind: p.kind, label, body: { presetId: p.id, seed: SEED, quality: 'normal', ...body } });
  };
  for (const p of presets) {
    const d = p.defaults || {};
    const q = Object.keys(d.quality || { normal: 1 });
    if (p.kind === 'image' && p.tasks.includes('create')) {
      for (const [w, h] of p.resolutions || [[d.width, d.height]]) add(p, `size ${w}×${h}`, { task: 'create', prompt: PROMPTS.image, width: w, height: h });
      for (const k of q.filter((x) => x !== 'normal')) add(p, `quality ${k}`, { task: 'create', prompt: PROMPTS.image, width: d.width, height: d.height, quality: k });
      if ((d.cfg ?? 1) > 1) for (const c of [d.cfg / 2, d.cfg * 1.5]) add(p, `strictness ${c}`, { task: 'create', prompt: PROMPTS.image, width: d.width, height: d.height, cfg: c });
    }
    if (p.kind === 'image' && p.tasks.includes('upscale')) {
      for (const s of [256, 512]) add(p, `upscale ${s}×${s}`, { task: 'upscale', prompt: '', imageSize: s });
    }
    if (p.kind === 'video' && !p.tasks.some((t) => ['reference', 'restyle'].includes(t))) {
      const fps = d.nativeFps ?? 24;
      const seg = d.segmentFrames ?? 16;
      const i2v = p.tasks.includes('animate');
      const task = i2v ? 'animate' : 'create';
      const base = { task, prompt: PROMPTS.video, duration: seg / fps, useImage: i2v };
      for (const [w, h] of p.resolutions || [[d.width, d.height]]) add(p, `size ${w}×${h}`, { ...base, width: w, height: h });
      for (const k of q.filter((x) => x !== 'normal')) add(p, `quality ${k}`, { ...base, width: d.width, height: d.height, quality: k });
      if (i2v && p.tasks.includes('create')) add(p, 'text to video', { ...base, task: 'create', useImage: false, width: d.width, height: d.height });
      if ((d.cfg ?? 1) >= 1 && d.sampler === 'lcm') for (const c of [1.5, 2]) add(p, `strictness ${c}`, { ...base, width: d.width, height: d.height, cfg: c });
      // Frames per pass: shorter and longer than the default, within what the mode allows
      const exact = d.frameRule === 'exact';
      const lengths = exact ? [8, seg] : [17, 49, 81, 121].filter((f) => f !== seg && f <= (d.maxFrames ?? 121));
      // The full Wan 2.2 5B is measured in Draft only: a Standard pass takes over an hour
      const lq = p.id === 'vid-wan22-5b' ? 'draft' : 'normal';
      for (const f of lengths.filter((f) => f !== seg)) add(p, `${f} frames`, { ...base, width: d.width, height: d.height, duration: f / fps, segmentFrames: f, quality: lq });
      for (const o of (d.outFpsOptions || []).filter((o) => o !== (d.outFps ?? fps))) add(p, `${o} fps output`, { ...base, width: d.width, height: d.height, outFps: o });
    }
    if (p.kind === 'audio') {
      const task = p.tasks[0];
      if (task === 'music') for (const s of [10, 30, 60, 120]) add(p, `${s} s`, { task, prompt: PROMPTS.music, duration: s, lyricsMode: 'instrumental' });
      if (task === 'music') add(p, '30 s with vocals', { task, prompt: PROMPTS.music, duration: 30, lyricsMode: 'auto' });
      if (task === 'sfx') for (const s of [2, 8, 30]) add(p, `${s} s`, { task, prompt: PROMPTS.sfx, duration: s });
      if (task === 'speech') {
        add(p, `${PROMPTS.speech.length} characters, en`, { task, prompt: PROMPTS.speech, voice: 'M1', language: 'en' });
        add(p, `${PROMPTS.speech.length * 4} characters, en`, { task, prompt: Array(4).fill(PROMPTS.speech).join(' '), voice: 'M1', language: 'en' });
        add(p, 'Ukrainian', { task, prompt: 'Старий рибалка подивився на море й усміхнувся. Вітер був тихий, а човни готові до ранку.', voice: 'F2', language: 'uk' });
      }
    }
  }
  return jobs;
}

// A test photo for image-to-video and upscaling, one per size (photo-WxH.png in the benchmarks
// directory, made beforehand with the worker's ffmpeg from a picture of the image prompt)
function testImage(w, h) {
  const uploads = path.join(DATA, 'input', 'uploads');
  const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`;
  const src = path.join(OUT, `photo-${w}x${h}.png`);
  if (!fs.existsSync(src)) throw new Error(`Put a ${w}×${h} PNG at ${src} first (the worker's ffmpeg can make it)`);
  fs.copyFileSync(src, path.join(uploads, name));
  return name;
}

async function post(body) {
  const r = await fetch(`${WORKER}/v1/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j.id;
}

async function run(filter) {
  const presets = presetsWithAvailability().filter((p) => p.available);
  const jobs = plan(presets).filter((j) => !filter || j.presetId.includes(filter));
  fs.mkdirSync(OUT, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const queued = [];
  for (const j of jobs) {
    const p = presets.find((x) => x.id === j.presetId);
    const { useImage, imageSize, ...b } = j.body;
    let image = null;
    if (useImage) image = testImage(b.width, b.height);
    if (imageSize) image = testImage(imageSize, imageSize);
    if (b.task === 'upscale') Object.assign(b, { width: imageSize * 4, height: imageSize * 4 });
    const params = jobParams(p, b, image, { task: b.task, image });
    const jobId = await post({ user: 'benchmark', params, spec: jobSpec(p) });
    queued.push({ ...j, jobId });
    console.log(`${jobId}  ${p.id}  ${j.label}`);
  }
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify({ id, startedAt: Date.now(), prompts: PROMPTS, seed: SEED, jobs: queued }, null, 1));
  console.log(`\n${queued.length} jobs queued, run ${id}`);
}

async function report(id) {
  const run = JSON.parse(fs.readFileSync(path.join(OUT, `${id}.json`), 'utf8'));
  const r = await fetch(`${WORKER}/v1/state`, { headers: { Authorization: `Bearer ${token()}` } });
  const state = await r.json();
  const tel = fs.readdirSync(path.join(DATA, 'telemetry')).filter((f) => f.endsWith('.json'));
  const rows = run.jobs.map((q) => {
    const j = state.jobs.find((x) => x.id === q.jobId) || {};
    const tf = tel.find((f) => f.endsWith(`_${q.jobId}.json`));
    const s = tf ? JSON.parse(fs.readFileSync(path.join(DATA, 'telemetry', tf), 'utf8')).summary || {} : {};
    return {
      ...q, status: j.status, error: j.error || null, files: j.files || [], thumb: j.thumb || null,
      durationSec: j.durationSec ?? s.durationSec ?? null,
      samplingSec: s.samplingSec ?? null, decodingSec: s.decodingSec ?? null, secondsPerStep: s.secondsPerStep ?? null,
      gttGB: s['peak.hw.gpu.memory.gtt.usage'] ? Math.round(s['peak.hw.gpu.memory.gtt.usage'] / 1e8) / 10 : null,
      ramGB: s['peak.system.memory.usage'] ? Math.round(s['peak.system.memory.usage'] / 1e8) / 10 : null,
      gpuC: s['peak.hw.temperature.gpu'] ?? null, energyWh: s.energyWh ?? null,
      thermal: s.throttling?.thermal ? Math.round((s.throttling.thermalShare || 0) * 100) : 0,
      params: j.params ? { width: j.params.width, height: j.params.height, steps: j.params.steps, cfg: j.params.cfg, frames: j.params.frames, fps: j.params.fps, outFps: j.params.outFps, duration: j.params.duration, audioSec: j.audioSec } : null,
    };
  });
  fs.writeFileSync(path.join(OUT, `${id}.report.json`), JSON.stringify({ ...run, rows }, null, 1));
  const pending = rows.filter((x) => ['queued', 'running'].includes(x.status)).length;
  const fmt = (v, u = '') => (v == null ? '—' : `${v}${u}`);
  let last = '';
  for (const x of rows) {
    if (x.presetId !== last) console.log(`\n## ${(last = x.presetId)}`);
    console.log(`${x.label.padEnd(22)} ${String(x.status).padEnd(9)} ${fmt(x.durationSec, ' s').padStart(8)}  sampling ${fmt(x.samplingSec, ' s')}  decode ${fmt(x.decodingSec, ' s')}  s/step ${fmt(x.secondsPerStep)}  GTT ${fmt(x.gttGB, ' GB')}  GPU ${fmt(x.gpuC, ' °C')}  thermal ${x.thermal}%${x.error ? `  ${x.error}` : ''}`);
  }
  console.log(`\n${rows.length} jobs, ${pending} still queued or running`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'plan') {
  const jobs = plan(presetsWithAvailability().filter((p) => p.available));
  for (const j of jobs) console.log(`${j.presetId.padEnd(26)} ${j.label}`);
  console.log(`\n${jobs.length} jobs`);
} else if (cmd === 'run') await run(arg);
else if (cmd === 'report') await report(arg);
else console.log('usage: benchmark.mjs plan | run [mode filter] | report <run id>');
