// Shared secret for the web ↔ worker API. Both containers see /data/state, so whichever starts first
// creates the token; nothing else on the compose network can call the worker without it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { statePath } from './store.js';

const FILE = statePath('worker.token');
let cached = null;

export function workerToken() {
  if (cached) return cached;
  try {
    fs.writeFileSync(FILE, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  cached = fs.readFileSync(FILE, 'utf8').trim();
  return cached;
}

export function tokenMatches(header) {
  const want = Buffer.from(`Bearer ${workerToken()}`);
  const got = Buffer.from(String(header || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
