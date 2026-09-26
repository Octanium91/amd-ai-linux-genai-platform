// Queue regression test: runs the worker from server/src against a fake sd-cli (tests/worker/fake-sd-cli)
// inside a throwaway container of the worker image. Start it with tests/worker/run.sh.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DATA = '/data/t';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let worker;
const startWorker = () => {
  worker = spawn('node', ['/src/worker/index.js'], { env: { ...process.env, DATA_DIR: DATA, WORKER_PORT: '7999', SD_CLI: '/fake/sd-cli', PATH: `/fake/bin:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('  | ' + d));
  worker.stderr.on('data', (d) => process.stdout.write('  ! ' + d));
};
const token = () => fs.readFileSync(`${DATA}/state/worker.token`, 'utf8').trim();
const api = async (p, method = 'GET', body) => {
  const r = await fetch('http://127.0.0.1:7999' + p, {
    method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const job = async (id) => (await api(`/v1/jobs/${id}`)).body;
const waitFor = async (id, pred, ms = 60000) => {
  const t0 = Date.now();
  for (;;) {
    const j = await job(id);
    if (pred(j)) return j;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${id}: ${JSON.stringify(j.status)} ${j.progress?.stage}`);
    await sleep(100);
  }
};
const spec = { kind: 'video', models: [], imageArgs: [], continueArgs: ['--strength', '0.55'], extraArgs: [], promptSuffix: '' };
const video = (segments = 2) => ({ user: 'test', spec, params: { kind: 'video', presetId: 't', prompt: 'test', negative: '', width: 64, height: 64, steps: 6, cfg: 1, sampler: 'euler', seed: 1, frames: 9, fps: 8, outFps: 8, segments, duration: 2 } });
const sdRuns = (id) => (fs.readFileSync(`${DATA}/state/logs/${id}.log`, 'utf8').match(/^\$ /gm) || []).length;
const outputFiles = () => fs.readdirSync(`${DATA}/output`);
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(`${DATA}/output`, { recursive: true });
// Leftovers of an interrupted job and a damaged jobs.json from a "previous run"
fs.writeFileSync(`${DATA}/output/.aaaaaaaaaaaa_s0.avi`, 'x');
fs.writeFileSync(`${DATA}/output/.aaaaaaaaaaaa_s0_last.png`, 'x');
fs.mkdirSync(`${DATA}/state`, { recursive: true });
fs.writeFileSync(`${DATA}/state/jobs.json`, '[{"id": "broken"');

startWorker();
await sleep(1500);
check('startup removes temporary segment files of interrupted jobs', !outputFiles().some((f) => f.startsWith('.aaaaaaaaaaaa')));
check('damaged jobs.json is kept aside', fs.readdirSync(`${DATA}/state`).some((f) => f.startsWith('jobs.json.corrupt-')));

// 1. A normal two-segment video finishes and is assembled
let a = (await api('/v1/jobs', 'POST', video(2))).body;
a = await waitFor(a.id, (j) => ['done', 'failed'].includes(j.status));
check('two-segment video finishes', a.status === 'done' && a.files?.[0]?.endsWith('.mp4'), `${a.status} ${a.files} ${a.error || ''}`);
check('result names carry the job id', a.files[0].includes(`_${a.id.slice(0, 6)}.`), a.files[0]);
// The clip lasts exactly its frames: 2 segments x 9 frames at 8 fps, minus the repeated seam frame
const { execFileSync } = await import('node:child_process');
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${DATA}/output/${a.files[0]}`]).toString().trim());
check('the clip has the exact duration', Math.abs(dur - 17 / 8) < 0.05, `${dur} s, expected ${17 / 8} s`);
// The same with interpolation to 24 fps (a 1-segment clip of 9 frames at 8 fps = 1.125 s)
process.env.FAKE_STEPS = '2';
let ic = (await api('/v1/jobs', 'POST', { ...video(1), params: { ...video(1).params, outFps: 24 } })).body;
ic = await waitFor(ic.id, (j) => ['done', 'failed'].includes(j.status));
const idur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${DATA}/output/${ic.files[0]}`]).toString().trim());
check('the interpolated clip has the exact duration', Math.abs(idur - 9 / 8) < 0.05, `${idur} s, expected ${9 / 8} s`);
process.env.FAKE_STEPS = '6';

// 2. Cancel while the last frame of segment 1 is being extracted: segment 2 must not start
fs.rmSync(`${DATA}/extracting`, { force: true });
let b = (await api('/v1/jobs', 'POST', video(2))).body;
for (let t0 = Date.now(); !fs.existsSync(`${DATA}/extracting`) && Date.now() - t0 < 30000; ) await sleep(50);
await api(`/v1/jobs/${b.id}/cancel`, 'POST');
// 3. Retry while it is still stopping is refused
const early = await api(`/v1/jobs/${b.id}/retry`, 'POST', { spec });
b = await waitFor(b.id, () => true);
await sleep(3000);
b = await job(b.id);
check('cancel at the segment boundary stops the job', b.status === 'cancelled' && sdRuns(b.id) === 1, `status ${b.status}, sd-cli runs ${sdRuns(b.id)}`);
check('retry while the job is stopping is refused or waits', early.status === 409 || early.status === 200, `HTTP ${early.status} ${early.body.error || early.body.status}`);

// 4. Retry after it has stopped runs it again with the same seed and finishes
let r;
for (let t0 = Date.now(); Date.now() - t0 < 15000; await sleep(500)) {
  r = await api(`/v1/jobs/${b.id}/retry`, 'POST', { spec });
  if (r.status !== 409) break;
}
b = await waitFor(b.id, (j) => ['done', 'failed'].includes(j.status));
check('retry after stopping finishes', r.status === 200 && b.status === 'done' && b.retries >= 1, `${b.status} retries ${b.retries} ${b.error || ''}`);

// 5. Delete during finalization leaves no files behind
process.env.FAKE_STEPS = '2';
let c = (await api('/v1/jobs', 'POST', { ...video(1), params: { ...video(1).params, frames: 200, outFps: 24 } })).body;
await waitFor(c.id, (j) => j.progress?.stage === 'saving', 60000);
const before = new Set(outputFiles());
await api(`/v1/jobs/${c.id}`, 'DELETE');
await sleep(8000);
const leftover = outputFiles().filter((f) => !before.has(f) || f.includes(c.id));
const idle = (await api('/v1/health')).body;
check('delete during finalization leaves no files', !outputFiles().some((f) => f.includes(c.id)) && !fs.existsSync(`${DATA}/state/thumbs/${c.id}.jpg`), `new files: ${JSON.stringify(leftover)}`);
check('the queue is free afterwards', idle.busy === false, JSON.stringify(idle));

// 6. The progress file is valid JSON after all of this
let parsed = false;
try {
  parsed = Array.isArray(JSON.parse(fs.readFileSync(`${DATA}/state/jobs.json`, 'utf8')));
} catch {}
check('jobs.json is valid JSON', parsed);

// 7. Telemetry: enabled in settings.json, one document per job, the size limit is kept
process.env.FAKE_STEPS = '6';
fs.mkdirSync(`${DATA}/telemetry`, { recursive: true });
fs.writeFileSync(`${DATA}/telemetry/19990101-000000_old.json`, JSON.stringify({ filler: 'x'.repeat(2 * 1024 * 1024) }));
fs.utimesSync(`${DATA}/telemetry/19990101-000000_old.json`, new Date(2000, 0, 1), new Date(2000, 0, 1));
fs.writeFileSync(`${DATA}/state/settings.json`, JSON.stringify({ telemetry: { enabled: true, maxMb: 1 } }));
let tj = (await api('/v1/jobs', 'POST', video(2))).body;
tj = await waitFor(tj.id, (j) => ['done', 'failed'].includes(j.status));
// The document is written right after the job is marked done: wait for it
const telDoc = async (id) => {
  for (let t0 = Date.now(); Date.now() - t0 < 15000; await sleep(200)) {
    const f = fs.readdirSync(`${DATA}/telemetry`).find((x) => x.includes(id));
    if (f) {
      try {
        const d = JSON.parse(fs.readFileSync(`${DATA}/telemetry/${f}`, 'utf8'));
        if (d.complete) return f;
      } catch {}
    }
  }
  return null;
};
await telDoc(tj.id);
const telFiles = fs.readdirSync(`${DATA}/telemetry`);
const docFile = telFiles.find((f) => f.includes(tj.id));
let doc = null;
try {
  doc = JSON.parse(fs.readFileSync(`${DATA}/telemetry/${docFile}`, 'utf8'));
} catch {}
const phaseNames = doc?.phases?.map((p) => `${p.name}#${p.segment}`) || [];
check('telemetry document is written for the job', doc?.schema === 'genai-platform.telemetry/2' && doc.complete === true && doc.job.status === 'done', docFile || 'none');
check('telemetry has phases per stage and command', ['sampling#1', 'sampling#2', 'ffmpeg.last_frame#1', 'ffmpeg.encode#2'].every((n) => phaseNames.includes(n)), phaseNames.join(' '));
check('telemetry has metrics, series, steps and commands',
  Object.keys(doc?.phases?.find((p) => p.name === 'sampling')?.metrics || {}).length > 0 && doc.series.points.length > 0
  && doc.steps.rows.length >= 12 && doc.commands.filter((c) => c.program === 'sd-cli').length === 2,
  `metrics ${Object.keys(doc?.phases?.[0]?.metrics || {}).length}, points ${doc?.series?.points?.length}, steps ${doc?.steps?.rows?.length}, commands ${doc?.commands?.length}`);
check('telemetry resource describes the host and runtime',
  doc?.resource?.['process.runtime.name'] === 'node' && !!doc.resource['os.kernel.release'] && !!doc.resource['host.cpu']?.['model.name'] && doc.resource['deployment.mode'] === 'docker',
  `${doc?.resource?.['os.description']} · ${doc?.resource?.['host.cpu']?.['model.name']} · ${doc?.resource?.['deployment.mode']}`);
check('telemetry size limit removes the oldest documents', !telFiles.includes('19990101-000000_old.json'), telFiles.join(' '));
console.log(`  telemetry document: ${fs.statSync(`${DATA}/telemetry/${docFile}`).size} bytes, sample metrics: ${Object.keys(doc?.phases?.find((p) => p.name === 'sampling')?.metrics || {}).join(', ')}`);
const sm = doc?.summary || {};
check('telemetry summary', sm.steps === 12 && sm.secondsPerStep > 0 && sm.samplingSec > 0 && sm.durationSec > 0 && 'stepSlowdown' in sm && 'energyWh' in sm,
  `steps ${sm.steps}, s/step ${sm.secondsPerStep}, sampling ${sm.samplingSec}s, first step ${sm.firstStepSec}s, energy ${sm.energyWh} Wh, slowdown ${sm.stepSlowdown}`);
check('the worker event loop delay is not the histogram floor', (doc?.phases || []).every((p) => !p.metrics['process.worker.event_loop.delay.max'] || p.metrics['process.worker.event_loop.delay.max'].avg < 0.02));

// 8. A batch of two images: one sampling phase per image, one decoding, steps know the image
const imgSpec = { ...spec, kind: 'image' };
let ib = (await api('/v1/jobs', 'POST', { user: 'test', spec: imgSpec, params: { kind: 'image', presetId: 't', prompt: 'batch', negative: '', width: 64, height: 64, steps: 6, cfg: 1, sampler: 'euler', seed: 3, count: 2 } })).body;
ib = await waitFor(ib.id, (j) => ['done', 'failed'].includes(j.status));
await telDoc(ib.id);
const idoc = JSON.parse(fs.readFileSync(`${DATA}/telemetry/${fs.readdirSync(`${DATA}/telemetry`).find((f) => f.includes(ib.id))}`, 'utf8'));
const iph = idoc.phases.map((p) => `${p.name}${p.image ? '#' + p.image : ''}`);
const images = new Set(idoc.steps.rows.map((r) => r[1]));
check('image batch: a sampling phase per image, one decoding, no empty phases',
  ib.status === 'done' && ib.files?.length === 2 && iph.filter((n) => n.startsWith('sampling')).join() === 'sampling#1,sampling#2'
  && iph.filter((n) => n.startsWith('decoding')).length === 1 && idoc.phases.every((p) => p.durationSec > 0 || Object.keys(p.metrics).length),
  `${ib.status} files ${ib.files?.length}; ${iph.join(' ')}`);
check('image batch: steps carry the image index', images.has(1) && images.has(2) && idoc.steps.rows.length === 12 && idoc.summary.secondsPerImage > 0,
  `images ${[...images]}, rows ${idoc.steps.rows.length}, s/image ${idoc.summary.secondsPerImage}`);

worker.kill();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
