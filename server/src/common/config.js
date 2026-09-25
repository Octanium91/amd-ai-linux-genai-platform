import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// All platform state lives under /data (host paths come from DATA_PATH / MODELS_PATH / OUTPUT_PATH in .env)
const DATA = process.env.DATA_DIR || '/data';

export const config = {
  port: Number(process.env.PORT) || 7860,
  // The worker API is internal: reachable only on the compose network, never published
  workerPort: Number(process.env.WORKER_PORT) || 7861,
  workerUrl: process.env.WORKER_URL || 'http://127.0.0.1:7861',
  sdCli: process.env.SD_CLI || 'sd-cli',
  hfToken: process.env.HF_TOKEN || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  sessionDays: Number(process.env.SESSION_DAYS) || 30,
  catalogDir: process.env.CATALOG_DIR || path.resolve(here, '../../../catalog'),
  publicDir: path.resolve(here, '../../public'),
  dirs: {
    data: DATA,
    models: path.join(DATA, 'models'),
    output: path.join(DATA, 'output'),
    input: path.join(DATA, 'input'),
    uploads: path.join(DATA, 'input', 'uploads'),
    state: path.join(DATA, 'state'),
    logs: path.join(DATA, 'state', 'logs'),
    previews: path.join(DATA, 'state', 'previews'),
    thumbs: path.join(DATA, 'state', 'thumbs'),
    cache: path.join(DATA, 'state', 'cache'),
    telemetry: path.join(DATA, 'telemetry'),
  },
};

// Version of the web ↔ worker API; both sides refuse to work with a different major version
export const WORKER_API = 1;

// Some directories are mounted read-only in one of the containers (output in web, models in worker)
for (const d of Object.values(config.dirs)) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {}
}
