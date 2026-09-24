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
  } catch {
    throw new WorkerUnavailable();
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

export async function workerState() {
  try {
    const s = await callWorker('/v1/state', { timeout: 3000 });
    last = s;
    online = true;
  } catch {
    online = false;
  }
  return {
    ...last,
    worker: { online, api: last.api ?? null, compatible: !online || last.api === WORKER_API, draining: online && !!last.draining },
  };
}

