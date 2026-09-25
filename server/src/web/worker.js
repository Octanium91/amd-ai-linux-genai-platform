// Client of the worker's internal API. The last good state is cached, so the UI keeps showing jobs
// and hardware info for the few seconds the worker is restarting.
import { config, WORKER_API } from '../common/config.js';
import { workerToken } from '../common/token.js';

export class WorkerUnavailable extends Error {
  constructor() {
    super('The generation engine is not available, try again in a minute');
    this.status = 503;
  }
}

export async function callWorker(path, { method = 'GET', body, timeout = 5000 } = {}) {
  let res;
  try {
    res = await fetch(config.workerUrl + path, {
      method,
      headers: { Authorization: `Bearer ${workerToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const err = new WorkerUnavailable();
    err.reason = e.name === 'TimeoutError' ? `no answer within ${timeout} ms` : e.cause?.code || e.message;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Worker HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let last = { jobs: [], system: null, health: null, inUse: [] };
let online = false;
let lastOkAt = 0;
let failingSince = 0;

// The worker counts as unavailable only after OFFLINE_AFTER without a single answer: under heavy
// jobs it can pause for a second or two (swap, a busy disk), which is not an outage. Transitions
// are logged with the reason so real outages leave a trace.
const OFFLINE_AFTER = 15000;

export async function workerState() {
  try {
    const s = await callWorker('/v1/state', { timeout: 5000 });
    last = s;
    lastOkAt = Date.now();
    const pause = failingSince ? Math.round((Date.now() - failingSince) / 1000) : 0;
    if (!online && failingSince) console.log(`[web] the worker answers again after ${pause} s`);
    else if (pause >= 3) console.log(`[web] the worker answered after a ${pause} s pause`);
    online = true;
    failingSince = 0;
  } catch (e) {
    if (!failingSince) failingSince = Date.now();
    if (online && Date.now() - lastOkAt > OFFLINE_AFTER) {
      online = false;
      console.warn(`[web] the worker has not answered for ${Math.round((Date.now() - lastOkAt) / 1000)} s: ${e.reason || e.message}`);
    }
  }
  return {
    ...last,
    worker: { online, api: last.api ?? null, compatible: !online || last.api === WORKER_API, draining: online && !!last.draining },
  };
}

