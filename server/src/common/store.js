import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Small JSON state files in /data/state with atomic writes
export function statePath(name) {
  return path.join(config.dirs.state, name);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

// Debounced writes for frequently changing data (job progress). Important changes (now = true)
// are written synchronously; the frequent progress writes are asynchronous, so a slow disk under
// memory pressure does not stall the event loop. A progress write that finishes after a newer
// synchronous one is dropped instead of overwriting it.
export function debouncedWriter(file, getValue, delay = 2000) {
  let timer = null;
  let version = 0;
  const writeLater = async () => {
    const mine = ++version;
    const tmp = file + '.progress.tmp';
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(getValue(), null, 1));
      if (mine === version) fs.renameSync(tmp, file);
      else await fs.promises.rm(tmp, { force: true });
    } catch {}
  };
  return (now = false) => {
    if (now) {
      if (timer) clearTimeout(timer);
      timer = null;
      version++;
      writeJson(file, getValue());
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        writeLater();
      }, delay);
    }
  };
}
