// Generation worker: owns the GPU and the job queue, serves an internal API to the web container.
// It is updated rarely and only when idle (scripts/update.sh drains it first), so restarting the
// web container never interrupts a generation. No npm dependencies on purpose.
import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config, WORKER_API } from '../common/config.js';
import { tokenMatches, workerToken } from '../common/token.js';
import { diagnostics, logDiagnostics } from './diagnostics.js';
import {
  cancelJob, deleteJob, draining, enqueueJob, jobs, jobSummary, modelsInUse, nextJob, retryJob, runningJob, setDrain, shutdownJobs,
} from './queue.js';
import { systemInfo } from './system.js';

workerToken();

// Event loop watch: a stall (swapped-out pages under memory pressure, a slow syscall) is logged
// with its length, and the worst recent delay is reported by /v1/health for diagnostics
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
let worstLagMs = 0;
setInterval(() => {
  const lag = Math.round(loopDelay.max / 1e6);
  loopDelay.reset();
  worstLagMs = lag;
  if (lag > 1000) console.warn(`[worker] event loop stalled for ${lag} ms${runningJob() ? ' during a job' : ''}`);
}, 10000).unref();

// Short health summary for the header badge; the full list lives in /v1/diagnostics
let health = null;
const refreshHealth = () => diagnostics().then((d) => {
  health = { status: d.status, problems: d.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => ({ id: c.id, status: c.status })) };
}).catch(() => {});

const status = () => ({
  api: WORKER_API,
  busy: !!runningJob(),
  queued: jobs.filter((j) => j.status === 'queued').length,
  draining: draining(),
  lagMs: worstLagMs,
});

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) reject(new HttpError(413, 'Request too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const findJob = (id) => {
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new HttpError(404, 'Not found');
  return job;
};

const routes = [
  ['GET', /^\/v1\/state$/, () => {
    refreshHealth();
    return { ...status(), jobs: jobs.map(jobSummary), system: systemInfo(), health, inUse: modelsInUse(), now: Date.now() };
  }],
  ['GET', /^\/v1\/diagnostics$/, async (req, url) => {
    const d = await diagnostics(url.searchParams.get('refresh') === '1');
    refreshHealth();
    return d;
  }],
  ['POST', /^\/v1\/jobs$/, async (req) => {
    const b = await readBody(req);
    if (!b.user || !b.params || !b.spec?.models) throw new HttpError(400, 'Invalid job');
    return jobSummary(enqueueJob(b));
  }],
  ['GET', /^\/v1\/jobs\/([\w-]+)$/, (req, url, id) => jobSummary(findJob(id))],
  ['POST', /^\/v1\/jobs\/([\w-]+)\/cancel$/, (req, url, id) => {
    const job = findJob(id);
    cancelJob(job);
    return jobSummary(job);
  }],
  ['POST', /^\/v1\/jobs\/([\w-]+)\/retry$/, async (req, url, id) => {
    const b = await readBody(req);
    if (!b.spec?.models) throw new HttpError(400, 'Invalid job');
    try {
      return jobSummary(retryJob(findJob(id), b.spec));
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(409, e.message);
    }
  }],
  ['DELETE', /^\/v1\/jobs\/([\w-]+)$/, (req, url, id) => {
    deleteJob(findJob(id));
    return { ok: true };
  }],
  // Drain lease in seconds, 0 releases it
  ['POST', /^\/v1\/drain$/, async (req) => {
    const b = await readBody(req);
    setDrain(Number(b.seconds) || 0);
    return status();
  }],
];

const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, 'http://worker');
  // The health probe is the only route without the token (docker healthcheck, update.sh)
  if (req.method === 'GET' && url.pathname === '/v1/health') return send(200, status());
  if (!tokenMatches(req.headers.authorization)) return send(401, { error: 'Unauthorized' });
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m || req.method !== method) continue;
    try {
      return send(200, await handler(req, url, ...m.slice(1)));
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      return send(e.code || 500, { error: e.message || 'Internal error' });
    }
  }
  send(404, { error: 'Not found' });
});

server.listen(config.workerPort, () => {
  console.log(`[worker] API v${WORKER_API} on port ${config.workerPort}`);
  nextJob();
  logDiagnostics().then(refreshHealth).catch((e) => console.error('[diagnostics]', e.message));
});

function shutdown() {
  shutdownJobs();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
