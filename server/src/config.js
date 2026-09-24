import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Всё состояние платформы живёт в одном томе /data (на хосте — DATA_DIR из .env)
const DATA = process.env.DATA_DIR || '/data';

export const config = {
  port: Number(process.env.PORT) || 7860,
  sdCli: process.env.SD_CLI || 'sd-cli',
  hfToken: process.env.HF_TOKEN || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  sessionDays: Number(process.env.SESSION_DAYS) || 30,
  catalogDir: process.env.CATALOG_DIR || path.resolve(here, '../../catalog'),
  publicDir: path.resolve(here, '../public'),
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
  },
};

for (const d of Object.values(config.dirs)) fs.mkdirSync(d, { recursive: true });
